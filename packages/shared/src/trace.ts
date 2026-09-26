import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { logContext, logger, serializeError, withLogContext } from './log';

/**
 * Traces (plan 06 Phase 0 D10 "OpenTelemetry traces, error tracking"; decision log: OpenTelemetry → Grafana Cloud).
 * A small, dependency-free tracer that speaks OTLP/HTTP JSON: spans nest through AsyncLocalStorage, every log line
 * inside a span carries its `traceId`/`spanId` (so logs and traces join), and finished spans are batched to
 * `${OTEL_EXPORTER_OTLP_ENDPOINT}/v1/traces` when that is set (headers from OTEL_EXPORTER_OTLP_HEADERS, "k=v,k2=v2").
 * Without an endpoint nothing is exported — spans still give log lines their trace ids. Server-only.
 */

export type SpanKind = 'internal' | 'server' | 'client' | 'consumer';
type AttrValue = string | number | boolean | null | undefined;

export interface Span {
  readonly traceId: string;
  readonly spanId: string;
  setAttribute(key: string, value: AttrValue): void;
  recordException(e: unknown): void;
}

interface SpanRecord {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: SpanKind;
  start: bigint;
  end?: bigint;
  attributes: Record<string, AttrValue>;
  events: { name: string; time: bigint; attributes: Record<string, AttrValue> }[];
  error: string | null;
}

const current = new AsyncLocalStorage<SpanRecord>();
const hex = (bytes: number) => randomBytes(bytes).toString('hex');
// Wall-clock nanoseconds from a monotonic clock anchored once at load (span ends never precede their starts).
const ORIGIN = BigInt(Date.now()) * 1_000_000n - process.hrtime.bigint();
const nowNs = () => ORIGIN + process.hrtime.bigint();
const KIND: Record<SpanKind, number> = { internal: 1, server: 2, client: 3, consumer: 5 };

let SERVICE = process.env.OTEL_SERVICE_NAME ?? process.env.ARKIV_SERVICE ?? 'arkiv';
/** Service name on exported spans ('web', 'admin', 'worker'). */
export function setTraceService(name: string): void {
  if (!process.env.OTEL_SERVICE_NAME) SERVICE = `arkiv-${name}`;
}

const handle = (r: SpanRecord): Span => ({
  traceId: r.traceId,
  spanId: r.spanId,
  setAttribute: (k, v) => void (r.attributes[k] = v),
  recordException: (e) => {
    const s = serializeError(e);
    r.events.push({ name: 'exception', time: nowNs(), attributes: { 'exception.type': String(s.name ?? 'Error'), 'exception.message': String(s.message ?? '') } });
    r.error = String(s.message ?? 'error');
  },
});

/** The span the caller runs in, if any. */
export function activeSpan(): Span | null {
  const r = current.getStore();
  return r ? handle(r) : null;
}

/**
 * Run `fn` in a new span (a child of the current one, or a new trace). The span ends when `fn` settles; a throw
 * marks it as an error (with the exception recorded) and is rethrown. Log lines inside carry the trace ids.
 */
export async function withSpan<T>(name: string, attributes: Record<string, AttrValue>, fn: (span: Span) => Promise<T>, opts: { kind?: SpanKind } = {}): Promise<T> {
  const parent = current.getStore();
  const r: SpanRecord = {
    traceId: parent?.traceId ?? hex(16),
    spanId: hex(8),
    parentSpanId: parent?.spanId,
    name,
    kind: opts.kind ?? 'internal',
    start: nowNs(),
    attributes: { ...attributes },
    events: [],
    error: null,
  };
  const span = handle(r);
  return current.run(r, () =>
    withLogContext({ traceId: r.traceId, spanId: r.spanId }, async () => {
      try {
        return await fn(span);
      } catch (e) {
        span.recordException(e);
        throw e;
      } finally {
        r.end = nowNs();
        exportSpan(r);
      }
    }),
  );
}

// ───────────── Error tracking ─────────────

const errorLog = logger('errors');

/**
 * Report an unexpected error (not a DomainError the caller answers): one structured error line with the current
 * request/job ids and trace ids, and an exception on the active span — or, outside any span, a one-off error span —
 * so it reaches the trace backend's error views.
 */
export function reportError(e: unknown, fields: Record<string, unknown> = {}): void {
  const { msg, ...rest } = fields;
  errorLog.error(msg ? String(msg) : 'unhandled error', { ...rest, err: e });
  const span = activeSpan();
  if (span) {
    span.recordException(e);
    return;
  }
  const t = nowNs();
  const r: SpanRecord = { traceId: hex(16), spanId: hex(8), name: 'error', kind: 'internal', start: t, end: t, attributes: { ...pick(logContext()) }, events: [], error: null };
  handle(r).recordException(e);
  exportSpan(r);
}

const pick = (b: Record<string, unknown>) => Object.fromEntries(Object.entries(b).filter(([, v]) => ['string', 'number', 'boolean'].includes(typeof v))) as Record<string, AttrValue>;

// ───────────── OTLP/HTTP JSON export ─────────────

const buffer: SpanRecord[] = [];
let timer: NodeJS.Timeout | null = null;
let warned = false;
const MAX_BATCH = 100;

function endpoint(): string | null {
  const e = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? (process.env.OTEL_EXPORTER_OTLP_ENDPOINT ? `${process.env.OTEL_EXPORTER_OTLP_ENDPOINT.replace(/\/$/, '')}/v1/traces` : null);
  return e || null;
}

function exportSpan(r: SpanRecord) {
  if (!endpoint()) return;
  buffer.push(r);
  if (buffer.length >= MAX_BATCH) void flushTraces();
  else if (!timer) {
    timer = setTimeout(() => void flushTraces(), 5000);
    timer.unref?.();
  }
}

const attr = (k: string, v: AttrValue) => ({
  key: k,
  value: typeof v === 'number' ? (Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v }) : typeof v === 'boolean' ? { boolValue: v } : { stringValue: String(v ?? '') },
});

/** The OTLP/HTTP JSON body for a batch of spans (exported for tests). */
export function otlpBody(spans: readonly SpanRecord[], service = SERVICE) {
  return {
    resourceSpans: [
      {
        resource: { attributes: [attr('service.name', service), attr('deployment.environment', process.env.APP_ENV ?? process.env.NODE_ENV ?? 'dev')] },
        scopeSpans: [
          {
            scope: { name: 'arkiv' },
            spans: spans.map((s) => ({
              traceId: s.traceId,
              spanId: s.spanId,
              ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
              name: s.name,
              kind: KIND[s.kind],
              startTimeUnixNano: s.start.toString(),
              endTimeUnixNano: (s.end ?? s.start).toString(),
              attributes: Object.entries(s.attributes).filter(([, v]) => v !== undefined).map(([k, v]) => attr(k, v)),
              events: s.events.map((e) => ({ name: e.name, timeUnixNano: e.time.toString(), attributes: Object.entries(e.attributes).map(([k, v]) => attr(k, v)) })),
              status: s.error ? { code: 2, message: s.error.slice(0, 300) } : { code: 1 },
            })),
          },
        ],
      },
    ],
  };
}

function headers(): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  for (const pair of (process.env.OTEL_EXPORTER_OTLP_HEADERS ?? '').split(',')) {
    const i = pair.indexOf('=');
    if (i > 0) h[pair.slice(0, i).trim()] = decodeURIComponent(pair.slice(i + 1).trim());
  }
  return h;
}

/** Send what is buffered (also called at shutdown). Export failures never affect the caller. */
export async function flushTraces(): Promise<number> {
  if (timer) clearTimeout(timer);
  timer = null;
  const url = endpoint();
  const batch = buffer.splice(0, buffer.length);
  if (!url || !batch.length) return 0;
  try {
    const res = await fetch(url, { method: 'POST', headers: headers(), body: JSON.stringify(otlpBody(batch)), signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`OTLP export answered ${res.status}`);
  } catch (e) {
    if (!warned) logger('trace').warn('trace export failed', { err: e });
    warned = true;
    return 0;
  }
  return batch.length;
}
