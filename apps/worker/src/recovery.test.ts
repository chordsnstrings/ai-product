import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool } from '@arkiv/db';
import { makeSku, makeTenant, truncateAll } from '@arkiv/db/testing';
import { draftRecoveryConcept, RECOVERY_TEMPLATES, recoveryEmailKey, type TenantContext } from '@arkiv/core';
import { devOutbox } from '@arkiv/email';
import { newId } from '@arkiv/shared';
import { sendQueuedEmail } from './emails';
import { sweeps } from './sweeps';

/** Plan 04 L8/L20: recovery emails link back into the funnel, stop after three and after a purchase. */
beforeEach(async () => {
  await truncateAll();
  devOutbox.length = 0;
});
afterAll(closeAll);

const webApp = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/app');

/** Does `pathname` resolve to a page in apps/web/app (route groups ignored, [param] matches any segment)? */
function routeExists(pathname: string, dir = webApp): boolean {
  const [head, ...rest] = pathname.split('/').filter(Boolean);
  const entries = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());
  if (!head) return existsSync(path.join(dir, 'page.tsx')) || entries.filter((e) => /^\(.+\)$/.test(e.name)).some((g) => routeExists('', path.join(dir, g.name)));
  const next = rest.join('/');
  return entries.some((e) => {
    if (/^\(.+\)$/.test(e.name)) return routeExists(pathname, path.join(dir, e.name));
    if (e.name === head || /^\[[^.\]]+\]$/.test(e.name)) return routeExists(next, path.join(dir, e.name));
    return false;
  });
}

async function abandoned(opts: { hoursAgo?: number } = {}) {
  const t = await makeTenant({ state: 'ACTIVE_FREE' });
  const skuId = await makeSku(t.workspaceId);
  const projectId = newId();
  const updated = new Date(Date.now() - (opts.hoursAgo ?? 1) * 3600_000);
  await ownerPool()`insert into projects (id, workspace_id, sku_id, kind, state, created_by, updated_at)
                    values (${projectId}, ${t.workspaceId}, ${skuId}, 'preview', 'STORYBOARD_READY', 'test', ${updated})`;
  const [o] = await ownerPool()`insert into offers (workspace_id, definition_code, type, project_id, price_micros, reference_price_micros, starts_at, expires_at)
                                values (${t.workspaceId}, 'TASTE_19', 'TASTE', ${projectId}, 19000000, 29000000, now() - interval '45 minutes', now() + interval '15 minutes')
                                returning id`;
  const [c] = await ownerPool()`insert into concepts (workspace_id, sku_id, project_id, batch, idx, proposal, is_pick, prompt_version, model)
                                values (${t.workspaceId}, ${skuId}, ${projectId}, 1, 'A', ${ownerPool().json({ hookOptions: ['The texture, up close'] })}, true, 'test', 'test') returning id`;
  const ctx: TenantContext = { workspaceId: t.workspaceId, workspaceState: 'ACTIVE_FREE', role: 'OWNER', actor: { kind: 'system', id: 'test' }, requestId: 'test' };
  return { t, ctx, skuId, projectId, offerId: o!.id as string, conceptId: c!.id as string };
}

const payloadFor = (a: Awaited<ReturnType<typeof abandoned>>, template: string) =>
  template === 'offer_ending' ? { template, offerId: a.offerId } : { template, projectId: a.projectId, conceptId: a.conceptId };

describe('recovery emails (plan 04 L20)', () => {
  for (const template of RECOVERY_TEMPLATES) {
    it(`${template} links to a real funnel page for the project`, async () => {
      const a = await abandoned();
      await sendQueuedEmail(a.ctx, payloadFor(a, template), `job-${template}`);
      const sent = devOutbox.find((m) => m.template === template && m.to === a.t.email);
      expect(sent, `${template} sent`).toBeTruthy();
      const url = new URL((sent!.data as { url: string }).url);
      expect(url.pathname).toContain(a.projectId);
      expect(routeExists(url.pathname), url.pathname).toBe(true);
      expect(url.searchParams.get('utm_campaign')).toBe(`recovery_${template}`);
    });
  }

  it('the route check itself rejects the old broken link', () => {
    expect(routeExists(`/start/${newId()}/storyboard`)).toBe(false);
    expect(routeExists(`/storyboard/${newId()}`)).toBe(true);
  });

  it('stops after three recovery emails for a project', async () => {
    const a = await abandoned({ hoursAgo: 72.5 });
    for (const t of RECOVERY_TEMPLATES) {
      await ownerPool()`insert into email_log (workspace_id, to_email, template, stream, idempotency_key, status, created_at)
                        values (${a.t.workspaceId}, ${a.t.email}, ${t}, 'marketing', ${recoveryEmailKey(a.projectId, t, a.t.email)}, 'sent', now() - interval '3 days')`;
    }
    await sweeps['offer-reminders']!.run();
    expect(await ownerPool()`select queue from outbox where workspace_id = ${a.t.workspaceId}`).toHaveLength(0);
    await sendQueuedEmail(a.ctx, payloadFor(a, 'new_concept'), 'job-4th');
    expect(devOutbox).toHaveLength(0);
  });

  it('stops once the merchant has bought', async () => {
    const a = await abandoned({ hoursAgo: 24.5 });
    await ownerPool()`insert into purchases (workspace_id, kind, project_id, amount_micros, status, created_by) values (${a.t.workspaceId}, 'taste', ${a.projectId}, 19000000, 'paid', 'test')`;
    await sweeps['offer-reminders']!.run();
    expect(await ownerPool()`select queue from outbox where workspace_id = ${a.t.workspaceId}`).toHaveLength(0);
    await sendQueuedEmail(a.ctx, payloadFor(a, 'storyboard_saved'), 'job-after-purchase');
    expect(devOutbox).toHaveLength(0);
  });

  it('T+3d drafts a new concept in a job and emails it', async () => {
    const a = await abandoned({ hoursAgo: 72.5 });
    await sweeps['offer-reminders']!.run();
    const [job] = await ownerPool()`select payload from outbox where workspace_id = ${a.t.workspaceId} and queue = 'recovery-concept'`;
    expect(job!.payload).toMatchObject({ projectId: a.projectId });
    expect(await draftRecoveryConcept(a.ctx, a.projectId)).toBe('queued');
    expect(await draftRecoveryConcept(a.ctx, a.projectId)).toBe('skipped'); // never drafts twice
    const [mail] = await ownerPool()`select payload from outbox where workspace_id = ${a.t.workspaceId} and queue = 'send-email' and payload->>'template' = 'new_concept'`;
    expect(mail!.payload).toMatchObject({ template: 'new_concept', projectId: a.projectId });
    const [b2] = await ownerPool()`select count(*)::int as n from concepts where project_id = ${a.projectId} and batch = 2`;
    expect(b2!.n).toBeGreaterThan(0);
    await sendQueuedEmail(a.ctx, mail!.payload as Record<string, unknown>, 'job-new-concept');
    const sent = devOutbox.find((m) => m.template === 'new_concept');
    expect(new URL((sent!.data as { url: string }).url).pathname).toBe(`/concepts/${a.projectId}`);
  }, 60_000);
});
