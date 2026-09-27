import { createHmac, timingSafeEqual } from 'node:crypto';
import { env, SIGN_IN_METHODS, type SignInMethod } from '@arkiv/shared';

/**
 * A pending "where should this preview go?" choice (plan 02 §2.1: a visitor who signs in to an existing account is
 * offered "Add this product to Workspace X" or "Create a new workspace"). Sign-in hands the choice page a token
 * naming the provisional workspace, signed for that user only and valid for an hour, so the choice works on the
 * device that opened the link even though the preview cookie lives on another one.
 */
const TTL_SECONDS = 3600;
const sign = (body: string) => createHmac('sha256', `claim:${env().APP_SECRET}`).update(body).digest('base64url');

export function claimToken(provisionalWorkspaceId: string, userId: string, method: SignInMethod, now = Date.now()): string {
  const body = Buffer.from(JSON.stringify({ w: provisionalWorkspaceId, u: userId, m: method, e: Math.floor(now / 1000) + TTL_SECONDS })).toString('base64url');
  return `${body}.${sign(body)}`;
}

export function readClaimToken(token: string | null | undefined, userId: string, now = Date.now()): { provisionalWorkspaceId: string; method: SignInMethod } | null {
  if (!token || token.length > 600) return null;
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const want = Buffer.from(sign(body));
  const got = Buffer.from(mac);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString()) as { w?: string; u?: string; m?: string; e?: number };
    if (!p.w || p.u !== userId || !p.e || p.e * 1000 < now) return null;
    const method = (SIGN_IN_METHODS as readonly string[]).includes(p.m ?? '') ? (p.m as SignInMethod) : 'magic_link';
    return { provisionalWorkspaceId: p.w, method };
  } catch {
    return null;
  }
}
