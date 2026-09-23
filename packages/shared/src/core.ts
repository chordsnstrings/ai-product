import { uuidv7 } from 'uuidv7';

export const newId = (): string => uuidv7();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

/** Money is always integer micro-dollars internally (1 USD = 1_000_000) to keep provider costs exact. */
export type Micros = number;
export const usd = (dollars: number): Micros => Math.round(dollars * 1_000_000);
export const toUsd = (m: Micros): number => m / 1_000_000;
export const centsToMicros = (c: number): Micros => c * 10_000;
export const microsToCents = (m: Micros): number => Math.round(m / 10_000);
export const formatUsd = (m: Micros, digits = 2): string =>
  `$${toUsd(m).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;

/** Domain errors carry an HTTP-ish code so API layers can map them without leaking internals. */
export class DomainError extends Error {
  constructor(
    public readonly code:
      | 'NOT_FOUND'
      | 'FORBIDDEN'
      | 'CONFLICT'
      | 'INVALID'
      | 'RATE_LIMITED'
      | 'PAYMENT_REQUIRED'
      | 'GATE_BLOCKED'
      | 'UNAVAILABLE',
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}
export const notFound = (what = 'Not found') => new DomainError('NOT_FOUND', what);
export const forbidden = (what = 'Forbidden') => new DomainError('FORBIDDEN', what);
export const invalid = (what: string, details?: Record<string, unknown>) =>
  new DomainError('INVALID', what, details);
export const conflict = (what: string, details?: Record<string, unknown>) =>
  new DomainError('CONFLICT', what, details);

export const httpStatusFor = (e: DomainError): number =>
  ({
    NOT_FOUND: 404,
    FORBIDDEN: 403,
    CONFLICT: 409,
    INVALID: 422,
    RATE_LIMITED: 429,
    PAYMENT_REQUIRED: 402,
    GATE_BLOCKED: 422,
    UNAVAILABLE: 503,
  })[e.code];

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Deterministic, stable JSON for hashing (sorted keys). */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .filter((k) => o[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(',')}}`;
}
