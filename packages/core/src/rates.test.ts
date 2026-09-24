import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool, withSystem } from '@arkiv/db';
import { truncateAll } from '@arkiv/db/testing';
import { COST_LIMITS, newId, type StaffRole } from '@arkiv/shared';
import { decideApproval, requestOrExecute, type Staff } from './admin';
import { diffRates, estimate, loadRates, planMarginImpact, priceLine, promoSplit, RATE_TEMPLATES, RATE_UNITS, rateViability, retireSupersededRates, validateRateTable, type CostLine, type RateTable } from './rates';

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

  it('only accepts tables the Cost Governor can read, and every published seed passes', async () => {
    for (const t of await ownerPool()`select provider, model, unit, rates from provider_rate_tables where status = 'published'`) {
      expect(() => validateRateTable(t as never), `${t.provider}/${t.model}`).not.toThrow();
    }
    for (const u of RATE_UNITS) expect(() => validateRateTable({ provider: u === 'per_output' ? 'internal' : 'byteplus', model: u === 'per_output' ? 'media-pipeline' : 'm', unit: u, rates: RATE_TEMPLATES[u] })).not.toThrow();
    // USD instead of micros, the old editor's default keys for a video model, a made-up unit, a missing internal rate.
    expect(() => validateRateTable({ provider: 'anthropic', model: 'x', unit: 'per_million_tokens', rates: { input: 4.0, output: 20.5 } })).toThrow(/whole micros/);
    expect(() => validateRateTable({ provider: 'byteplus', model: 'dreamina-seedance-2-5', unit: 'per_second', rates: { input: 0, output: 0 } })).toThrow(/per_second_720p/);
    expect(() => validateRateTable({ provider: 'minimax', model: 'x', unit: 'per_kchar', rates: { char_million: 1 } })).toThrow(/Unit must be/);
    expect(() => validateRateTable({ provider: 'internal', model: 'media-pipeline', unit: 'per_output', rates: { buffer: 1 } })).toThrow(/transcode_storage_delivery/);
    expect(() => validateRateTable({ provider: 'anthropic', model: 'x', unit: 'per_output', rates: RATE_TEMPLATES.per_output })).toThrow(/internal media pipeline/);
    expect(() => validateRateTable({ provider: 'byteplus', model: 'x', unit: 'per_image', rates: { image: -1 } })).toThrow(/INVALID|image/);
  });

  it('publishing re-validates, and a table that can’t price a line is refused rather than priced at NaN', async () => {
    const [bad] = await ownerPool()`insert into provider_rate_tables (provider, model, version, unit, rates, effective_from, status)
                                    values ('byteplus', 'dreamina-seedance-2-5', 2, 'per_second', '{"input": 0, "output": 0}', now(), 'draft') returning id`;
    await expect(publish(bad!.id as string)).rejects.toMatchObject({ code: 'INVALID' });
    expect((await ownerPool()`select status from provider_rate_tables where id = ${bad!.id}`)[0]!.status).toBe('draft');

    // A valid draft, published through four-eyes, prices every kind of cost line.
    await publish(await draft(new Date(Date.now() - 60_000)));
    const rates = await withSystem((tx) => loadRates(tx));
    const lines: CostLine[] = [
      { kind: 'llm', provider: 'anthropic', model: 'claude-opus-5-5', inputTokens: 10_000, outputTokens: 2_000 },
      { kind: 'image', provider: 'byteplus', model: 'seedream-5-0-pro', images: 2 },
      { kind: 'video', provider: 'byteplus', model: 'dreamina-seedance-2-5', seconds: 4, resolution: '720p' },
      tts,
      { kind: 'media', outputs: 3 },
    ];
    const e = estimate(rates, lines);
    expect(e.lines.every((l) => Number.isFinite(l.micros) && l.micros > 0)).toBe(true);
    expect(e.rateVersions['minimax/speech-2.8-hd']).toBe(2);
    rates.set('byteplus/seedream-5-0-pro', { provider: 'byteplus', model: 'seedream-5-0-pro', version: 9, unit: 'per_image', rates: { input: 1 } });
    expect(() => estimate(rates, [lines[1]!])).toThrow(/can’t price a image line/);
  });
});

describe('modality and promotions (standard §6, biz-31)', () => {
  const seedance: RateTable = { provider: 'byteplus', model: 'dreamina-seedance-2-5', version: 1, unit: 'per_second', rates: { per_second_720p: 231333, per_second_1080p: 520500, per_million_tokens: 10_700_000, per_million_tokens_video_input: 6_400_000 } };
  const rates = new Map([['byteplus/dreamina-seedance-2-5', seedance]]);
  const video = (extra: Partial<Extract<CostLine, { kind: 'video' }>> = {}): CostLine => ({ kind: 'video', provider: 'byteplus', model: 'dreamina-seedance-2-5', seconds: 15, resolution: '720p', retryReserve: false, ...extra });

  it('prices a request with reference video at the video-input token rate, input seconds included', () => {
    expect(priceLine(rates, video()).micros).toBe(15 * 231333);
    // 15 s out + 5 s of input video, at $6.40 instead of $10.70 per million tokens.
    expect(priceLine(rates, video({ videoInputSeconds: 5 })).micros).toBe(Math.ceil((20 * 231333 * 6_400_000) / 10_700_000));
    // Without token prices the input video is priced like output seconds, never cheaper.
    const plain = new Map([['byteplus/dreamina-seedance-2-5', { ...seedance, rates: { per_second_720p: 231333, per_second_1080p: 520500 } }]]);
    expect(priceLine(plain, video({ videoInputSeconds: 5 })).micros).toBe(20 * 231333);
  });

  it('splits a promotional package into realized cost and savings; no promotion, no savings', () => {
    expect(promoSplit(rates, 'byteplus', 'dreamina-seedance-2-5', 1_000_000)).toEqual({ realizedMicros: 1_000_000, savingsMicros: 0 });
    const promo = new Map([['byteplus/dreamina-seedance-2-5', { ...seedance, rates: { ...seedance.rates, promo_paid_ppm: 555_556 } }]]);
    expect(promoSplit(promo, 'byteplus', 'dreamina-seedance-2-5', 1_000_000)).toEqual({ realizedMicros: 555_556, savingsMicros: 444_444 });
    // The estimate itself stays at list.
    expect(priceLine(promo, video()).micros).toBe(15 * 231333);
    expect(() => validateRateTable({ provider: 'byteplus', model: 'dreamina-seedance-2-5', unit: 'per_second', rates: { ...seedance.rates, promo_paid_ppm: 1_500_000 } })).toThrow(/parts per million/);
  });
});
