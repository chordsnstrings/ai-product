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
  | { kind: 'video'; provider: string; model: string; seconds: number; resolution: '720p' | '1080p'; retryReserve?: boolean }
  | { kind: 'tts'; provider: string; model: string; chars: number }
  | { kind: 'media'; outputs: number };

export interface Estimate {
  lines: { line: CostLine; micros: Micros; rateVersion: string }[];
  totalMicros: Micros;
  rateVersions: Record<string, number>;
}

export async function loadRates(tx: Tx): Promise<Map<string, RateTable>> {
  const rows = await tx`
    select distinct on (provider, model) provider, model, version, unit, rates
    from provider_rate_tables where status = 'published' and effective_from <= now()
    order by provider, model, version desc`;
  return new Map(rows.map((r) => [`${r.provider}/${r.model}`, r as unknown as RateTable]));
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
      const raw = line.seconds * perSecond;
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
export function actualCost(rates: Map<string, RateTable>, line: CostLine): Micros {
  return priceLine(rates, line.kind === 'video' ? { ...line, retryReserve: false } : line).micros;
}
