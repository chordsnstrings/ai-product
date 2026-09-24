import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { closeAll, ownerPool, withTenant } from '@arkiv/db';
import { makeTenant, truncateAll } from '@arkiv/db/testing';
import { usd, type Role } from '@arkiv/shared';
import { can } from './authz';
import type { TenantContext } from './context';
import { authorize, consumeAuthorization, estimateCost, marginDecision, revenuePerUnit, settle, sweepExpiredAuthorizations } from './cost-governor';
import { idempotent } from './idempotency';
import { append, available, balances, expirePeriod, periodUsage } from './ledger';
import { llmJson } from './model-gateway';
import { checkoutSessionExpiry, currentQuote, issueTasteOffer } from './offers';
import { acceptInvite, changeRole, claimProvisional, createProvisionalWorkspace, inviteMember, removeMember, resolveProvisional, transferOwnership } from './workspaces';

beforeEach(truncateAll);
afterAll(closeAll);

const ctxFor = (workspaceId: string, userId: string, role: Role = 'OWNER', state = 'ACTIVE_PAID'): TenantContext => ({
  workspaceId,
  workspaceState: state as never,
  role,
  actor: { kind: 'user', id: userId },
  requestId: 'test',
});

describe('authz matrix', () => {
  it('matches plan 02 §1.1', () => {
    const s = 'ACTIVE_PAID' as const;
    expect(can({ role: 'VIEWER', workspaceState: s }, 'sku.create')).toBe(false);
    expect(can({ role: 'MEMBER', workspaceState: s }, 'claim.approve')).toBe(false);
    expect(can({ role: 'ADMIN', workspaceState: s }, 'claim.approve')).toBe(true);
    expect(can({ role: 'ADMIN', workspaceState: s }, 'billing.manage')).toBe(false);
    expect(can({ role: 'OWNER', workspaceState: s }, 'billing.manage')).toBe(true);
  });
  it('pauses spend when past due / locked but keeps read + export', () => {
    expect(can({ role: 'OWNER', workspaceState: 'PAST_DUE' }, 'spend.creative_test')).toBe(false);
    expect(can({ role: 'OWNER', workspaceState: 'LOCKED' }, 'sku.create')).toBe(false);
    expect(can({ role: 'OWNER', workspaceState: 'LOCKED' }, 'workspace.export')).toBe(true);
  });
});

describe('rates', () => {
  it('prices a standard 15s 720p test like the standard §6 planning model', async () => {
    const est = await withTenant((await makeTenant()).workspaceId, (tx) =>
      estimateCost(tx, [{ kind: 'video', provider: 'byteplus', model: 'dreamina-seedance-2-5', seconds: 15, resolution: '720p' }]),
    );
    // $3.47 raw + 25% QA retry reserve.
    expect(est.totalMicros).toBe(Math.ceil(15 * 231333 * 1.25));
  });
});

describe('ledger + cost governor', () => {
  it('derives balances, reserves, settles once, and releases on failure', async () => {
    const t = await makeTenant({ plan: 'GROWTH', state: 'ACTIVE_PAID' });
    const ctx = ctxFor(t.workspaceId, t.userId);
    await withTenant(t.workspaceId, async (tx) => {
      await append(tx, ctx, { type: 'CREDIT_GRANTED', unit: 'creative_test', amount: 7, periodKey: '2026-09', idempotencyKey: 'grant:2026-09' });
      // Duplicate grant (e.g. webhook replay) is a no-op.
      expect(await append(tx, ctx, { type: 'CREDIT_GRANTED', unit: 'creative_test', amount: 7, periodKey: '2026-09', idempotencyKey: 'grant:2026-09' })).toBe(false);
      expect(await available(tx, 'creative_test')).toBe(7);
    });
    const auth = await withTenant(t.workspaceId, (tx) =>
      authorize(tx, ctx, {
        purpose: 'creative_test',
        lines: [{ kind: 'video', provider: 'byteplus', model: 'dreamina-seedance-2-5', seconds: 15, resolution: '720p' }],
        entitlement: { unit: 'creative_test', amount: 1, periodKey: '2026-09' },
        idempotencyKey: 'p1',
      }),
    );
    await withTenant(t.workspaceId, async (tx) => {
      expect(await available(tx, 'creative_test')).toBe(6);
      expect((await periodUsage(tx, '2026-09')).remaining).toBe(6);
      expect(await settle(tx, ctx, auth.authorizationId, 'released')).toBe(true);
      expect(await settle(tx, ctx, auth.authorizationId, 'consumed')).toBe(false); // duplicate callback
      expect(await available(tx, 'creative_test')).toBe(7);
      expect(await expirePeriod(tx, ctx, '2026-09')).toBe(7);
      expect((await balances(tx)).creativeTests).toBe(0);
    });
  });

  it('rejects a second authorization for the same idempotency key (double-click)', async () => {
    const t = await makeTenant({ plan: 'GROWTH' });
    const ctx = ctxFor(t.workspaceId, t.userId);
    const input = { purpose: 'storyboard' as const, lines: [{ kind: 'image' as const, provider: 'byteplus', model: 'seedream-5-0-pro', images: 4 }], idempotencyKey: 'sb-1' };
    await withTenant(t.workspaceId, (tx) => authorize(tx, ctx, input));
    await expect(withTenant(t.workspaceId, (tx) => authorize(tx, ctx, input))).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('turns a concurrent duplicate authorization into CONFLICT, not a unique-index error', async () => {
    const t = await makeTenant({ plan: 'GROWTH' });
    const ctx = ctxFor(t.workspaceId, t.userId);
    const input = { purpose: 'storyboard' as const, lines: [{ kind: 'image' as const, provider: 'byteplus', model: 'seedream-5-0-pro', images: 4 }], idempotencyKey: 'sb-race' };
    // Hold the first transaction open until the second has passed the replay check and is blocked on the insert.
    let second!: Promise<unknown>;
    await withTenant(t.workspaceId, async (tx) => {
      await authorize(tx, ctx, input);
      second = withTenant(t.workspaceId, (tx2) => authorize(tx2, ctx, input));
      second.catch(() => {});
      await new Promise((r) => setTimeout(r, 300));
    });
    await expect(second).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('blocks spend without entitlement and above the Creative Test ceiling', async () => {
    const t = await makeTenant();
    const ctx = ctxFor(t.workspaceId, t.userId);
    await expect(
      withTenant(t.workspaceId, (tx) =>
        authorize(tx, ctx, {
          purpose: 'taste',
          lines: [{ kind: 'video', provider: 'byteplus', model: 'dreamina-seedance-2-5', seconds: 15, resolution: '720p' }],
          entitlement: { unit: 'taste', amount: 1 },
          idempotencyKey: 'x',
        }),
      ),
    ).rejects.toMatchObject({ code: 'PAYMENT_REQUIRED' });
    await expect(
      withTenant(t.workspaceId, (tx) =>
        authorize(tx, ctx, {
          purpose: 'creative_test',
          lines: [{ kind: 'video', provider: 'byteplus', model: 'dreamina-seedance-2-5', seconds: 30, resolution: '720p' }],
          idempotencyKey: 'y',
        }),
      ),
    ).rejects.toMatchObject({ code: 'GATE_BLOCKED' });
  });

  it('refuses entitlement work that costs more than the markup floor allows (§33, §37)', async () => {
    const t = await makeTenant({ plan: 'SCALE', state: 'ACTIVE_PAID' });
    const ctx = ctxFor(t.workspaceId, t.userId);
    const video = (seconds: number) => [{ kind: 'video' as const, provider: 'byteplus', model: 'dreamina-seedance-2-5', seconds, resolution: '720p' as const }];
    await withTenant(t.workspaceId, (tx) => append(tx, ctx, { type: 'CREDIT_GRANTED', unit: 'creative_test', amount: 5, idempotencyKey: 'g:floor' }));
    // Scale: $199 / 16 = $12.4375 per Creative Test → at most $8.70 of variable cost at a 30% floor.
    expect(await withTenant(t.workspaceId, (tx) => revenuePerUnit(tx, 'SCALE', 'creative_test', null))).toBe(12_437_500);
    const long = await withTenant(t.workspaceId, (tx) => estimateCost(tx, video(40)));
    expect(long.totalMicros).toBeGreaterThan(8_706_250);
    // Premium work has no standard ceiling: the floor is what bounds it.
    await expect(
      withTenant(t.workspaceId, (tx) => authorize(tx, ctx, { purpose: 'premium', lines: video(40), entitlement: { unit: 'creative_test', amount: 1 }, idempotencyKey: 'prem-1' })),
    ).rejects.toMatchObject({ code: 'GATE_BLOCKED', details: { reason: 'markup_floor', revenueMicros: 12_437_500, maxCostMicros: 8_706_250 } });
    // Two tests' worth of entitlement cover it; the decision is stored with the estimate.
    const ok = await withTenant(t.workspaceId, (tx) => authorize(tx, ctx, { purpose: 'premium', lines: video(40), entitlement: { unit: 'creative_test', amount: 2 }, idempotencyKey: 'prem-2' }));
    const [a] = await ownerPool()`select estimate->'margin' as margin from cost_authorizations where id = ${ok.authorizationId}`;
    expect(a!.margin).toMatchObject({ ok: true, revenueMicros: 24_875_000, floor: 0.3 });
    // Premium and repair work are never authorized without a priced entitlement.
    for (const purpose of ['premium', 'repair'] as const) {
      await expect(withTenant(t.workspaceId, (tx) => authorize(tx, ctx, { purpose, lines: video(5), idempotencyKey: `unpriced-${purpose}` }))).rejects.toMatchObject({ code: 'GATE_BLOCKED', details: { reason: 'unpriced' } });
    }
  });

  it('values a Taste at what was paid, or at the live offer price for an unpaid credit', async () => {
    const t = await makeTenant();
    const [p] = await ownerPool()`insert into skus (workspace_id, catalogue_no, name) values (${t.workspaceId}, 1, 'S') returning id`;
    const [proj] = await ownerPool()`insert into projects (workspace_id, sku_id, kind, state, created_by) values (${t.workspaceId}, ${p!.id}, 'preview', 'STORYBOARD_APPROVED', 'x') returning id`;
    expect(await withTenant(t.workspaceId, (tx) => revenuePerUnit(tx, null, 'taste', proj!.id as string))).toBe(19_000_000);
    await ownerPool()`insert into purchases (workspace_id, kind, project_id, amount_micros, stripe_checkout_session_id, created_by, status, paid_at)
                      values (${t.workspaceId}, 'taste', ${proj!.id}, 5000000, 'cs_disc', 'user:x', 'paid', now())`;
    const d = await withTenant(t.workspaceId, (tx) => marginDecision(tx, null, 'taste', 1, proj!.id as string, 4_000_000));
    expect(d).toMatchObject({ ok: false, revenueMicros: 5_000_000, maxCostMicros: 3_500_000 });
    // Without a plan, a Creative Test is valued at the cheapest per-test price of any plan.
    expect(await withTenant(t.workspaceId, (tx) => revenuePerUnit(tx, null, 'creative_test', null))).toBe(12_437_500);
  });

  it('enforces the free preview cap per SKU', async () => {
    const t = await makeTenant();
    const ctx = ctxFor(t.workspaceId, t.userId, 'OWNER', 'ACTIVE_FREE');
    const line = { kind: 'llm' as const, provider: 'anthropic', model: 'claude-opus-5-5', inputTokens: 10_000, outputTokens: 4_000 };
    // 10k*$4/M + 4k*$20/M = $0.12 per call → second call exceeds $0.20.
    await withTenant(t.workspaceId, (tx) => authorize(tx, ctx, { purpose: 'free_preview', skuId: 's1', lines: [line], idempotencyKey: 'a' }));
    await expect(
      withTenant(t.workspaceId, (tx) => authorize(tx, ctx, { purpose: 'free_preview', skuId: 's1', lines: [line], idempotencyKey: 'b' })),
    ).rejects.toMatchObject({ code: 'GATE_BLOCKED' });
  });

  it('caps free-preview COGS per provisional workspace across products, asking for signup (plan 02 §4)', async () => {
    const t = await makeTenant({ state: 'PROVISIONAL' });
    const ctx = ctxFor(t.workspaceId, t.userId, 'OWNER', 'PROVISIONAL');
    const line = { kind: 'llm' as const, provider: 'anthropic', model: 'claude-opus-5-5', inputTokens: 10_000, outputTokens: 4_000 };
    // $0.12 on one product, then $0.12 on a second: each is under the per-SKU cap, together over $0.20.
    await withTenant(t.workspaceId, (tx) => authorize(tx, ctx, { purpose: 'free_preview', skuId: 's1', lines: [line], idempotencyKey: 'a' }));
    await expect(withTenant(t.workspaceId, (tx) => authorize(tx, ctx, { purpose: 'free_preview', skuId: 's2', lines: [line], idempotencyKey: 'b' }))).rejects.toMatchObject({
      code: 'PAYMENT_REQUIRED',
      details: { needsAccount: true },
    });
    // Another provisional workspace is unaffected.
    const u = await makeTenant({ state: 'PROVISIONAL' });
    await withTenant(u.workspaceId, (tx) => authorize(tx, ctxFor(u.workspaceId, u.userId, 'OWNER', 'PROVISIONAL'), { purpose: 'free_preview', skuId: 's2', lines: [line], idempotencyKey: 'a' }));
  });

  it('two productions racing for the last Creative Test: exactly one reserves, the balance never goes negative (x-races-01)', async () => {
    const t = await makeTenant({ plan: 'GROWTH' });
    const ctx = ctxFor(t.workspaceId, t.userId);
    await withTenant(t.workspaceId, (tx) => append(tx, ctx, { type: 'CREDIT_GRANTED', unit: 'creative_test', amount: 1, idempotencyKey: 'g' }));
    const line = { kind: 'image' as const, provider: 'byteplus', model: 'seedream-5-0-pro', images: 1 };
    const results = await Promise.allSettled(
      ['p1', 'p2'].map((k) => withTenant(t.workspaceId, (tx) => authorize(tx, ctx, { purpose: 'repair', lines: [line], entitlement: { unit: 'creative_test', amount: 1 }, idempotencyKey: k }))),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const failed = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(failed.reason).toMatchObject({ code: 'PAYMENT_REQUIRED' });
    expect(await withTenant(t.workspaceId, (tx) => available(tx, 'creative_test'))).toBe(0);
  });

  it('a test released after its period expired expires too, instead of rolling over (x-races-08)', async () => {
    const t = await makeTenant({ plan: 'GROWTH' });
    const ctx = ctxFor(t.workspaceId, t.userId);
    const line = { kind: 'image' as const, provider: 'byteplus', model: 'seedream-5-0-pro', images: 1 };
    const auth = await withTenant(t.workspaceId, async (tx) => {
      await append(tx, ctx, { type: 'CREDIT_GRANTED', unit: 'creative_test', amount: 2, periodKey: '2026-08-01', idempotencyKey: 'g' });
      return authorize(tx, ctx, { purpose: 'repair', lines: [line], entitlement: { unit: 'creative_test', amount: 1, periodKey: '2026-08-01' }, idempotencyKey: 'r' });
    });
    await withTenant(t.workspaceId, async (tx) => {
      expect(await expirePeriod(tx, ctx, '2026-08-01')).toBe(1);
      expect(await available(tx, 'creative_test')).toBe(0);
      await settle(tx, ctx, auth.authorizationId, 'released');
      expect(await available(tx, 'creative_test')).toBe(0);
      expect((await periodUsage(tx, '2026-08-01')).remaining).toBe(0);
      // Idempotent: nothing more to expire.
      expect(await expirePeriod(tx, ctx, '2026-08-01')).toBe(0);
    });
  });

  it('kill switch stops production', async () => {
    const t = await makeTenant({ plan: 'GROWTH' });
    await ownerPool()`update feature_flags set enabled = true where key = 'kill.renders'`;
    await expect(
      withTenant(t.workspaceId, (tx) =>
        authorize(tx, ctxFor(t.workspaceId, t.userId), { purpose: 'repair', lines: [{ kind: 'image', provider: 'byteplus', model: 'seedream-5-0-pro', images: 1 }], idempotencyKey: 'k' }),
      ),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });

  it('sweeper releases stranded reservations', async () => {
    const t = await makeTenant({ plan: 'GROWTH' });
    const ctx = ctxFor(t.workspaceId, t.userId);
    await withTenant(t.workspaceId, async (tx) => {
      await append(tx, ctx, { type: 'CREDIT_GRANTED', unit: 'creative_test', amount: 1, idempotencyKey: 'g' });
      await authorize(tx, ctx, { purpose: 'repair', lines: [{ kind: 'image', provider: 'byteplus', model: 'seedream-5-0-pro', images: 1 }], entitlement: { unit: 'creative_test', amount: 1 }, idempotencyKey: 'z', ttlMinutes: 0 });
    });
    const { withSystem } = await import('@arkiv/db');
    expect(await withSystem((tx) => sweepExpiredAuthorizations(tx))).toBe(1);
    expect(await withTenant(t.workspaceId, (tx) => available(tx, 'creative_test'))).toBe(1);
  });
});

describe('model gateway', () => {
  it('refuses provider calls without a valid authorization', async () => {
    const t = await makeTenant();
    const ctx = ctxFor(t.workspaceId, t.userId);
    await expect(
      llmJson({ ctx, token: 'forged', task: 'extract.product_facts', system: 's', content: [{ type: 'text', text: 'x' }], schema: z.object({ a: z.string() }), mock: () => ({ a: 'b' }) }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('records the provider job, actual cost and credits back the unused estimate', async () => {
    const t = await makeTenant();
    const ctx = ctxFor(t.workspaceId, t.userId);
    const auth = await withTenant(t.workspaceId, (tx) =>
      authorize(tx, ctx, { purpose: 'storyboard', lines: [{ kind: 'llm', provider: 'anthropic', model: 'claude-opus-5-5', inputTokens: 20_000, outputTokens: 8_000 }], idempotencyKey: 'g1' }),
    );
    const r = await llmJson({ ctx, token: auth.token, task: 'extract.product_facts', system: 'sys', content: [{ type: 'text', text: 'hello' }], schema: z.object({ a: z.string() }), mock: () => ({ a: 'ok' }) });
    expect(r.data.a).toBe('ok');
    await withTenant(t.workspaceId, async (tx) => {
      const [job] = await tx`select * from provider_jobs where id = ${r.jobId}`;
      expect(job!.status).toBe('succeeded');
      expect(job!.prompt_version).toBe('extract-product@1.2.0');
      const [a] = await tx`select spent_micros from cost_authorizations where id = ${auth.authorizationId}`;
      expect(Number(a!.spent_micros)).toBe(Number(job!.actual_micros));
      const [c] = await tx`select sum(amount)::bigint as n from ledger_entries where type = 'PROVIDER_COST_RECORDED'`;
      expect(Number(c!.n)).toBe(Number(job!.actual_micros));
    });
  });

  it('a consumed authorization cannot exceed its ceiling', async () => {
    const t = await makeTenant();
    const ctx = ctxFor(t.workspaceId, t.userId);
    const auth = await withTenant(t.workspaceId, (tx) =>
      authorize(tx, ctx, { purpose: 'storyboard', lines: [{ kind: 'image', provider: 'byteplus', model: 'seedream-5-0-pro', images: 1 }], idempotencyKey: 'c1' }),
    );
    await withTenant(t.workspaceId, (tx) => consumeAuthorization(tx, auth.token, usd(0.045)));
    await expect(withTenant(t.workspaceId, (tx) => consumeAuthorization(tx, auth.token, usd(0.045)))).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('idempotency', () => {
  it('replays the stored result and rejects a different request with the same key', async () => {
    const t = await makeTenant();
    let calls = 0;
    const run = (body: unknown) => withTenant(t.workspaceId, (tx) => idempotent(tx, t.workspaceId, 'op', 'k1', body, async () => ({ n: ++calls })));
    expect((await run({ a: 1 })).result).toEqual({ n: 1 });
    const again = await run({ a: 1 });
    expect(again.replayed).toBe(true);
    expect(again.result).toEqual({ n: 1 });
    await expect(run({ a: 2 })).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});

describe('offers (standard §5)', () => {
  it('issues the Taste offer once, never reissues after expiry, and falls back to the real $29', async () => {
    const t = await makeTenant();
    const ctx = ctxFor(t.workspaceId, t.userId, 'OWNER', 'ACTIVE_FREE');
    const q1 = await withTenant(t.workspaceId, (tx) => issueTasteOffer(tx, ctx, t.workspaceId));
    expect(q1.priceMicros).toBe(usd(19));
    expect(q1.referencePriceMicros).toBe(usd(29));
    const q2 = await withTenant(t.workspaceId, (tx) => issueTasteOffer(tx, ctx, t.workspaceId));
    expect(q2.expiresAt).toBe(q1.expiresAt); // refresh / second device: same clock
    await ownerPool()`update offers set expires_at = now() - interval '1 minute'`;
    const q3 = await withTenant(t.workspaceId, (tx) => issueTasteOffer(tx, ctx, t.workspaceId));
    expect(q3.status).toBe('expired');
    const now = await withTenant(t.workspaceId, (tx) => currentQuote(tx));
    expect(now.kind).toBe('standalone');
    expect(now.priceMicros).toBe(usd(29));
  });

  it('checkout session honours Stripe 30-minute minimum without extending the offer', () => {
    const now = new Date('2026-09-23T12:00:00Z');
    const nearExpiry = { kind: 'taste' as const, offerId: 'o', priceMicros: 1, referencePriceMicros: null, expiresAt: '2026-09-23T12:05:00Z', status: 'active' as const, bonus: {} };
    expect(checkoutSessionExpiry(nearExpiry, now).getTime()).toBeGreaterThan(now.getTime() + 30 * 60_000);
  });
});

describe('workspaces & members (plan 02 §2.1, §5)', () => {
  it('claims a provisional workspace and keeps the work', async () => {
    const { workspaceId, token } = await createProvisionalWorkspace();
    expect(await resolveProvisional(token)).toBe(workspaceId);
    const [u] = await ownerPool()`insert into users (email) values ('founder@glowlab.com') returning id`;
    await claimProvisional(workspaceId, u!.id as string);
    expect(await resolveProvisional(token)).toBeNull();
    const [w] = await ownerPool()`select state, slug from workspaces where id = ${workspaceId}`;
    expect(w!.state).toBe('ACTIVE_FREE');
    expect(w!.slug).toBe('glowlab');
  });

  it('never leaves a workspace without an owner (M1) and enforces role ranks', async () => {
    const t = await makeTenant();
    const owner = ctxFor(t.workspaceId, t.userId);
    await expect(withTenant(t.workspaceId, (tx) => changeRole(tx, owner, t.userId, 'ADMIN'))).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(withTenant(t.workspaceId, (tx) => removeMember(tx, owner, t.userId))).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('invite acceptance refuses a mismatched account (M4) and single-use tokens', async () => {
    const t = await makeTenant({ plan: 'GROWTH' });
    const owner = ctxFor(t.workspaceId, t.userId);
    const { token } = await withTenant(t.workspaceId, (tx) => inviteMember(tx, owner, 'anna@brand.com', 'MEMBER'));
    const [anna] = await ownerPool()`insert into users (email) values ('anna@brand.com') returning id`;
    const [bob] = await ownerPool()`insert into users (email) values ('bob@brand.com') returning id`;
    await expect(acceptInvite(token, { id: bob!.id as string, email: 'bob@brand.com' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await acceptInvite(token, { id: anna!.id as string, email: 'anna@brand.com' });
    await expect(acceptInvite(token, { id: anna!.id as string, email: 'anna@brand.com' })).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('enforces the member limit of the plan', async () => {
    const t = await makeTenant(); // free: 2 members
    const owner = ctxFor(t.workspaceId, t.userId, 'OWNER', 'ACTIVE_FREE');
    await withTenant(t.workspaceId, (tx) => inviteMember(tx, owner, 'a@x.com', 'MEMBER'));
    await expect(withTenant(t.workspaceId, (tx) => inviteMember(tx, owner, 'b@x.com', 'MEMBER'))).rejects.toMatchObject({ code: 'PAYMENT_REQUIRED' });
    // Re-inviting the same address replaces its invite instead of counting twice.
    await withTenant(t.workspaceId, (tx) => inviteMember(tx, owner, 'a@x.com', 'ADMIN'));
    const [n] = await ownerPool()`select count(*)::int as n from invites where workspace_id = ${t.workspaceId} and accepted_at is null and revoked_at is null`;
    expect(n!.n).toBe(1);
  });

  it('concurrent invites at limit − 1 admit exactly one, and two invites to one address leave one live (x-races-09)', async () => {
    const t = await makeTenant(); // free: 2 members, the owner is one
    const owner = ctxFor(t.workspaceId, t.userId, 'OWNER', 'ACTIVE_FREE');
    const results = await Promise.allSettled(['c1@x.com', 'c2@x.com', 'c3@x.com'].map((e) => withTenant(t.workspaceId, (tx) => inviteMember(tx, owner, e, 'MEMBER'))));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected').map((r) => (r as PromiseRejectedResult).reason.code)).toEqual(['PAYMENT_REQUIRED', 'PAYMENT_REQUIRED']);

    const g = await makeTenant({ plan: 'GROWTH' });
    const gOwner = ctxFor(g.workspaceId, g.userId);
    await Promise.allSettled(Array.from({ length: 4 }, () => withTenant(g.workspaceId, (tx) => inviteMember(tx, gOwner, 'same@x.com', 'MEMBER'))));
    const [live] = await ownerPool()`select count(*)::int as n from invites where workspace_id = ${g.workspaceId} and email = 'same@x.com' and accepted_at is null and revoked_at is null`;
    expect(live!.n).toBe(1);
  });

  it('accepting an invite re-checks the member limit (e.g. after a downgrade) and leaves the invite open', async () => {
    const t = await makeTenant({ plan: 'GROWTH' });
    const owner = ctxFor(t.workspaceId, t.userId);
    const { token } = await withTenant(t.workspaceId, (tx) => inviteMember(tx, owner, 'late@x.com', 'MEMBER'));
    // Downgrade to free (2 members) and fill the second seat.
    const [other] = await ownerPool()`insert into users (email) values ('other@x.com') returning id`;
    await ownerPool()`update workspaces set plan_code = null where id = ${t.workspaceId}`;
    await ownerPool()`insert into memberships (workspace_id, user_id, role) values (${t.workspaceId}, ${other!.id}, 'MEMBER')`;
    const [late] = await ownerPool()`insert into users (email) values ('late@x.com') returning id`;
    await expect(acceptInvite(token, { id: late!.id as string, email: 'late@x.com' })).rejects.toMatchObject({ code: 'PAYMENT_REQUIRED' });
    const [inv] = await ownerPool()`select accepted_at from invites where email = 'late@x.com'`;
    expect(inv!.accepted_at).toBeNull();
    // After an upgrade the same invite works.
    await ownerPool()`update workspaces set plan_code = 'GROWTH' where id = ${t.workspaceId}`;
    expect(await acceptInvite(token, { id: late!.id as string, email: 'late@x.com' })).toBe(t.workspaceId);
  });

  it('two Owners demoting or removing each other concurrently never leave the workspace without an Owner (x-races-10)', async () => {
    for (const op of ['demote', 'remove'] as const) {
      const t = await makeTenant({ plan: 'GROWTH' });
      const [b] = await ownerPool()`insert into users (email) values (${`b-${op}@x.com`}) returning id`;
      await ownerPool()`insert into memberships (workspace_id, user_id, role) values (${t.workspaceId}, ${b!.id}, 'OWNER')`;
      const a = ctxFor(t.workspaceId, t.userId);
      const bc = ctxFor(t.workspaceId, b!.id as string);
      const run = (actor: TenantContext, target: string) =>
        withTenant(t.workspaceId, (tx) => (op === 'demote' ? changeRole(tx, actor, target, 'ADMIN') : removeMember(tx, actor, target)));
      const results = await Promise.allSettled([run(a, b!.id as string), run(bc, t.userId)]);
      expect(results.filter((r) => r.status === 'rejected').map((r) => (r as PromiseRejectedResult).reason.code)).toEqual(['CONFLICT']);
      const [o] = await ownerPool()`select count(*)::int as n from memberships where workspace_id = ${t.workspaceId} and role = 'OWNER'`;
      expect(o!.n).toBe(1);
    }
  });

  it('a transfer to a member removed at the same moment fails without demoting the Owner (x-races-10)', async () => {
    const t = await makeTenant({ plan: 'GROWTH' });
    const [adm] = await ownerPool()`insert into users (email) values ('admin@x.com') returning id`;
    const [m] = await ownerPool()`insert into users (email) values ('member@x.com') returning id`;
    await ownerPool()`insert into memberships (workspace_id, user_id, role) values (${t.workspaceId}, ${adm!.id}, 'ADMIN'), (${t.workspaceId}, ${m!.id}, 'MEMBER')`;
    const owner = ctxFor(t.workspaceId, t.userId);
    const admin = ctxFor(t.workspaceId, adm!.id as string, 'ADMIN');
    await Promise.allSettled([
      withTenant(t.workspaceId, (tx) => removeMember(tx, admin, m!.id as string)),
      withTenant(t.workspaceId, (tx) => transferOwnership(tx, owner, m!.id as string)),
    ]);
    const owners = await ownerPool()`select user_id from memberships where workspace_id = ${t.workspaceId} and role = 'OWNER'`;
    expect(owners.length).toBeGreaterThanOrEqual(1);
    const [me] = await ownerPool()`select role from memberships where workspace_id = ${t.workspaceId} and user_id = ${t.userId}`;
    const [still] = await ownerPool()`select role from memberships where workspace_id = ${t.workspaceId} and user_id = ${m!.id}`;
    // Either the transfer won (member became Owner, then was an Owner the Admin may not remove) or the removal won
    // (the transfer found no member and the original Owner kept the role).
    if (still) expect([still.role, me!.role]).toEqual(['OWNER', 'ADMIN']);
    else expect(me!.role).toBe('OWNER');
  });
});
