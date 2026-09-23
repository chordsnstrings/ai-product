import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, globalTx, ownerPool, withSystem, withTenant } from '@arkiv/db';
import { makeTenant, makeSku, truncateAll } from '@arkiv/db/testing';
import {
  analyzeProduct,
  append,
  approveForProduction,
  authorize,
  available,
  generateStoryboard,
  ingestBytes,
  produceProject,
  retryProduction,
  selectConcept,
  startPreview,
  sweepExpiredAuthorizations,
} from '@arkiv/core';
import { ctxFor, productPhoto } from '@arkiv/core/testing';
import { MockStripe, processStripeEvent, receiveStripeWebhook, setBillingGateway } from '@arkiv/billing';

/**
 * Chaos suite (plan 06 Phase 6 §5): provider outages, crashed workers, webhook storms, duplicate job delivery
 * and concurrent tenants. Invariants: no lost or double-spent entitlement, no stranded reservation, no
 * cross-tenant reads.
 */
beforeEach(async () => {
  await truncateAll();
  setBillingGateway(new MockStripe());
});
afterAll(closeAll);

async function readyForProduction(marker?: string) {
  const t = await makeTenant();
  const ctx = ctxFor(t.workspaceId, t.userId);
  const a = await withTenant(t.workspaceId, async (tx) => ingestBytes(tx, ctx, await productPhoto(), 'product_photo', null));
  const { skuId, projectId } = await withTenant(t.workspaceId, (tx) => startPreview(tx, ctx, { photoAssetIds: [a.id] }));
  await analyzeProduct(ctx, skuId, projectId);
  const [c] = await ownerPool()`select id from concepts where project_id = ${projectId} order by idx limit 1`;
  const { storyboardId } = await withTenant(t.workspaceId, (tx) => selectConcept(tx, ctx, projectId, c!.id as string));
  await generateStoryboard(ctx, projectId, storyboardId, c!.id as string);
  if (marker) await ownerPool()`update scenes set visual_plan = visual_plan || ${' ' + marker} where storyboard_id = ${storyboardId} and production_mode = 'GENERATIVE_INTERACTION'`;
  await withTenant(t.workspaceId, async (tx) => {
    await append(tx, ctx, { type: 'CREDIT_GRANTED', unit: 'taste', amount: 1, idempotencyKey: `pay:${projectId}` });
    await approveForProduction(tx, ctx, projectId, 'taste');
  });
  return { t, ctx, projectId, storyboardId };
}

describe('provider outage', () => {
  it('a video-model outage degrades to the exact product composite instead of failing the order', async () => {
    const { t, ctx, projectId } = await readyForProduction('[[fail:render]]');
    expect(await produceProject(ctx, projectId)).toBe('complete');
    await withTenant(t.workspaceId, async (tx) => {
      const [p] = await tx`select qa_report from projects where id = ${projectId}`;
      expect(JSON.stringify(p!.qa_report)).toMatch(/switched to exact product composite/);
      const [consumed] = await tx`select count(*)::int as n from ledger_entries where type = 'CREDIT_CONSUMED'`;
      expect(consumed!.n).toBe(1);
    });
  }, 180_000);

  it('a voice outage on primary and fallback fails cleanly, refunds the entitlement, and a retry charges once', async () => {
    const { t, ctx, projectId, storyboardId } = await readyForProduction();
    await ownerPool()`update scenes set spoken_line = coalesce(spoken_line, 'Soft skin.') || ' [[fail:server]]' where storyboard_id = ${storyboardId} and position = 0`;
    await expect(produceProject(ctx, projectId)).rejects.toThrow();
    await withTenant(t.workspaceId, async (tx) => {
      const [p] = await tx`select state from projects where id = ${projectId}`;
      expect(p!.state).toBe('PROVIDER_FAILED');
      expect(await available(tx, 'taste')).toBe(1); // entitlement returned
      const [active] = await tx`select count(*)::int as n from cost_authorizations where status = 'active'`;
      expect(active!.n).toBe(0); // nothing stranded
      const [consumed] = await tx`select count(*)::int as n from ledger_entries where type = 'CREDIT_CONSUMED'`;
      expect(consumed!.n).toBe(0);
    });
    // Provider recovers → retry (merchant or staff) → delivered, charged exactly once.
    await ownerPool()`update scenes set spoken_line = replace(spoken_line, ' [[fail:server]]', '') where storyboard_id = ${storyboardId}`;
    await withTenant(t.workspaceId, (tx) => retryProduction(tx, ctx, projectId));
    expect(await produceProject(ctx, projectId)).toBe('complete');
    await withTenant(t.workspaceId, async (tx) => {
      expect(await available(tx, 'taste')).toBe(0);
      const [consumed] = await tx`select count(*)::int as n from ledger_entries where type = 'CREDIT_CONSUMED'`;
      expect(consumed!.n).toBe(1);
    });
  }, 240_000);
});

describe('duplicate job delivery', () => {
  it('two workers picking up the same production job produce and charge once', async () => {
    const { t, ctx, projectId } = await readyForProduction();
    const results = await Promise.all([produceProject(ctx, projectId), produceProject(ctx, projectId)]);
    expect(results.sort()).toEqual(['complete', 'skipped']);
    await withTenant(t.workspaceId, async (tx) => {
      const [consumed] = await tx`select count(*)::int as n from ledger_entries where type = 'CREDIT_CONSUMED'`;
      expect(consumed!.n).toBe(1);
      const [cr] = await tx`select count(*)::int as n from creatives where project_id = ${projectId}`;
      expect(cr!.n).toBe(1);
    });
  }, 180_000);
});

describe('crashed worker', () => {
  it('the sweeper releases a reservation stranded by a crash', async () => {
    const t = await makeTenant({ state: 'ACTIVE_PAID', plan: 'GROWTH' });
    const ctx = ctxFor(t.workspaceId, t.userId);
    await withTenant(t.workspaceId, async (tx) => {
      await append(tx, ctx, { type: 'CREDIT_GRANTED', unit: 'creative_test', amount: 3, idempotencyKey: 'grant', periodKey: '2026-09-01' });
      await authorize(tx, ctx, { purpose: 'creative_test', projectId: null, lines: [{ kind: 'media', outputs: 1 }], idempotencyKey: 'crash-1', entitlement: { unit: 'creative_test', amount: 1, periodKey: '2026-09-01' } } as never);
      expect(await available(tx, 'creative_test')).toBe(2);
    });
    // Worker dies; the authorization outlives its TTL.
    await ownerPool()`update cost_authorizations set expires_at = now() - interval '1 minute'`;
    expect(await withSystem((tx) => sweepExpiredAuthorizations(tx))).toBe(1);
    await withTenant(t.workspaceId, async (tx) => {
      expect(await available(tx, 'creative_test')).toBe(3);
      const [a] = await tx`select status from cost_authorizations`;
      expect(a!.status).toBe('released');
    });
    // Idempotent: a second sweep does nothing.
    expect(await withSystem((tx) => sweepExpiredAuthorizations(tx))).toBe(0);
  });
});

describe('webhook storm', () => {
  it('ten concurrent deliveries of the same Stripe event grant once', async () => {
    const t = await makeTenant();
    await ownerPool()`insert into stripe_customers (customer_id, workspace_id) values ('cus_storm', ${t.workspaceId})`;
    const evt = { id: 'evt_storm_1', type: 'invoice.payment_failed', created: Math.floor(Date.now() / 1000), data: { object: { id: 'in_1', customer: 'cus_storm', subscription: 'sub_x' } } };
    const received = await Promise.all(Array.from({ length: 10 }, () => receiveStripeWebhook(JSON.stringify(evt), null)));
    expect(received.filter((r) => !r.duplicate)).toHaveLength(1);
    await Promise.all(Array.from({ length: 5 }, () => processStripeEvent('evt_storm_1')));
    const [row] = await ownerPool()`select status from stripe_events where id = 'evt_storm_1'`;
    expect(['processed', 'unmatched', 'ignored']).toContain(row!.status);
    const emails = await ownerPool()`select count(*)::int as n from email_log where template = 'payment_failed'`;
    expect(emails[0]!.n).toBeLessThanOrEqual(1);
  });
});

describe('tenant isolation under concurrency', () => {
  it('interleaved tenant transactions on a shared pool never see each other, and context never leaks', async () => {
    const a = await makeTenant();
    const b = await makeTenant();
    await makeSku(a.workspaceId);
    await makeSku(a.workspaceId);
    await makeSku(b.workspaceId);
    const runs = await Promise.all(
      Array.from({ length: 60 }, (_, i) => {
        const ws = i % 2 ? a.workspaceId : b.workspaceId;
        return withTenant(ws, async (tx) => {
          const rows = await tx`select workspace_id from skus`;
          return { ws, seen: [...new Set(rows.map((r) => r.workspace_id as string))], n: rows.length };
        });
      }),
    );
    for (const r of runs) {
      expect(r.seen).toEqual([r.ws]);
      expect(r.n).toBe(r.ws === a.workspaceId ? 2 : 1);
    }
    // After all those transactions, a context-free query on the same pool still fails closed.
    await expect(globalTx((tx) => tx`select count(*) from skus`)).rejects.toThrow(/tenant context not set/);
  });
});
