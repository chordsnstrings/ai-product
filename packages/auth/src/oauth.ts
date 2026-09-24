import { createHash, randomBytes } from 'node:crypto';
import { SignJWT, createRemoteJWKSet, importPKCS8, jwtVerify, type JWTPayload } from 'jose';
import { globalTx } from '@arkiv/db';
import { DomainError, env } from '@arkiv/shared';
import { recordLoginFailure, type LoginMeta } from './login-attempts';
import { MOCK_IDP_ISSUER, mockClientId, mockExchange, verifyMockIdToken, type OAuthProvider } from './mock-idp';
import { flagDisposableSignup, notifyIfNewDevice, securityNotice } from './signals';
import { createSession, findOrCreateUser } from './sessions';
import { safeRedirect } from './redirect';

/**
 * Google and Apple sign-in (plan 04 L5). Authorization code flow with PKCE + nonce; the ID token is verified
 * against the provider's JWKS. Accounts link by verified email (plan 03 Part C edge cases), or explicitly from
 * Profile ('link' flows) — e.g. an Apple relay address that differs from the Google one.
 *
 * Every flow is bound to the browser that started it: startOAuth returns a random binding the start route puts in
 * an HttpOnly cookie, and only its hash is stored with the state. A callback URL replayed in another browser
 * (login CSRF: the victim would be signed in as the attacker) finds no matching state.
 */
type Provider = OAuthProvider;

const GOOGLE = { auth: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token', jwks: 'https://www.googleapis.com/oauth2/v3/certs', issuer: ['https://accounts.google.com', 'accounts.google.com'] };
const APPLE = { auth: 'https://appleid.apple.com/auth/authorize', token: 'https://appleid.apple.com/auth/token', jwks: 'https://appleid.apple.com/auth/keys', issuer: 'https://appleid.apple.com' };

/** Cookie holding the browser binding of an OAuth flow in progress (scoped to the auth routes, 10 minutes). */
export const OAUTH_BINDING_COOKIE = 'arkiv_oauth';
export const OAUTH_TTL_SECONDS = 600;

const b64url = (b: Buffer) => b.toString('base64url');
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const redirectUri = (p: Provider) => `${env().APP_URL}/api/auth/${p}/callback`;

function liveConfigured(p: Provider) {
  const e = env();
  return p === 'google' ? !!(e.GOOGLE_CLIENT_ID && e.GOOGLE_CLIENT_SECRET) : !!(e.APPLE_CLIENT_ID && e.APPLE_TEAM_ID && e.APPLE_KEY_ID && e.APPLE_PRIVATE_KEY);
}

/** Real credentials win; without them, mock mode signs in through the built-in mock identity provider. */
export function oauthMode(p: Provider): 'live' | 'mock' | null {
  if (liveConfigured(p)) return 'live';
  return env().PROVIDERS_MODE === 'mock' ? 'mock' : null;
}

export function providerEnabled(p: Provider) {
  return oauthMode(p) !== null;
}

const clientId = (p: Provider) => (oauthMode(p) === 'mock' ? mockClientId(p) : p === 'google' ? env().GOOGLE_CLIENT_ID! : env().APPLE_CLIENT_ID!);

export async function startOAuth(
  p: Provider,
  opts: { redirectTo?: string | null; provisionalWorkspaceId?: string | null; linkUserId?: string | null },
): Promise<{ url: string; binding: string }> {
  const mode = oauthMode(p);
  if (!mode) throw new DomainError('UNAVAILABLE', `${p === 'google' ? 'Google' : 'Apple'} sign-in isn’t available right now. Use your email instead.`);
  const state = b64url(randomBytes(24));
  const verifier = b64url(randomBytes(32));
  const nonce = b64url(randomBytes(16));
  const binding = b64url(randomBytes(24));
  await globalTx((tx) => tx`insert into oauth_states (state, provider, code_verifier, nonce, redirect_to, provisional_workspace_id, binding_hash, link_user_id, expires_at)
                            values (${state}, ${p}, ${verifier}, ${nonce}, ${safeRedirect(opts.redirectTo)}, ${opts.linkUserId ? null : (opts.provisionalWorkspaceId ?? null)},
                                    ${sha256(binding)}, ${opts.linkUserId ?? null}, now() + make_interval(secs => ${OAUTH_TTL_SECONDS}))`);
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  if (mode === 'mock') {
    const q = new URLSearchParams({ provider: p, client_id: clientId(p), redirect_uri: redirectUri(p), response_type: 'code', state, nonce, response_mode: p === 'apple' ? 'form_post' : 'query' });
    if (p === 'google') q.set('code_challenge', challenge);
    return { url: `${env().APP_URL}/auth/mock-idp?${q}`, binding };
  }
  if (p === 'google') {
    const q = new URLSearchParams({ client_id: clientId(p), redirect_uri: redirectUri(p), response_type: 'code', scope: 'openid email profile', state, nonce, code_challenge: challenge, code_challenge_method: 'S256', prompt: 'select_account' });
    return { url: `${GOOGLE.auth}?${q}`, binding };
  }
  const q = new URLSearchParams({ client_id: clientId(p), redirect_uri: redirectUri(p), response_type: 'code', response_mode: 'form_post', scope: 'name email', state, nonce });
  return { url: `${APPLE.auth}?${q}`, binding };
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

export type OAuthResult =
  | { kind: 'session'; token: string; expiresAt: Date; sessionId: string; userId: string; email: string; created: boolean; redirectTo: string | null; provisionalWorkspaceId: string | null }
  | { kind: 'linked'; userId: string; email: string; redirectTo: string | null };

/**
 * OAuth callback. `binding` is the value of the browser's binding cookie. A refused sign-in is recorded as a failed
 * attempt (plan 05 §3), with the email once known.
 */
export async function finishOAuth(p: Provider, params: { code: string; state: string; user?: string | null }, meta: LoginMeta, binding: string | null | undefined): Promise<OAuthResult> {
  let email: string | null = null;
  try {
    const r = await finish(p, params, meta, binding, (e) => (email = e));
    if (r.kind === 'session') await notifyIfNewDevice(r.userId, r.sessionId, meta);
    return r;
  } catch (e) {
    const reason = e instanceof DomainError ? e.message : 'Sign-in failed at the provider.';
    await recordLoginFailure(p, { email }, reason, meta, /locked/i.test(reason) ? 'locked' : 'failed');
    throw e;
  }
}

async function exchange(p: Provider, code: string, verifier: string): Promise<JWTPayload> {
  if (oauthMode(p) === 'mock') {
    const idToken = await mockExchange(p, code, { clientId: clientId(p), redirectUri: redirectUri(p), codeVerifier: p === 'google' ? verifier : null });
    return verifyMockIdToken(idToken, clientId(p));
  }
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(p),
    client_id: clientId(p),
    client_secret: p === 'google' ? env().GOOGLE_CLIENT_SECRET! : await appleClientSecret(),
    ...(p === 'google' ? { code_verifier: verifier } : {}),
  });
  const r = await fetch(p === 'google' ? GOOGLE.token : APPLE.token, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const j = (await r.json()) as { id_token?: string; error?: string };
  if (!j.id_token) throw new DomainError('INVALID', 'Sign-in failed. Please try again.', { providerError: j.error });
  const { payload } = await jwtVerify(j.id_token, createRemoteJWKSet(new URL(p === 'google' ? GOOGLE.jwks : APPLE.jwks)), {
    issuer: p === 'google' ? GOOGLE.issuer : APPLE.issuer,
    audience: clientId(p),
  });
  return payload;
}

async function finish(p: Provider, params: { code: string; state: string; user?: string | null }, meta: LoginMeta, binding: string | null | undefined, seen: (email: string) => void): Promise<OAuthResult> {
  if (!binding) throw new DomainError('INVALID', 'Sign-in expired. Please try again.');
  const [st] = await globalTx((tx) => tx`delete from oauth_states where state = ${params.state} and provider = ${p} and binding_hash = ${sha256(binding)} and expires_at > now() returning *`);
  if (!st) throw new DomainError('INVALID', 'Sign-in expired. Please try again.');
  if (!st.link_user_id) return complete(p, params, meta, st, seen);
  // A failed Connect from Profile goes back to Profile (the user is signed in), not to the sign-in page.
  try {
    return await complete(p, params, meta, st, seen);
  } catch (e) {
    const back = safeRedirect(st.redirect_to as string | null);
    if (e instanceof DomainError) throw new DomainError(e.code, e.message, { ...(e.details ?? {}), linkRedirect: back });
    throw new DomainError('INVALID', 'Connecting failed at the provider. Please try again.', { linkRedirect: back });
  }
}

async function complete(p: Provider, params: { code: string; state: string; user?: string | null }, meta: LoginMeta, st: Record<string, unknown>, seen: (email: string) => void): Promise<OAuthResult> {
  const payload = await exchange(p, params.code, st.code_verifier as string);
  if (oauthMode(p) === 'mock' && payload.iss !== MOCK_IDP_ISSUER) throw new DomainError('INVALID', 'Sign-in could not be verified.');
  if (payload.nonce !== st.nonce) throw new DomainError('INVALID', 'Sign-in could not be verified.');
  const email = String(payload.email ?? '').trim().toLowerCase();
  if (email) seen(email);
  const verified = payload.email_verified === true || payload.email_verified === 'true';
  if (!email || !verified) throw new DomainError('INVALID', 'Your account email isn’t verified with the provider.');
  if (!payload.sub) throw new DomainError('INVALID', 'Sign-in could not be verified.');
  let name: string | null = (payload.name as string) ?? null;
  if (p === 'apple' && params.user) {
    try {
      const u = JSON.parse(params.user) as { name?: { firstName?: string; lastName?: string } };
      name = [u.name?.firstName, u.name?.lastName].filter(Boolean).join(' ') || null;
    } catch {
      /* ignore */
    }
  }
  const redirectTo = safeRedirect(st.redirect_to as string | null);

  // Link mode (Profile → Connect): add this identity to the signed-in user; no new session.
  if (st.link_user_id) {
    const linkUserId = st.link_user_id as string;
    await globalTx(async (tx) => {
      const [owner] = await tx`select user_id from user_identities where provider = ${p} and provider_subject = ${payload.sub!}`;
      if (owner && owner.user_id !== linkUserId) {
        throw new DomainError('CONFLICT', `That ${p === 'google' ? 'Google' : 'Apple'} account already signs in to a different Arkiv account. Sign in with it and delete that account first, or use another one.`);
      }
      if (!owner) await tx`insert into user_identities (user_id, provider, provider_subject, email) values (${linkUserId}, ${p}, ${payload.sub!}, ${email})`;
    });
    await securityNotice(linkUserId, `${p === 'google' ? 'Google' : 'Apple'} sign-in connected (${email})`, `link:${p}:${payload.sub}:${params.state}`);
    return { kind: 'linked', userId: linkUserId, email, redirectTo };
  }

  const r = await globalTx(async (tx) => {
    const [ident] = await tx`select user_id from user_identities where provider = ${p} and provider_subject = ${payload.sub!}`;
    let userId: string;
    let created = false;
    if (ident) userId = ident.user_id as string;
    else {
      const u = await findOrCreateUser(tx, email, { name, verified: true, method: p });
      userId = u.userId;
      created = u.created;
      await tx`insert into user_identities (user_id, provider, provider_subject, email) values (${userId}, ${p}, ${payload.sub!}, ${email})`;
    }
    // createSession refuses a locked or deleted account, including on this existing-identity path.
    const session = await createSession(userId, meta, tx, p);
    return { kind: 'session' as const, ...session, userId, email, created, redirectTo, provisionalWorkspaceId: (st.provisional_workspace_id as string) ?? null };
  });
  if (r.created) await flagDisposableSignup(email, { workspaceId: r.provisionalWorkspaceId, ip: meta.ip ?? null, method: p });
  return r;
}
