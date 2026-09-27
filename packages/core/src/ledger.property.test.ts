import { afterAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { closeAll, ownerPool, withSystem, withTenant } from '@arkiv/db';
import { makeTenant, truncateAll } from '@arkiv/db/testing';
import { DomainError } from '@arkiv/shared';
import { authorize, settle, sweepExpiredAuthorizations } from './cost-governor';
import { append, available } from './ledger';
import { ctxFor } from './testing';

/**
 * Entitlement math property test (plan 06 Phase 4 "entitlement math property tests"; standard §37, §51): any
 * sequence of grants, reservations, settlements (consumed / released / refunded, repeated) and expiry sweeps keeps
 * the balance non-negative, settles each reservation at most once, and conserves units:
 *   available = granted − reserved + released + refunded   (consumed units stay spent).
 */
afterAll(closeAll);

type Op =
  | { kind: 'grant'; amount: number }
  | { kind: 'reserve' }
  | { kind: 'settle'; pick: number; outcome: 'consumed' | 'released' | 'refunded' }
  | { kind: 'expire'; pick: number };

const op: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ kind: fc.constant('grant' as const), amount: fc.integer({ min: 1, max: 3 }) }),
  fc.record({ kind: fc.constant('reserve' as const) }),
  fc.record({ kind: fc.constant('settle' as const), pick: fc.nat(20), outcome: fc.constantFrom('consumed' as const, 'released' as const, 'refunded' as const) }),
  fc.record({ kind: fc.constant('expire' as const), pick: fc.nat(20) }),
);

const LINE = [{ kind: 'image' as const, provider: 'byteplus', model: 'seedream-5-0-pro', images: 1 }];

describe('entitlement ledger properties', () => {
  it('never negative, never double-settled, and units are conserved', async () => {
    let run = 0;
    let reservations = 0;
    let settlements = 0;
    await fc.assert(
      fc.asyncProperty(fc.array(op, { minLength: 1, maxLength: 14 }), async (ops) => {
        await truncateAll();
        const t = await makeTenant({ plan: 'GROWTH', state: 'ACTIVE_PAID' });
        const ctx = ctxFor(t.workspaceId, t.userId, 'OWNER', 'ACTIVE_PAID');
        const auths: string[] = [];
        let n = 0;
        run++;
        for (const o of ops) {
          if (o.kind === 'grant') {
            await withTenant(t.workspaceId, (tx) => append(tx, ctx, { type: 'CREDIT_GRANTED', unit: 'creative_test', amount: o.amount, idempotencyKey: `g:${run}:${n++}` }));
          } else if (o.kind === 'reserve') {
            try {
              const a = await withTenant(t.workspaceId, (tx) => authorize(tx, ctx, { purpose: 'storyboard', lines: LINE, entitlement: { unit: 'creative_test', amount: 1 }, idempotencyKey: `a:${run}:${n++}` }));
              auths.push(a.authorizationId);
            } catch (e) {
              // Not enough entitlement is the only acceptable refusal.
              if (!(e instanceof DomainError && e.code === 'PAYMENT_REQUIRED')) throw e;
            }
          } else if (o.kind === 'settle' && auths.length) {
            await withTenant(t.workspaceId, (tx) => settle(tx, ctx, auths[o.pick % auths.length]!, o.outcome));
          } else if (o.kind === 'expire' && auths.length) {
            await ownerPool()`update cost_authorizations set expires_at = now() - interval '1 minute' where id = ${auths[o.pick % auths.length]!}`;
            await withSystem((tx) => sweepExpiredAuthorizations(tx));
          }
          const bal = await withTenant(t.workspaceId, (tx) => available(tx, 'creative_test'));
          if (bal < 0) return false;
        }
        const rows = await ownerPool()`select type, sum(amount)::int as n, count(*)::int as c from ledger_entries where workspace_id = ${t.workspaceId} and unit = 'creative_test' group by type`;
        const sum = (type: string) => Number(rows.find((r) => r.type === type)?.n ?? 0);
        // Each reservation settles at most once (one terminal entry per authorization).
        const perAuth = await ownerPool()`select authorization_id, count(*)::int as n from ledger_entries where workspace_id = ${t.workspaceId}
                                           and type in ('CREDIT_CONSUMED','CREDIT_RELEASED','CREDIT_REFUNDED') group by 1`;
        if (perAuth.some((r) => Number(r.n) > 1)) return false;
        const bal = await withTenant(t.workspaceId, (tx) => available(tx, 'creative_test'));
        // Reservations are recorded as negative amounts (they draw on the balance).
        const reserved = Math.abs(sum('CREDIT_RESERVED'));
        reservations += reserved;
        settlements += perAuth.length;
        expect(bal).toBe(sum('CREDIT_GRANTED') - reserved + sum('CREDIT_RELEASED') + sum('CREDIT_REFUNDED'));
        // What is still held equals the reservations not yet settled.
        const [open] = await ownerPool()`select count(*)::int as n from cost_authorizations where workspace_id = ${t.workspaceId} and status = 'active'`;
        expect(reserved - Number(perAuth.length)).toBe(Number(open!.n));
        return true;
      }),
      { numRuns: 25, seed: 4242 },
    );
    // The generated sequences really exercised reservations and settlements.
    expect(reservations).toBeGreaterThan(10);
    expect(settlements).toBeGreaterThan(5);
  }, 180_000);
});
