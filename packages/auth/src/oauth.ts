import { createHash, randomBytes } from 'node:crypto';
import { SignJWT, createRemoteJWKSet, importPKCS8, jwtVerify } from 'jose';
import { globalTx } from '@arkiv/db';
import { DomainError, env } from '@arkiv/shared';
import { recordLoginFailure, type LoginMeta } from './login-attempts';
import { createSession, findOrCreateUser } from './sessions';

/**
 * Google and Apple sign-in (plan 04 L5). Authorization code flow with PKCE + nonce; the ID token is verified
 * against the provider's JWKS. Accounts link by verified email (plan 03 Part C edge cases).
 */
type Provider = 'google' | 'apple';

const GOOGLE = { auth: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token', jwks: 'https://www.googleapis.com/oauth2/v3/certs', issuer: ['https://accounts.google.com', 'accounts.google.com'] };
const APPLE = { auth: 'https://appleid.apple.com/auth/authorize', token: 'https://appleid.apple.com/auth/token', jwks: 'https://appleid.apple.com/auth/keys', issuer: 'https://appleid.apple.com' };

const b64url = (b: Buffer) => b.toString('base64url');
const redirectUri = (p: Provider) => `${env().APP_URL}/api/auth/${p}/callback`;

export function providerEnabled(p: Provider) {
  const e = env();
  return p === 'google' ? !!(e.GOOGLE_CLIENT_ID && e.GOOGLE_CLIENT_SECRET) : !!(e.APPLE_CLIENT_ID && e.APPLE_TEAM_ID && e.APPLE_KEY_ID && e.APPLE_PRIVATE_KEY);
}

export async function startOAuth(p: Provider, opts: { redirectTo?: string | null; provisionalWorkspaceId?: string | null }): Promise<string> {
  if (!providerEnabled(p)) throw new DomainError('UNAVAILABLE', `${p === 'google' ? 'Google' : 'Apple'} sign-in isn’t configured.`);
  const state = b64url(randomBytes(24));
  const verifier = b64url(randomBytes(32));
  const nonce = b64url(randomBytes(16));
  await globalTx((tx) => tx`insert into oauth_states (state, provider, code_verifier, nonce, redirect_to, provisional_workspace_id, expires_at)
                            values (${state}, ${p}, ${verifier}, ${nonce}, ${opts.redirectTo ?? null}, ${opts.provisionalWorkspaceId ?? null}, now() + interval '10 minutes')`);
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  if (p === 'google') {
    const q = new URLSearchParams({ client_id: env().GOOGLE_CLIENT_ID!, redirect_uri: redirectUri(p), response_type: 'code', scope: 'openid email profile', state, nonce, code_challenge: challenge, code_challenge_method: 'S256', prompt: 'select_account' });
    return `${GOOGLE.auth}?${q}`;
  }
  const q = new URLSearchParams({ client_id: env().APPLE_CLIENT_ID!, redirect_uri: redirectUri(p), response_type: 'code', response_mode: 'form_post', scope: 'name email', state, nonce });
  return `${APPLE.auth}?${q}`;
}

async function appleClientSecret() {
  const e = env();
  const key = await importPKCS8(e.APPLE_PRIVATE_KEY!.replace(/\\n/g, '\n'), 'ES256');
  return new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: e.APPLE_KEY_ID! })
    .setIssuer(e.APPLE_TEAM_ID!)
    .setAudience(APPLE.issuer)
    .setSubject(e.APPLE_CLIENT_ID!)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(key);
}

/** OAuth callback. A refused sign-in is recorded as a failed attempt (plan 05 §3), with the email once known. */
export async function finishOAuth(p: Provider, params: { code: string; state: string; user?: string | null }, meta: LoginMeta) {
  let email: string | null = null;
  try {
    return await finish(p, params, meta, (e) => (email = e));
  } catch (e) {
    const reason = e instanceof DomainError ? e.message : 'Sign-in failed at the provider.';
    await recordLoginFailure(p, { email }, reason, meta, /locked/i.test(reason) ? 'locked' : 'failed');
    throw e;
  }
}

async function finish(p: Provider, params: { code: string; state: string; user?: string | null }, meta: LoginMeta, seen: (email: string) => void) {
  const [st] = await globalTx((tx) => tx`delete from oauth_states where state = ${params.state} and provider = ${p} and expires_at > now() returning *`);
  if (!st) throw new DomainError('INVALID', 'Sign-in expired. Please try again.');
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: redirectUri(p),
    client_id: p === 'google' ? env().GOOGLE_CLIENT_ID! : env().APPLE_CLIENT_ID!,
    client_secret: p === 'google' ? env().GOOGLE_CLIENT_SECRET! : await appleClientSecret(),
    ...(p === 'google' ? { code_verifier: st.code_verifier as string } : {}),
  });
  const r = await fetch(p === 'google' ? GOOGLE.token : APPLE.token, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const j = (await r.json()) as { id_token?: string; error?: string };
  if (!j.id_token) throw new DomainError('INVALID', 'Sign-in failed. Please try again.', { providerError: j.error });
  const { payload } = await jwtVerify(j.id_token, createRemoteJWKSet(new URL(p === 'google' ? GOOGLE.jwks : APPLE.jwks)), {
    issuer: p === 'google' ? GOOGLE.issuer : APPLE.issuer,
    audience: p === 'google' ? env().GOOGLE_CLIENT_ID! : env().APPLE_CLIENT_ID!,
  });
  if (payload.nonce !== st.nonce) throw new DomainError('INVALID', 'Sign-in could not be verified.');
  const email = String(payload.email ?? '');
  if (email) seen(email);
  const verified = payload.email_verified === true || payload.email_verified === 'true';
  if (!email || !verified) throw new DomainError('INVALID', 'Your account email isn’t verified with the provider.');
  let name: string | null = (payload.name as string) ?? null;
  if (p === 'apple' && params.user) {
    try {
      const u = JSON.parse(params.user) as { name?: { firstName?: string; lastName?: string } };
      name = [u.name?.firstName, u.name?.lastName].filter(Boolean).join(' ') || null;
    } catch {
      /* ignore */
    }
  }
  return globalTx(async (tx) => {
    const [ident] = await tx`select user_id from user_identities where provider = ${p} and provider_subject = ${payload.sub!}`;
    let userId: string;
    let created = false;
    if (ident) userId = ident.user_id as string;
    else {
      const u = await findOrCreateUser(tx, email, { name, verified: true });
      userId = u.userId;
      created = u.created;
      await tx`insert into user_identities (user_id, provider, provider_subject, email) values (${userId}, ${p}, ${payload.sub!}, ${email})`;
    }
    const session = await createSession(userId, meta, tx);
    return { ...session, userId, email, created, redirectTo: (st.redirect_to as string) ?? null, provisionalWorkspaceId: (st.provisional_workspace_id as string) ?? null };
  });
}
