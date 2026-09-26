import { z } from 'zod';
import { withTenant } from '@arkiv/db';
import { acceptSourceFact, addProductPhotos, chooseProduct, resolveDuplicate, produceFreeRevision, reportNotRight, selectHeroProduct, cancelProduction, confirmFacts, MAX_ADDED_PHOTOS, decideFact, finishAfterEdit, recordAssetWatched, reopenForEdit, requestConcepts, requestRecompose, requestTextEdit, produceWithCreativeTest, retryAnalysis, retryProduction, retryStoryboard, selectConcept, selectVariant } from '@arkiv/core';
import { closeOpenCheckouts, startProductionCheckout } from '@arkiv/billing';
import { CreativeGoal, DomainError } from '@arkiv/shared';
import { body, json, route } from '@/lib/http';
import { projectAccess } from '@/lib/tenant';

/**
 * Funnel actions on a project:
 *   concepts  – "Try 3 more" (limited for provisional workspaces), optionally for a new §8 goal. Queued: 202 + the batch to poll for
 *   select    – choose a concept → storyboard (requires an account: the save gate, plan 03 P6)
 *   checkout  – one-time Taste/Standalone checkout at the live server quote (P8)
 *   produce-with-test – a subscriber makes this storyboard with one of their plan's Creative Tests (§5), no checkout
 *   retry     – retry a failed production (entitlement was returned on failure)
 *   reopen    – back to the storyboard to fix a line the claims check blocked (purchase kept)
 *   finish    – produce again after that fix, with the same entitlement (no new checkout)
 *   cancel    – cancel the production; what happens to the credit or payment follows the dispatch/spend state
 *   recompose – "Update my ad" after the product's price or size changed: new on-screen text, same footage (§42)
 *   edit-text – change a delivered ad's spoken lines, on-screen text or CTA: recomposed from the same footage, no
 *               entitlement used (§25 "Text/CTA/price/caption-only edit"). Queued: 202
 *   select-product – mark the hero product in a photo that shows several (plan 03 P2); the analysis resumes
 *   choose-product – "Which product?" on a collection/home page link (plan 03 P2): one of the listed products
 *   duplicate – "This looks like No. 003": merge into that product, or keep this as a new one (§42)
 *   storyboard-retry – draw the chosen idea's storyboard again after we failed to (P7 edge, §14)
 *   retry-analysis – read the product again after a failed analysis (plan 03 P3)
 *   photos    – add photos to this product (multipart `photos`): resumes an analysis waiting for them (the URL
 *               failed, §13), or adds side/back reference views to an analysed one (P4)
 *   confirm   – "Looks right" on the confirmation screen (P4): the shown facts become merchant-confirmed
 *   fact-accept-source – use the store's newer value instead of the merchant's earlier correction (§28, §42)
 *   variant   – which size/shade this ad is for (§42), before an idea is chosen
 *   not-right – "Not right?" on a delivered ad: diagnosis + re-plan (free once for product accuracy, §48)
 *   produce-free – produce a free re-plan's storyboard (no checkout)
 *   watched   – the finished ad was played (P10 "Watch", standard §7); recorded once per project
 */
export const POST = route(async (req, { params }: { params: Promise<{ id: string; action: string }> }) => {
  const { id, action } = await params;
  const a = await projectAccess(id);
  switch (action) {
    case 'concepts': {
      // Drafting runs in the worker (§34); the funnel polls GET /api/projects/:id until the batch appears.
      // A checkout still open for the storyboard being replaced is closed once the change is made (a payment
      // already made is still honoured for the storyboard it was for).
      // Optional §8 goal (sell / UGC review / explainer / premium): the new ideas are drafted for it.
      const { goal } = await body(req, z.object({ goal: z.enum(CreativeGoal).optional() }));
      const r = await withTenant(a.ctx.workspaceId, async (tx) => {
        const out = await requestConcepts(tx, a.ctx, id, { goal });
        if (!a.provisional) await closeOpenCheckouts(tx, a.ctx, id);
        return out;
      });
      return json({ ok: true, queued: true, ...r }, 202);
    }
    case 'select': {
      if (a.provisional) throw new DomainError('FORBIDDEN', 'Save your work to see the storyboard.', { needsAccount: true });
      const { conceptId } = await body(req, z.object({ conceptId: z.string().uuid() }));
      // Choosing another concept replaces the storyboard: a checkout still open for the old one is closed, so
      // nobody pays for a storyboard that is gone (a payment already made is honoured for the one it was for).
      const r = await withTenant(a.ctx.workspaceId, async (tx) => {
        const out = await selectConcept(tx, a.ctx, id, conceptId);
        if (!out.replayed) await closeOpenCheckouts(tx, a.ctx, id);
        return out;
      });
      return json(r);
    }
    case 'checkout': {
      if (!a.user || a.provisional) throw new DomainError('FORBIDDEN', 'Please sign in to continue.', { needsAccount: true });
      const r = await withTenant(a.ctx.workspaceId, (tx) => startProductionCheckout(tx, a.ctx, id, { id: a.user!.id, email: a.user!.email }));
      return json(r);
    }
    case 'produce-with-test': {
      if (!a.user || a.provisional) throw new DomainError('FORBIDDEN', 'Please sign in to continue.', { needsAccount: true });
      const r = await withTenant(a.ctx.workspaceId, async (tx) => {
        const out = await produceWithCreativeTest(tx, a.ctx, id);
        // A one-off checkout still open for this storyboard is closed: it is being made with a test instead.
        if (!out.replayed) await closeOpenCheckouts(tx, a.ctx, id);
        return out;
      });
      return json({ ok: true, ...r, next: `/produce/${id}` });
    }
    case 'fact': {
      // Confirmation screen (P4): the merchant's correction becomes a DECIDED fact and wins over page/photo values.
      const f = await body(req, z.object({ key: z.enum(['name', 'brand', 'size', 'price', 'category', 'texture', 'packaging', 'key_ingredients', 'ingredients']), value: z.string().trim().min(1).max(400) }));
      const [p] = await withTenant(a.ctx.workspaceId, (tx) => tx`select sku_id from projects where id = ${id}`);
      const num = f.key === 'price' ? Number(f.value.replace(/[^0-9.]/g, '')) : null;
      if (f.key === 'price' && !(num! > 0)) throw new DomainError('INVALID', 'Enter a price like 38.00');
      await withTenant(a.ctx.workspaceId, (tx) => decideFact(tx, a.ctx, p!.sku_id as string, f.key, f.key === 'price' ? { number: num } : { text: f.value }));
      return json({ ok: true });
    }
    case 'confirm': {
      const { factIds } = await body(req, z.object({ factIds: z.array(z.string().uuid()).max(50) }));
      const confirmed = await withTenant(a.ctx.workspaceId, async (tx) => {
        const [p] = await tx`select sku_id from projects where id = ${id}`;
        return confirmFacts(tx, a.ctx, p!.sku_id as string, factIds);
      });
      return json({ ok: true, confirmed: confirmed.length });
    }
    case 'fact-accept-source': {
      const f = await body(req, z.object({ factId: z.string().uuid() }));
      const [p] = await withTenant(a.ctx.workspaceId, (tx) => tx`select sku_id from projects where id = ${id}`);
      await withTenant(a.ctx.workspaceId, (tx) => acceptSourceFact(tx, a.ctx, p!.sku_id as string, f.factId));
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
    case 'recompose': {
      if (a.provisional) throw new DomainError('FORBIDDEN', 'Please sign in to continue.', { needsAccount: true });
      const r = await withTenant(a.ctx.workspaceId, (tx) => requestRecompose(tx, a.ctx, id));
      return json({ ok: true, ...r }, r.queued ? 202 : 200);
    }
    case 'edit-text': {
      if (a.provisional) throw new DomainError('FORBIDDEN', 'Please sign in to continue.', { needsAccount: true });
      const line = (max: number) => z.string().max(max).nullable().optional();
      const edits = await body(
        req,
        z.object({
          scenes: z.array(z.object({ sceneId: z.string().uuid(), spokenLine: line(160), overlayText: line(70) })).max(12).optional(),
          cta: z.string().trim().min(1).max(40).optional(),
        }),
      );
      const r = await withTenant(a.ctx.workspaceId, (tx) => requestTextEdit(tx, a.ctx, id, edits));
      return json({ ok: true, ...r }, r.queued ? 202 : 200);
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
    case 'not-right': {
      // P10 "Not right?": the diagnosis, and a re-plan (free once for product accuracy) as a new project.
      if (!a.user || a.provisional) throw new DomainError('FORBIDDEN', 'Please sign in to continue.', { needsAccount: true });
      const i = await body(req, z.object({ reason: z.enum(['strategy', 'accuracy', 'style']), note: z.string().trim().max(500).optional() }));
      const r = await withTenant(a.ctx.workspaceId, (tx) => reportNotRight(tx, a.ctx, id, { reason: i.reason, note: i.note ?? null }));
      return json({ ok: true, ...r });
    }
    case 'produce-free': {
      // A free re-plan's storyboard goes into production without a checkout (the credit was granted for it).
      if (!a.user || a.provisional) throw new DomainError('FORBIDDEN', 'Please sign in to continue.', { needsAccount: true });
      const r = await withTenant(a.ctx.workspaceId, (tx) => produceFreeRevision(tx, a.ctx, id));
      return json({ ok: true, ...r });
    }
    case 'watched': {
      const { assetId, seconds } = await body(req, z.object({ assetId: z.string().uuid(), seconds: z.number().min(0).max(3600) }));
      const recorded = await withTenant(a.ctx.workspaceId, (tx) => recordAssetWatched(tx, a.ctx, id, assetId, seconds));
      return json({ ok: true, recorded });
    }
    case 'photos': {
      const form = await req.formData().catch(() => null);
      const files = (form?.getAll('photos') ?? []).filter((f): f is File => f instanceof File && f.size > 0);
      if (files.length > MAX_ADDED_PHOTOS) throw new DomainError('INVALID', `Add up to ${MAX_ADDED_PHOTOS} photos at a time.`);
      const photos = await Promise.all(files.map(async (f) => ({ bytes: Buffer.from(await f.arrayBuffer()), filename: f.name })));
      const r = await withTenant(a.ctx.workspaceId, (tx) => addProductPhotos(tx, a.ctx, id, photos));
      return json({ ok: true, ...r }, r.mode === 'resumed' ? 202 : 200);
    }
    case 'select-product': {
      // Plan 03 P2: the photo shows several products — the box (fractions of the photo) marks the hero one.
      const box = await body(req, z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), w: z.number().gt(0).max(1), h: z.number().gt(0).max(1) }));
      const r = await withTenant(a.ctx.workspaceId, (tx) => selectHeroProduct(tx, a.ctx, id, box));
      return json({ ok: true, queued: true, ...r }, 202);
    }
    case 'choose-product': {
      // Plan 03 P2: the link listed several products — the analysis reads the one chosen (from that list, same site).
      const { url } = await body(req, z.object({ url: z.string().url().max(2000) }));
      const r = await withTenant(a.ctx.workspaceId, (tx) => chooseProduct(tx, a.ctx, id, url));
      return json({ ok: true, queued: true, ...r }, 202);
    }
    case 'duplicate': {
      // §42 Duplicate import: fold this import into the product already catalogued, or keep it as a new product.
      const { choice } = await body(req, z.object({ choice: z.enum(['merge', 'keep']) }));
      const r = await withTenant(a.ctx.workspaceId, (tx) => resolveDuplicate(tx, a.ctx, id, choice));
      const slug = r.mergedInto && !a.provisional ? (await withTenant(a.ctx.workspaceId, (tx) => tx`select slug from workspaces where id = ${a.ctx.workspaceId}`))[0]?.slug : null;
      return json({ ok: true, ...r, next: r.mergedInto ? (slug ? `/w/${slug as string}/products/${r.mergedInto}` : null) : null }, r.mergedInto ? 200 : 202);
    }
    case 'storyboard-retry': {
      const r = await withTenant(a.ctx.workspaceId, (tx) => retryStoryboard(tx, a.ctx, id));
      return json({ ok: true, queued: true, ...r }, 202);
    }
    case 'retry-analysis': {
      const r = await withTenant(a.ctx.workspaceId, (tx) => retryAnalysis(tx, a.ctx, id));
      return json({ ok: true, queued: true, ...r }, 202);
    }
    default:
      throw new DomainError('NOT_FOUND', 'Unknown action');
  }
});
