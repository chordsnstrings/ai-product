import { z } from 'zod';
import type { Tx } from '@arkiv/db';
import { COST_LIMITS, DomainError, PLANS, type Micros, type PlanCode } from '@arkiv/shared';

/**
 * Provider rate tables (§6, plan 05 §9). The Cost Governor always uses the latest *published* version in
 * effect — never hard-coded prices — and records which version each authorization used.
 */
export interface RateTable {
  provider: string;
  model: string;
  version: number;
  unit: string;
  rates: Record<string, number>;
}

export type CostLine =
  | { kind: 'llm'; provider: string; model: string; inputTokens: number; outputTokens: number; cachedTokens?: number }
  | { kind: 'image'; provider: string; model: string; images: number }
  | { kind: 'video'; provider: string; model: string; seconds: number; resolution: '720p' | '1080p'; retryReserve?: boolean; videoInputSeconds?: number }
  | { kind: 'tts'; provider: string; model: string; chars: number }
  | { kind: 'media'; outputs: number };

export interface Estimate {
  lines: { line: CostLine; micros: Micros; rateVersion: string }[];
  totalMicros: Micros;
  rateVersions: Record<string, number>;
}

// ───────────── Rate table contract (plan 05 §9; what priceLine reads) ─────────────

/** Canonical units, one per cost family; the seeds and the console editor use exactly these. */
export const RATE_UNITS = ['per_million_tokens', 'per_image', 'per_second', 'per_million_chars', 'per_output'] as const;
export type RateUnit = (typeof RATE_UNITS)[number];
/** Providers a rate table can be for ('internal' is our own media pipeline). */
export const RATE_PROVIDERS = ['anthropic', 'byteplus', 'minimax', 'internal'] as const;

const micros = z.number().int('Rates are whole micros (1 USD = 1,000,000)').nonnegative().finite();
/**
 * The keys priceLine reads per family, in micros: LLM per million tokens, image per image, video per second by
 * resolution, TTS per million characters, media per output. Extra numeric keys (reference prices) are kept.
 */
export const RATE_SCHEMAS: Record<RateUnit, z.ZodType<Record<string, number>>> = {
  per_million_tokens: z.object({ input: micros, output: micros, cache_read: micros.optional() }).catchall(micros),
  per_image: z.object({ image: micros }).catchall(micros),
  // Optional token prices (per million) price a request carrying reference video at the provider's video-input
  // rate (§6: "actual requested modality"); without them such a request is priced at the per-second rate.
  per_second: z.object({ per_second_720p: micros, per_second_1080p: micros, per_million_tokens: micros.optional(), per_million_tokens_video_input: micros.optional() }).catchall(micros),
  per_million_chars: z.object({ char_million: micros }).catchall(micros),
  per_output: z.object({ transcode_storage_delivery: micros, buffer: micros }).catchall(micros),
};

/** A template draft for a unit, for the editor to prefill when there is no version to start from. */
export const RATE_TEMPLATES: Record<RateUnit, Record<string, number>> = {
  per_million_tokens: { input: 0, output: 0, cache_read: 0 },
  per_image: { image: 0 },
  per_second: { per_second_720p: 0, per_second_1080p: 0 },
  per_million_chars: { char_million: 0 },
  per_output: { transcode_storage_delivery: 0, buffer: 0 },
};

/**
 * Check a proposed rate table against what the Cost Governor will read (plan 05 §9): a canonical unit, the keys
 * for its family, whole non-negative micros, and 'internal' only for the media pipeline. Throws INVALID with what
 * to fix; returns the rates as they will be stored.
 */
export function validateRateTable(t: { provider: string; model: string; unit: string; rates: unknown }): Record<string, number> {
  if (!(RATE_PROVIDERS as readonly string[]).includes(t.provider)) throw new DomainError('INVALID', `Unknown provider ${t.provider}.`);
  if (!(RATE_UNITS as readonly string[]).includes(t.unit)) throw new DomainError('INVALID', `Unit must be one of ${RATE_UNITS.join(', ')}.`);
  if ((t.provider === 'internal') !== (t.unit === 'per_output')) throw new DomainError('INVALID', 'The internal media pipeline is priced per output, and only it is.');
  if (t.provider === 'internal' && t.model !== 'media-pipeline') throw new DomainError('INVALID', 'The internal provider has one model: media-pipeline.');
  const r = RATE_SCHEMAS[t.unit as RateUnit].safeParse(t.rates);
  if (!r.success) throw new DomainError('INVALID', `Rates for ${t.unit}: ${r.error.issues.map((i) => `${i.path.join('.') || 'rates'} ${i.message}`).join('; ')}.`);
  const promo = r.data[PROMO_KEY];
  if (promo !== undefined && promo > 1_000_000) throw new DomainError('INVALID', `${PROMO_KEY} is the share of the list price actually paid, in parts per million (at most 1000000).`);
  return r.data;
}

export async function loadRates(tx: Tx): Promise<Map<string, RateTable>> {
  const rows = await tx`
    select distinct on (provider, model) provider, model, version, unit, rates
    from provider_rate_tables where status = 'published' and effective_from <= now()
    order by provider, model, version desc`;
  return new Map(rows.map((r) => [`${r.provider}/${r.model}`, r as unknown as RateTable]));
}

/**
 * Today's rates, with the given provider/model keys held at the versions an authorization was priced on (any
 * status: a superseded table still prices the promise it was part of). Keys not pinned use today's version.
 */
export async function loadRatesPinned(tx: Tx, pinned: Record<string, number>): Promise<Map<string, RateTable>> {
  const rates = await loadRates(tx);
  const keys = Object.entries(pinned).filter(([k, v]) => k.includes('/') && Number.isInteger(v));
  if (!keys.length) return rates;
  const rows = await tx`select t.provider, t.model, t.version, t.unit, t.rates from provider_rate_tables t
                        join unnest(${keys.map(([k]) => k)}::text[], ${keys.map(([, v]) => v)}::int[]) as p(k, v) on t.provider || '/' || t.model = p.k and t.version = p.v`;
  for (const r of rows) rates.set(`${r.provider}/${r.model}`, r as unknown as RateTable);
  return rates;
}

function rate(rates: Map<string, RateTable>, provider: string, model: string): RateTable {
  const r = rates.get(`${provider}/${model}`);
  if (!r) throw new DomainError('UNAVAILABLE', `No published rate table for ${provider}/${model}`);
  return r;
}

export function priceLine(rates: Map<string, RateTable>, line: CostLine): { micros: Micros; key: string; version: number } {
  switch (line.kind) {
    case 'llm': {
      const r = rate(rates, line.provider, line.model);
      const cached = line.cachedTokens ?? 0;
      const micros =
        ((line.inputTokens - cached) * r.rates.input! + cached * (r.rates.cache_read ?? r.rates.input!) +
          line.outputTokens * r.rates.output!) /
        1_000_000;
      return { micros: Math.ceil(micros), key: `${r.provider}/${r.model}`, version: r.version };
    }
    case 'image': {
      const r = rate(rates, line.provider, line.model);
      return { micros: line.images * r.rates.image!, key: `${r.provider}/${r.model}`, version: r.version };
    }
    case 'video': {
      const r = rate(rates, line.provider, line.model);
      const perSecond = line.resolution === '1080p' ? r.rates.per_second_1080p! : r.rates.per_second_720p!;
      const inputSeconds = Math.max(0, line.videoInputSeconds ?? 0);
      const tokenRate = r.rates.per_million_tokens;
      const videoInputRate = r.rates.per_million_tokens_video_input;
      // A request with reference video is billed per token at the video-input rate, for the output and the input
      // video alike; its tokens per second are those the per-second rate was derived from. Without token prices
      // the input video is priced like output seconds (never cheaper than the table says).
      const raw =
        inputSeconds > 0 && tokenRate && videoInputRate !== undefined
          ? ((line.seconds + inputSeconds) * perSecond * videoInputRate) / tokenRate
          : (line.seconds + inputSeconds) * perSecond;
      const reserve = line.retryReserve === false ? 0 : raw * COST_LIMITS.RETRY_RESERVE_FRACTION;
      return { micros: Math.ceil(raw + reserve), key: `${r.provider}/${r.model}`, version: r.version };
    }
    case 'tts': {
      const r = rate(rates, line.provider, line.model);
      return { micros: Math.ceil((line.chars * r.rates.char_million!) / 1_000_000), key: `${r.provider}/${r.model}`, version: r.version };
    }
    case 'media': {
      const r = rate(rates, 'internal', 'media-pipeline');
      return {
        micros: line.outputs * (r.rates.transcode_storage_delivery! + r.rates.buffer!),
        key: 'internal/media-pipeline',
        version: r.version,
      };
    }
  }
}

export function estimate(rates: Map<string, RateTable>, lines: CostLine[]): Estimate {
  const out: Estimate = { lines: [], totalMicros: 0, rateVersions: {} };
  for (const line of lines) {
    const p = priceLine(rates, line);
    // A table missing a key its family needs would price at NaN: refuse rather than authorise an unknown amount.
    if (!Number.isFinite(p.micros)) throw new DomainError('UNAVAILABLE', `Rate table ${p.key}@${p.version} can’t price a ${line.kind} line (missing or invalid rate).`);
    out.lines.push({ line, micros: p.micros, rateVersion: `${p.key}@${p.version}` });
    out.totalMicros += p.micros;
    out.rateVersions[p.key] = p.version;
  }
  return out;
}

/**
 * Retire published versions that a newer published version has superseded and that is already in effect.
 * Publishing never retires the current version itself: a scheduled version only replaces it at its
 * effective time, so pricing is never left without a published rate (plan 05 §9).
 */
export async function retireSupersededRates(tx: Tx): Promise<number> {
  const r = await tx`
    update provider_rate_tables r set status = 'retired'
    where r.status = 'published' and exists (
      select 1 from provider_rate_tables n
      where n.provider = r.provider and n.model = r.model and n.status = 'published'
        and n.effective_from <= now() and n.version > r.version)`;
  return r.count;
}

export interface RateDiff {
  key: string;
  before: number | null;
  after: number | null;
  /** Relative change (after / before − 1); null when the key is new or removed. */
  change: number | null;
}

/** Per-key diff of a draft against the version currently in effect (publish flow: "diff against current"). */
export function diffRates(before: Record<string, number> | null | undefined, after: Record<string, number>): RateDiff[] {
  const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after)])].sort();
  return keys
    .map((key) => {
      const b = before?.[key] ?? null;
      const a = after[key] ?? null;
      return { key, before: b, after: a, change: b !== null && a !== null && b !== 0 ? a / b - 1 : null };
    })
    .filter((d) => d.before !== d.after);
}

export interface PlanMarginImpact {
  plan: PlanCode;
  priceMicros: Micros;
  tests: number;
  cogsBeforeMicros: Micros;
  cogsAfterMicros: Micros;
  marginBefore: number;
  marginAfter: number;
  /** Variable COGS of a fully used plan still fits under its price. */
  viable: boolean;
}

/**
 * Impact preview: a plan's variable COGS if every included Creative Test is used, before and after a rate
 * change ("Standard 15s test estimate changes $5.49 → $6.10; 3 plans' margins affected").
 */
export function planMarginImpact(testBeforeMicros: Micros, testAfterMicros: Micros): PlanMarginImpact[] {
  return (Object.keys(PLANS) as PlanCode[]).map((plan) => {
    const p = PLANS[plan];
    const before = testBeforeMicros * p.creativeTestsPerMonth;
    const after = testAfterMicros * p.creativeTestsPerMonth;
    return {
      plan,
      priceMicros: p.priceMicros,
      tests: p.creativeTestsPerMonth,
      cogsBeforeMicros: before,
      cogsAfterMicros: after,
      marginBefore: (p.priceMicros - before) / p.priceMicros,
      marginAfter: (p.priceMicros - after) / p.priceMicros,
      viable: after <= p.priceMicros,
    };
  });
}

/**
 * Viability alert (plan 05 §9 edge case): a standard test estimate above the §5 ceiling means generative
 * production can no longer be authorised within budget, so the affected production modes should be paused.
 */
export function rateViability(testEstimateMicros: Micros): { ok: boolean; ceilingMicros: Micros; alert: string | null } {
  const ceiling = COST_LIMITS.CREATIVE_TEST_CEILING;
  if (!Number.isFinite(testEstimateMicros)) return { ok: false, ceilingMicros: ceiling, alert: 'The standard test can’t be priced with these rates (a model has no published rate).' };
  if (testEstimateMicros <= ceiling) return { ok: true, ceilingMicros: ceiling, alert: null };
  return {
    ok: false,
    ceilingMicros: ceiling,
    alert: 'The standard Creative Test estimate exceeds the $8.50 ceiling: productions using this model will be refused by the Cost Governor. Consider pausing generative scenes (kill.renders, or open the video.scene circuit so the planner falls back) until pricing is resolved.',
  };
}

/** Actual cost of a completed provider call (no retry reserve). */
/**
 * Promotional packages (§6): a rate table may say what share of its list price a prepaid package actually costs
 * (`promo_paid_ppm`, parts per million). Estimates and ceilings always use the list price — a promotion is never
 * needed for retail viability — while realized cost is the discounted amount and the difference is recorded as
 * savings.
 */
export const PROMO_KEY = 'promo_paid_ppm';

export function promoSplit(rates: Map<string, RateTable>, provider: string, model: string, listMicros: Micros): { realizedMicros: Micros; savingsMicros: Micros } {
  const ppm = rates.get(`${provider}/${model}`)?.rates[PROMO_KEY];
  if (ppm === undefined || !Number.isFinite(ppm) || ppm < 0 || ppm >= 1_000_000 || listMicros <= 0) return { realizedMicros: listMicros, savingsMicros: 0 };
  const realizedMicros = Math.ceil((listMicros * ppm) / 1_000_000);
  return { realizedMicros, savingsMicros: listMicros - realizedMicros };
}

export function actualCost(rates: Map<string, RateTable>, line: CostLine): Micros {
  return priceLine(rates, line.kind === 'video' ? { ...line, retryReserve: false } : line).micros;
}
