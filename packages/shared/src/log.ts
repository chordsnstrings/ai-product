import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Structured logs (standard §34 Observability: "Every job joins workspace/SKU/experiment/generation IDs").
 * One JSON object per line on stdout/stderr, with the domain ids of the request or job it belongs to.
 *
 * The ids travel implicitly: a request (web route) or job (worker) opens a log context, and everything logged
 * inside it — including enqueues, which copy the request id into the job payload — carries the same
 * `requestId`, so an HTTP request, the jobs it created and their provider calls can be joined in the log store.
 * Server-only (node:async_hooks): import from '@arkiv/shared/log', never from client code.
 */

export interface LogBindings {
  requestId?: string;
  jobId?: string;
  queue?: string;
  workspaceId?: string;
  skuId?: string;
  projectId?: string;
  experimentId?: string;
  storyboardId?: string;
  integrationId?: string;
  providerJobId?: string;
  [key: string]: unknown;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const RANK: Record<LogLevel | 'silent', number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

const store = new AsyncLocalStorage<LogBindings>();

/** Run `fn` with these bindings added to the current log context (nested contexts inherit). */
export function withLogContext<T>(bindings: LogBindings, fn: () => T): T {
  return store.run({ ...(store.getStore() ?? {}), ...clean(bindings) }, fn);
}

/** Add bindings to the current context in place (e.g. once a job's workspace is known). */
export function bindLogContext(bindings: LogBindings): void {
  const s = store.getStore();
  if (s) Object.assign(s, clean(bindings));
}

export function logContext(): LogBindings {
  return store.getStore() ?? {};
}

/** The request id of the current request or job (propagated into the jobs it enqueues). */
export function currentRequestId(): string | undefined {
  return store.getStore()?.requestId;
}

/** Domain ids a job payload carries, as log bindings. */
export function payloadBindings(payload: Record<string, unknown> | null | undefined): LogBindings {
  const p = payload ?? {};
  const pick = (k: string) => (typeof p[k] === 'string' ? (p[k] as string) : undefined);
  return clean({
    requestId: pick('requestId'),
    workspaceId: pick('workspaceId'),
    skuId: pick('skuId'),
    projectId: pick('projectId'),
    experimentId: pick('experimentId'),
    storyboardId: pick('storyboardId'),
    integrationId: pick('integrationId'),
  });
}

function clean(b: LogBindings): LogBindings {
  const out: LogBindings = {};
  for (const [k, v] of Object.entries(b)) if (v !== undefined && v !== null && v !== '') out[k] = v;
  return out;
}

function threshold(): number {
  const l = (process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'test' ? 'error' : 'info')) as LogLevel | 'silent';
  return RANK[l] ?? RANK.info;
}

export function serializeError(e: unknown): Record<string, unknown> {
  if (e instanceof Error) {
    const code = (e as { code?: unknown }).code;
    return { name: e.name, message: e.message, ...(code ? { code } : {}), ...(process.env.NODE_ENV === 'production' ? {} : { stack: e.stack?.split('\n').slice(0, 6).join('\n') }) };
  }
  return { message: String(e) };
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(bindings: LogBindings): Logger;
}

let SERVICE = process.env.ARKIV_SERVICE ?? 'arkiv';
/** Name of this process in every line ('web', 'admin', 'worker'); set once at startup. */
export function setLogService(name: string): void {
  SERVICE = name;
}

/** A logger for one component (e.g. 'jobs', 'gateway', 'api'); every line gets the current context's ids. */
export function logger(component: string, base: LogBindings = {}): Logger {
  const write = (level: LogLevel, msg: string, fields: Record<string, unknown> = {}) => {
    if (RANK[level] < threshold()) return;
    const { err, ...rest } = fields as { err?: unknown };
    const line = JSON.stringify({ ts: new Date().toISOString(), level, service: SERVICE, component, msg, ...logContext(), ...base, ...rest, ...(err !== undefined ? { err: serializeError(err) } : {}) });
    (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
  };
  return {
    debug: (m, f) => write('debug', m, f),
    info: (m, f) => write('info', m, f),
    warn: (m, f) => write('warn', m, f),
    error: (m, f) => write('error', m, f),
    child: (b) => logger(component, { ...base, ...clean(b) }),
  };
}
