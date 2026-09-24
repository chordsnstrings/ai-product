import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool, withTenant } from '@arkiv/db';
import { makeSku, makeTenant, truncateAll } from '@arkiv/db/testing';
import { approveExperiment, createExperiment } from './experiments';
import { append } from './ledger';
import { mockConcepts } from './mock-intel';
import { produceProject } from './production';
import { renderQuote } from './render-quotes';
import { generateStoryboard } from './storyboard';
import { ctxFor } from './testing';

beforeEach(truncateAll);
afterAll(closeAll);

async function readyExperiment(credits: number) {
  const t = await makeTenant({ plan: 'GROWTH', state: 'ACTIVE_PAID' });
  const ctx = ctxFor(t.workspaceId, t.userId, 'OWNER', 'ACTIVE_PAID');
  const skuId = await makeSku(t.workspaceId);
  if (credits) await withTenant(t.workspaceId, (tx) => append(tx, ctx, { type: 'CREDIT_GRANTED', unit: 'creative_test', amount: credits, periodKey: '2026-09-01', idempotencyKey: 'grant:q' }));
  const proposal = mockConcepts({ name: 'Glow Serum', category: 'serum', approvedClaims: [], themes: [], testedAngles: [] }).concepts[0]!;
  const r = await withTenant(t.workspaceId, (tx) => createExperiment(tx, ctx, { skuId, proposal }));
  const [c] = await ownerPool()`select selected_concept_id from projects where id = ${r.projectId}`;
  await generateStoryboard(ctx, r.projectId, r.storyboardId, c!.selected_concept_id as string);
  return { t, ctx, ...r };
}
const reservations = (ws: string) => ownerPool()`select count(*)::int as n from ledger_entries where workspace_id = ${ws} and type = 'CREDIT_RESERVED'`.then((r) => r[0]!.n as number);
const auths = (projectId: string) => ownerPool()`select id, idempotency_key, status, max_cost_micros from cost_authorizations where project_id = ${projectId} and purpose = 'creative_test' order by created_at`;

describe('render estimate and quoted approval (standard §38 Production)', () => {
  it('quotes without reserving, then authorises in the approval transaction; the run takes that reservation over', async () => {
    const x = await readyExperiment(2);
    const q = await withTenant(x.t.workspaceId, (tx) => renderQuote(tx, x.ctx, x.experimentId));
    expect(q).toMatchObject({ withinCeiling: true, entitlementAvailable: true, blockedReason: null });
    expect(q.estimateMicros).toBeGreaterThan(0);
    expect(await reservations(x.t.workspaceId)).toBe(0); // nothing reserved by the estimate
    expect(await auths(x.projectId)).toEqual([]);

    await withTenant(x.t.workspaceId, (tx) => approveExperiment(tx, x.ctx, x.experimentId, { quoteId: q.quoteId }));
    const [a] = await auths(x.projectId);
    expect(a).toMatchObject({ idempotency_key: `produce:${x.projectId}`, status: 'active', max_cost_micros: q.estimateMicros });
    expect(await reservations(x.t.workspaceId)).toBe(1);
    const [p] = await ownerPool()`select state, authorization_id from projects where id = ${x.projectId}`;
    expect(p).toMatchObject({ state: 'STORYBOARD_APPROVED', authorization_id: a!.id });
    expect((await ownerPool()`select used_at from render_quotes where id = ${q.quoteId}`)[0]!.used_at).not.toBeNull();

    // The production run finds the live authorization and uses it: no second reservation.
    await produceProject(x.ctx, x.projectId);
    expect((await auths(x.projectId)).filter((r) => String(r.idempotency_key).startsWith('produce:'))).toHaveLength(1);
    expect(await reservations(x.t.workspaceId)).toBe(1);
  }, 240_000);

  it('a refusal shows in the estimate, and approving with it rolls back; stale and reused quotes are refused', async () => {
    const x = await readyExperiment(0);
    const q = await withTenant(x.t.workspaceId, (tx) => renderQuote(tx, x.ctx, x.experimentId));
    expect(q).toMatchObject({ entitlementAvailable: false, blockedReason: expect.stringMatching(/No Creative Tests left/) });
    await expect(withTenant(x.t.workspaceId, (tx) => approveExperiment(tx, x.ctx, x.experimentId, { quoteId: q.quoteId }))).rejects.toMatchObject({ code: 'PAYMENT_REQUIRED' });
    const [e] = await ownerPool()`select approved_at from experiments where id = ${x.experimentId}`;
    expect(e!.approved_at).toBeNull(); // nothing half-approved
    expect((await ownerPool()`select state from projects where id = ${x.projectId}`)[0]!.state).not.toBe('STORYBOARD_APPROVED');

    await withTenant(x.t.workspaceId, (tx) => append(tx, x.ctx, { type: 'CREDIT_GRANTED', unit: 'creative_test', amount: 1, periodKey: '2026-09-01', idempotencyKey: 'grant:late' }));
    // The storyboard changed after the quote: approve against a fresh one.
    const q2 = await withTenant(x.t.workspaceId, (tx) => renderQuote(tx, x.ctx, x.experimentId));
    await ownerPool()`update scenes set spoken_line = 'A different line.' where storyboard_id = (select storyboard_id from projects where id = ${x.projectId}) and position = 0`;
    await expect(withTenant(x.t.workspaceId, (tx) => approveExperiment(tx, x.ctx, x.experimentId, { quoteId: q2.quoteId }))).rejects.toMatchObject({ code: 'CONFLICT', details: { requote: true } });
    // An expired quote.
    const q3 = await withTenant(x.t.workspaceId, (tx) => renderQuote(tx, x.ctx, x.experimentId));
    await ownerPool()`update render_quotes set expires_at = now() - interval '1 second' where id = ${q3.quoteId}`;
    await expect(withTenant(x.t.workspaceId, (tx) => approveExperiment(tx, x.ctx, x.experimentId, { quoteId: q3.quoteId }))).rejects.toMatchObject({ code: 'CONFLICT' });
    // A good one goes through, once.
    const q4 = await withTenant(x.t.workspaceId, (tx) => renderQuote(tx, x.ctx, x.experimentId));
    expect(await withTenant(x.t.workspaceId, (tx) => approveExperiment(tx, x.ctx, x.experimentId, { quoteId: q4.quoteId }))).toMatchObject({ changed: true });
    expect(await withTenant(x.t.workspaceId, (tx) => approveExperiment(tx, x.ctx, x.experimentId, { quoteId: q4.quoteId }))).toMatchObject({ changed: false });
    expect(await reservations(x.t.workspaceId)).toBe(1);
    await expect(withTenant(x.t.workspaceId, (tx) => renderQuote(tx, x.ctx, x.experimentId))).rejects.toMatchObject({ code: 'CONFLICT' });
  }, 120_000);

  it('an out-of-stock product is flagged in the estimate and approval waits for the merchant’s intent (§42)', async () => {
    const x = await readyExperiment(1);
    await ownerPool()`update skus set in_stock = false where workspace_id = ${x.t.workspaceId}`;
    const q = await withTenant(x.t.workspaceId, (tx) => renderQuote(tx, x.ctx, x.experimentId));
    expect(q.blockedReason).toMatch(/out of stock/);
    await expect(withTenant(x.t.workspaceId, (tx) => approveExperiment(tx, x.ctx, x.experimentId, { quoteId: q.quoteId }))).rejects.toMatchObject({ code: 'CONFLICT', details: { outOfStock: true } });
    await ownerPool()`update skus set stock_intent = 'launch' where workspace_id = ${x.t.workspaceId}`;
    const q2 = await withTenant(x.t.workspaceId, (tx) => renderQuote(tx, x.ctx, x.experimentId));
    expect(q2.blockedReason).toBeNull();
    expect((await withTenant(x.t.workspaceId, (tx) => approveExperiment(tx, x.ctx, x.experimentId, { quoteId: q2.quoteId }))).changed).toBe(true);
  }, 240_000);
});
