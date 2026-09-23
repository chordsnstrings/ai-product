import { NextResponse } from 'next/server';
import type { z } from 'zod';
import { globalTx } from '@arkiv/db';
import { isFlagOn } from '@arkiv/core';
import { DomainError, env, httpStatusFor } from '@arkiv/shared';

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
  const id = Math.random().toString(36).slice(2, 10);
  console.error(`[api:${id}]`, e);
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

export function route<C = { params: Promise<Record<string, string>> }>(fn: (req: Request, ctx: C) => Promise<Response>) {
  return async (req: Request, ctx: C) => {
    try {
      assertSameOrigin(req);
      if (req.method !== 'GET' && !new URL(req.url).pathname.startsWith('/api/auth/') && (await readOnly())) {
        throw new DomainError('UNAVAILABLE', 'Arkiv is in read-only mode for maintenance. Nothing you’ve done is lost — try again shortly.');
      }
      return await fn(req, ctx);
    } catch (e) {
      return errorResponse(e);
    }
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

export function clientIp(req: Request): string | null {
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? req.headers.get('x-real-ip') ?? null;
}
