import { NextResponse } from 'next/server';
import type { z } from 'zod';
import { globalTx } from '@arkiv/db';
import { isFlagOn, type ClientFingerprint } from '@arkiv/core';
import { DomainError, env, httpStatusFor } from '@arkiv/shared';
import { currentRequestId, logger, setLogService, withLogContext } from '@arkiv/shared/log';

setLogService('web');
const log = logger('api');

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
  log.error('request failed', { err: e });
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
    return withLogContext({ requestId, method: req.method, path: new URL(req.url).pathname }, async () => {
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
      return res;
    });
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

/** Who is asking, for the abuse detectors (plan 05 §15): IP, device hints and the ASN when the edge supplies one. */
export function clientFingerprint(req: Request): ClientFingerprint {
  return { ip: clientIp(req), userAgent: req.headers.get('user-agent'), acceptLanguage: req.headers.get('accept-language'), asn: req.headers.get('x-client-asn') };
}

export function clientIp(req: Request): string | null {
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? req.headers.get('x-real-ip') ?? null;
}
