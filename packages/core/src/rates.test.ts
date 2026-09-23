import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool, withSystem } from '@arkiv/db';
import { truncateAll } from '@arkiv/db/testing';
import { COST_LIMITS, newId, type StaffRole } from '@arkiv/shared';
import { decideApproval, requestOrExecute, type Staff } from './admin';
import { diffRates, loadRates, planMarginImpact, priceLine, rateViability, retireSupersededRates } from './rates';

async function staff(roles: StaffRole[], name: string): Promise<Staff> {
  const id = newId();
  await ownerPool()`insert into staff_users (id, email, name, password_hash, roles) values (${id}, ${`${id.slice(-6)}@arkiv.test`}, ${name}, 'x', ${roles})`;
  return { staffId: id, email: `${id.slice(-6)}@arkiv.test`, name, roles };
}
/** Rate tables are reference data (kept across truncation): restore the seed after each test. */
async function restoreSeed() {
  await ownerPool()`delete from provider_rate_tables where version > 1`;
  await ownerPool()`update provider_rate_tables set status = 'published' where version = 1`;
}
async function draft(effectiveFrom: Date) {
  const [r] = await ownerPool()`insert into provider_rate_tables (provider, model, version, unit, rates, effective_from, status)
                                values ('minimax', 'speech-2.8-hd', 2, 'per_million_chars', '{"char_million": 120000000}', ${effectiveFrom}, 'draft') returning id`;
  return r!.id as string;
}
async function publish(id: string) {
  const a = await staff(['FINANCE'], 'Fin A');
  const b = await staff(['FINANCE'], 'Fin B');
  const r = await requestOrExecute(a, 'rates.publish', { rateTableId: id }, 'provider price notice');
  expect(r.status).toBe('pending'); // always four-eyes
  return decideApproval(b, (r as { approvalId: string }).approvalId, true);
}
const tts = { kind: 'tts' as const, provider: 'minimax', model: 'speech-2.8-hd', chars: 1_000_000 };
const statuses = () => ownerPool()`select version, status from provider_rate_tables where provider = 'minimax' and model = 'speech-2.8-hd' order by version`;

beforeEach(truncateAll);
afterEach(restoreSeed);
afterAll(closeAll);

describe('rate table publish (plan 05 §9)', () => {
  it('a scheduled version leaves the current one in effect until its time, then supersedes it', async () => {
    const id = await draft(new Date(Date.now() + 86400_000));
    await publish(id);
    // Regression: publishing retired v1 immediately while v2 wasn't effective yet, leaving no rate at all.
    expect(await statuses()).toEqual([{ version: 1, status: 'published' }, { version: 2, status: 'published' }]);
    const before = await withSystem(async (tx) => priceLine(await loadRates(tx), tts));
    expect(before).toMatchObject({ version: 1, micros: 100_000_000 });
    await ownerPool()`update provider_rate_tables set effective_from = now() - interval '1 minute' where id = ${id}`;
    const after = await withSystem(async (tx) => priceLine(await loadRates(tx), tts));
    expect(after).toMatchObject({ version: 2, micros: 120_000_000 });
    expect(await withSystem((tx) => retireSupersededRates(tx))).toBe(1);
    expect(await statuses()).toEqual([{ version: 1, status: 'retired' }, { version: 2, status: 'published' }]);
  });

  it('an immediate publish retires the previous version at once', async () => {
    await publish(await draft(new Date(Date.now() - 60_000)));
    expect(await statuses()).toEqual([{ version: 1, status: 'retired' }, { version: 2, status: 'published' }]);
  });

  it('previews the diff, plan margins and viability', () => {
    expect(diffRates({ input: 4, output: 20, cache_read: 1 }, { input: 5, output: 20, batch: 2 })).toEqual([
      { key: 'batch', before: null, after: 2, change: null },
      { key: 'cache_read', before: 1, after: null, change: null },
      { key: 'input', before: 4, after: 5, change: 0.25 },
    ]);
    const m = planMarginImpact(5_490_000, 6_100_000);
    expect(m.map((x) => x.plan)).toEqual(['LAUNCH', 'GROWTH', 'SCALE']);
    const growth = m.find((x) => x.plan === 'GROWTH')!;
    expect(growth.cogsBeforeMicros).toBe(5_490_000 * 7);
    expect(growth.cogsAfterMicros).toBe(6_100_000 * 7);
    expect(growth.marginAfter).toBeLessThan(growth.marginBefore);
    expect(rateViability(COST_LIMITS.CREATIVE_TEST_CEILING).ok).toBe(true);
    expect(rateViability(COST_LIMITS.CREATIVE_TEST_CEILING + 1).alert).toMatch(/pausing generative scenes/);
    expect(rateViability(Number.NaN).ok).toBe(false);
  });
});
