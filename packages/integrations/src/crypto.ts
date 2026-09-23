import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { env } from '@arkiv/shared';

/** OAuth tokens are encrypted at rest with AES-256-GCM (§40). Format: v1.<iv>.<tag>.<ciphertext> (base64url). */
function key(): Buffer {
  const k = Buffer.from(env().TOKEN_ENCRYPTION_KEY, 'base64');
  if (k.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY must be 32 bytes base64');
  return k;
}

export function encryptToken(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

export function decryptToken(enc: string): string {
  const [v, iv, tag, ct] = enc.split('.');
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('bad token envelope');
  const d = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
}

export function hmacHex(secret: string, data: string | Buffer) {
  return createHmac('sha256', secret).update(data).digest('hex');
}
export function hmacB64(secret: string, data: string | Buffer) {
  return createHmac('sha256', secret).update(data).digest('base64');
}
export function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Signed OAuth `state` (binds the callback to a workspace + user; expires in 15 min). */
export function signState(payload: Record<string, string>): string {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + 15 * 60_000 })).toString('base64url');
  return `${body}.${createHmac('sha256', env().APP_SECRET).update(body).digest('base64url')}`;
}
export function verifyState(state: string): Record<string, string> | null {
  const [body, sig] = state.split('.');
  if (!body || !sig) return null;
  const expected = createHmac('sha256', env().APP_SECRET).update(body).digest('base64url');
  if (!safeEqual(expected, sig)) return null;
  const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<string, string> & { exp: number };
  return p.exp > Date.now() ? p : null;
}
