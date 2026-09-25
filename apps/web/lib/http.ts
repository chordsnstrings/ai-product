import { NextResponse } from 'next/server';
import type { z } from 'zod';
import { globalTx, type Tx } from '@arkiv/db';
import { idempotent, isFlagOn, type ClientFingerprint } from '@arkiv/core';
import { DomainError, env, httpStatusFor } from '@arkiv/shared';
import { currentRequestId, setLogService, withLogContext } from '@arkiv/shared/log';
import { reportError, setTraceService, withSpan } from '@arkiv/shared/trace';

setLogService('web');
setTraceService('web');

/** A caller-supplied request id is kept only when it looks like one (it ends up in logs and responses). */
export function requestIdFrom(req: Request): string {
  const h = req.headers.get('x-request-id');
  return h && /^[A-Za-z0-9._-]{8,64}$/.test(h) ? h : crypto.randomUUID();
}

/** Kill switch `kill.read_only` (plan 05 §20), cached for 5s so it costs ~nothing per request. */
let roCache: { at: number; on: boolean } | null = null;
async function readOnly() {
  if (roCache && Date.now() - roCache.at < 5000) return roCache.on;
  const on = await globalTx((tx) => isFlagOn(tx, 'kill.read_only')).catch(() => false);
  roCache = { at: Date.now(), on };
  return on;
}

/** Consistent API responses: domain errors map to status codes with customer-safe messages; internals never leak. */
export function json(data: unknown, init?: number | ResponseInit) {
  return NextResponse.json(data, typeof init === 'number' ? { status: init } : init);
}

export function errorResponse(e: unknown) {
  if (e instanceof DomainError) {
    const res = json({ error: e.message, code: e.code, details: e.details ?? null }, httpStatusFor(e));
    if (e.code === 'RATE_LIMITED' && e.details?.retryAfter) res.headers.set('Retry-After', String(e.details.retryAfter));
    return res;
  }
  // The ref the customer sees is the request id every log line of this request (and its jobs) carries (§34).
  const id = currentRequestId() ?? crypto.randomUUID();
  reportError(e, { msg: 'request failed' });
  return json({ error: 'Something went wrong on our side. Please try again.', code: 'INTERNAL', ref: id }, 500);
}

/** CSRF defence for cookie-authenticated mutations: the Origin must be our own (SameSite=Lax is the first line). */
export function assertSameOrigin(req: Request) {
  if (req.method === 'GET' || req.method === 'HEAD') return;
  const origin = req.headers.get('origin');
  const allowed = new URL(env().APP_URL).origin;
  if (origin && origin !== allowed && !(env().NODE_ENV !== 'production' && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin))) {
    throw new DomainError('FORBIDDEN', 'Cross-site request blocked');
  }
}

/**
 * API route wrapper: same-origin check, read-only kill switch, customer-safe errors, and a log context whose
 * request id joins this request's log lines, the jobs it enqueues and their provider calls (§34). The id is
 * returned in `x-request-id`.
 */
export function route<C = { params: Promise<Record<string, string>> }>(fn: (req: Request, ctx: C) => Promise<Response>) {
  return async (req: Request, ctx: C) => {
    const requestId = requestIdFrom(req);
    const path = new URL(req.url).pathname;
    return withLogContext({ requestId, method: req.method, path }, () => withSpan(`${req.method} ${path}`, { 'http.request.method': req.method, 'url.path': path, 'arkiv.request_id': requestId }, async (span) => {
      let res: Response;
      try {
        assertSameOrigin(req);
        if (req.method !== 'GET' && !new URL(req.url).pathname.startsWith('/api/auth/') && (await readOnly())) {
          throw new DomainError('UNAVAILABLE', 'Arkiv is in read-only mode for maintenance. Nothing you’ve done is lost — try again shortly.');
        }
        res = await fn(req, ctx);
      } catch (e) {
        res = errorResponse(e);
      }
      try {
        res.headers.set('x-request-id', requestId);
      } catch {
        /* immutable response (e.g. a redirect); the id is still in the logs */
      }
      span.setAttribute('http.response.status_code', res.status);
      return res;
    }, { kind: 'server' }));
  };
}

export async function body<T>(req: Request, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new DomainError('INVALID', 'Invalid request body');
  }
  const r = schema.safeParse(raw);
  if (!r.success) throw new DomainError('INVALID', r.error.issues[0]?.message ?? 'Invalid request', { issues: r.error.issues.slice(0, 5) });
  return r.data;
}

/**
 * The request's Idempotency-Key header (standard §39 "every externally triggered create action receives an
 * idempotency key scoped to workspace + operation"), or null when the client sent none. A malformed key is refused.
 */
export function idempotencyKeyOf(req: Request): string | null {
  const k = req.headers.get('idempotency-key');
  if (k == null || k === '') return null;
  if (!/^[A-Za-z0-9._:-]{8,100}$/.test(k)) throw new DomainError('INVALID', 'Invalid Idempotency-Key');
  return k;
}

/**
 * Run a create once per (workspace, operation, key), inside the caller's tenant transaction: a replay with the same
 * key and request returns the stored answer and creates nothing; the same key with a different request is a
 * conflict. Without a key the create just runs (older clients, scripts). A create that fails stores nothing, so a
 * retry with the same key runs again.
 */
export async function withIdempotency<T>(tx: Tx, workspaceId: string, operation: string, key: string | null, request: unknown, fn: () => Promise<T>): Promise<T> {
  if (!key) return fn();
  return (await idempotent(tx, workspaceId, operation, key, request, fn)).result;
}

/** What identifies an uploaded file in an idempotent request (its bytes are not hashed). */
export const fileIdentity = (f: unknown) => (f instanceof File && f.size > 0 ? { name: f.name, size: f.size, type: f.type } : null);

/** Who is asking, for the abuse detectors (plan 05 §15): IP, device hints and the ASN when the edge supplies one. */
export function clientFingerprint(req: Request): ClientFingerprint {
  return { ip: clientIp(req), userAgent: req.headers.get('user-agent'), acceptLanguage: req.headers.get('accept-language'), asn: req.headers.get('x-client-asn') };
}

export function clientIp(req: Request): string | null {
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? req.headers.get('x-real-ip') ?? null;
}
