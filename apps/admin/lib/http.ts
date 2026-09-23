import { NextResponse } from 'next/server';
import type { z } from 'zod';
import { DomainError, env, httpStatusFor } from '@arkiv/shared';

export const json = (data: unknown, status = 200) => NextResponse.json(data, { status });

export function errorResponse(e: unknown) {
  if (e instanceof DomainError) return json({ error: e.message, code: e.code, details: e.details ?? null }, httpStatusFor(e));
  const id = Math.random().toString(36).slice(2, 10);
  console.error(`[admin:${id}]`, e);
  return json({ error: `Unexpected error (ref ${id})`, code: 'INTERNAL' }, 500);
}

/** Staff console mutations must originate from the console's own origin. */
export function assertSameOrigin(req: Request) {
  if (req.method === 'GET') return;
  const origin = req.headers.get('origin');
  const allowed = new URL(env().ADMIN_URL).origin;
  if (!origin || (origin !== allowed && !(env().NODE_ENV !== 'production' && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)))) {
    throw new DomainError('FORBIDDEN', 'Cross-site request blocked');
  }
}

export async function body<T>(req: Request, schema: z.ZodType<T>): Promise<T> {
  const raw = await req.json().catch(() => {
    throw new DomainError('INVALID', 'Invalid request body');
  });
  const r = schema.safeParse(raw);
  if (!r.success) throw new DomainError('INVALID', r.error.issues[0]?.message ?? 'Invalid request');
  return r.data;
}
