import { createHash } from 'node:crypto';
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { DomainError, env } from '@arkiv/shared';

/**
 * A stand-in Google/Apple identity provider for PROVIDERS_MODE=mock (local dev, e2e), like MockStripe for billing:
 * the whole OAuth flow — state, browser binding, PKCE, nonce, code exchange and ID-token verification — runs
 * without credentials. The authorize screen (/auth/mock-idp) picks a test identity; the code and the ID token are
 * short-lived JWTs signed with a key derived from APP_SECRET, so every server process agrees on it.
 */
export type OAuthProvider = 'google' | 'apple';

export const MOCK_IDP_ISSUER = 'https://mock-idp.arkiv.invalid';
export const mockClientId = (p: OAuthProvider) => `mock-${p}-client`;

export interface MockIdentity {
  sub: string;
  email: string;
  emailVerified: boolean;
  name?: string | null;
  /** Apple "Hide my email" relay address. */
  isPrivateEmail?: boolean;
}

/** The identities the mock authorize screen offers (plan 03 Part C edge cases: same email; Apple relay). */
export const MOCK_IDENTITIES: Record<OAuthProvider, { label: string; identity: MockIdentity }[]> = {
  google: [
    { label: 'Founder (Google)', identity: { sub: 'google-founder', email: 'founder@glowlab.test', emailVerified: true, name: 'Glow Founder' } },
    { label: 'Unverified email (Google)', identity: { sub: 'google-unverified', email: 'unverified@glowlab.test', emailVerified: false } },
  ],
  apple: [
    { label: 'Founder, same email (Apple)', identity: { sub: 'apple-founder', email: 'founder@glowlab.test', emailVerified: true, name: 'Glow Founder' } },
    { label: 'Hide my email relay (Apple)', identity: { sub: 'apple-relay', email: 'k7x2q9@privaterelay.appleid.com', emailVerified: true, isPrivateEmail: true } },
  ],
};

const key = () => createHash('sha256').update(`arkiv-mock-idp:${env().APP_SECRET}`).digest();
const b64url = (b: Buffer) => b.toString('base64url');

function assertMock() {
  if (env().PROVIDERS_MODE !== 'mock') throw new DomainError('NOT_FOUND', 'Not found');
}

/** The authorize step: the chosen identity becomes a one-use code bound to the request's client, redirect and PKCE. */
export async function mockAuthorize(input: {
  provider: OAuthProvider;
  clientId: string;
  redirectUri: string;
  nonce: string;
  codeChallenge?: string | null;
  identity: MockIdentity;
}): Promise<string> {
  assertMock();
  if (input.clientId !== mockClientId(input.provider)) throw new DomainError('INVALID', 'Unknown client');
  if (!input.redirectUri.startsWith(`${env().APP_URL}/api/auth/${input.provider}/callback`)) throw new DomainError('INVALID', 'Unknown redirect URI');
  return new SignJWT({ typ: 'code', p: input.provider, ru: input.redirectUri, n: input.nonce, cc: input.codeChallenge ?? null, id: input.identity as never })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(MOCK_IDP_ISSUER)
    .setAudience(input.clientId)
    .setIssuedAt()
    .setExpirationTime('2m')
    .sign(key());
}

/** The token endpoint: a valid code (right client, redirect URI and PKCE verifier) → a signed ID token. */
export async function mockExchange(provider: OAuthProvider, code: string, opts: { clientId: string; redirectUri: string; codeVerifier?: string | null }): Promise<string> {
  assertMock();
  let c: JWTPayload & { typ?: string; p?: string; ru?: string; n?: string; cc?: string | null; id?: MockIdentity };
  try {
    ({ payload: c } = await jwtVerify(code, key(), { issuer: MOCK_IDP_ISSUER, audience: opts.clientId }));
  } catch {
    throw new DomainError('INVALID', 'Sign-in failed. Please try again.', { providerError: 'invalid_grant' });
  }
  if (c.typ !== 'code' || c.p !== provider || c.ru !== opts.redirectUri || !c.id) throw new DomainError('INVALID', 'Sign-in failed. Please try again.', { providerError: 'invalid_grant' });
  if (c.cc) {
    const expected = opts.codeVerifier ? b64url(createHash('sha256').update(opts.codeVerifier).digest()) : null;
    if (expected !== c.cc) throw new DomainError('INVALID', 'Sign-in failed. Please try again.', { providerError: 'invalid_grant' });
  }
  const id = c.id;
  return new SignJWT({
    email: id.email,
    email_verified: id.emailVerified,
    ...(id.name ? { name: id.name } : {}),
    ...(id.isPrivateEmail ? { is_private_email: true } : {}),
    nonce: c.n,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(MOCK_IDP_ISSUER)
    .setAudience(opts.clientId)
    .setSubject(id.sub)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(key());
}

export async function verifyMockIdToken(idToken: string, clientId: string): Promise<JWTPayload> {
  assertMock();
  const { payload } = await jwtVerify(idToken, key(), { issuer: MOCK_IDP_ISSUER, audience: clientId });
  return payload;
}
