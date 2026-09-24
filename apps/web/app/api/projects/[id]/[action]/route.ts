import { z } from 'zod';
import { withTenant } from '@arkiv/db';
import { cancelProduction, decideFact, finishAfterEdit, reopenForEdit, requestConcepts, retryAnalysis, retryProduction, selectConcept, selectVariant } from '@arkiv/core';
import { startProductionCheckout } from '@arkiv/billing';
import { DomainError } from '@arkiv/shared';
import { body, json, route } from '@/lib/http';
import { projectAccess } from '@/lib/tenant';

/**
 * Funnel actions on a project:
 *   concepts  – "Try 3 more" (limited for provisional workspaces). Queued: 202 + the batch to poll for
 *   select    – choose a concept → storyboard (requires an account: the save gate, plan 03 P6)
 *   checkout  – one-time Taste/Standalone checkout at the live server quote (P8)
 *   retry     – retry a failed production (entitlement was returned on failure)
 *   reopen    – back to the storyboard to fix a line the claims check blocked (purchase kept)
 *   finish    – produce again after that fix, with the same entitlement (no new checkout)
 *   cancel    – cancel the production; what happens to the credit or payment follows the dispatch/spend state
 *   retry-analysis – read the product again after a failed analysis (plan 03 P3)
 *   variant   – which size/shade this ad is for (§42), before an idea is chosen
 */
export const POST = route(async (req, { params }: { params: Promise<{ id: string; action: string }> }) => {
  const { id, action } = await params;
  const a = await projectAccess(id);
  switch (action) {
    case 'concepts': {
      // Drafting runs in the worker (§34); the funnel polls GET /api/projects/:id until the batch appears.
      const r = await withTenant(a.ctx.workspaceId, (tx) => requestConcepts(tx, a.ctx, id));
      return json({ ok: true, queued: true, ...r }, 202);
    }
    case 'select': {
      if (a.provisional) throw new DomainError('FORBIDDEN', 'Save your work to see the storyboard.', { needsAccount: true });
      const { conceptId } = await body(req, z.object({ conceptId: z.string().uuid() }));
      const r = await withTenant(a.ctx.workspaceId, (tx) => selectConcept(tx, a.ctx, id, conceptId));
      return json(r);
    }
    case 'checkout': {
      if (!a.user || a.provisional) throw new DomainError('FORBIDDEN', 'Please sign in to continue.', { needsAccount: true });
      const r = await withTenant(a.ctx.workspaceId, (tx) => startProductionCheckout(tx, a.ctx, id, { id: a.user!.id, email: a.user!.email }));
      return json(r);
    }
    case 'fact': {
      // Confirmation screen (P4): the merchant's correction becomes a DECIDED fact and wins over page/photo values.
      const f = await body(req, z.object({ key: z.enum(['name', 'brand', 'size', 'price', 'category', 'texture', 'packaging', 'ingredients']), value: z.string().trim().min(1).max(400) }));
      const [p] = await withTenant(a.ctx.workspaceId, (tx) => tx`select sku_id from projects where id = ${id}`);
      const num = f.key === 'price' ? Number(f.value.replace(/[^0-9.]/g, '')) : null;
      if (f.key === 'price' && !(num! > 0)) throw new DomainError('INVALID', 'Enter a price like 38.00');
      await withTenant(a.ctx.workspaceId, (tx) => decideFact(tx, a.ctx, p!.sku_id as string, f.key, f.key === 'price' ? { number: num } : { text: f.value }));
      return json({ ok: true });
    }
    case 'retry':
      await withTenant(a.ctx.workspaceId, (tx) => retryProduction(tx, a.ctx, id));
      return json({ ok: true });
    case 'reopen': {
      const r = await withTenant(a.ctx.workspaceId, (tx) => reopenForEdit(tx, a.ctx, id));
      return json({ ok: true, next: `/storyboard/${id}`, lines: r.lines });
    }
    case 'cancel': {
      if (a.provisional) throw new DomainError('FORBIDDEN', 'Please sign in to continue.', { needsAccount: true });
      const { reason } = await body(req, z.object({ reason: z.string().trim().max(300).optional() }));
      const r = await withTenant(a.ctx.workspaceId, (tx) => cancelProduction(tx, a.ctx, id, { reason }));
      return json({ ok: true, status: r.status, message: r.decision.message });
    }
    case 'finish': {
      await withTenant(a.ctx.workspaceId, (tx) => finishAfterEdit(tx, a.ctx, id));
      return json({ ok: true, next: `/produce/${id}` });
    }
    case 'variant': {
      const { variantId } = await body(req, z.object({ variantId: z.string().uuid().nullable() }));
      const v = await withTenant(a.ctx.workspaceId, (tx) => selectVariant(tx, a.ctx, id, variantId));
      return json({ ok: true, variant: v });
    }
    case 'retry-analysis': {
      const r = await withTenant(a.ctx.workspaceId, (tx) => retryAnalysis(tx, a.ctx, id));
      return json({ ok: true, queued: true, ...r }, 202);
    }
    default:
      throw new DomainError('NOT_FOUND', 'Unknown action');
  }
});
