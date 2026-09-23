import type { Tx } from '@arkiv/db';
import { COST_LIMITS, DomainError, type Micros } from '@arkiv/shared';

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

/** Actual cost of a completed provider call (no retry reserve). */
export function actualCost(rates: Map<string, RateTable>, line: CostLine): Micros {
  return priceLine(rates, line.kind === 'video' ? { ...line, retryReserve: false } : line).micros;
}
