import { randomBytes } from 'node:crypto';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { globalTx } from '@arkiv/db';
import { DomainError, env } from '@arkiv/shared';
import { recordLoginFailure, type LoginMeta } from './login-attempts';
import { assertUserActive, createSession } from './sessions';
import { notifyIfNewDevice } from './signals';

/** Passkeys (WebAuthn), offered after the first purchase (plan 04 L5). Challenges live in oauth_states. */
const rp = () => {
  const u = new URL(env().APP_URL);
  return { rpID: u.hostname, rpName: 'Arkiv', origin: u.origin };
};

async function saveChallenge(key: string, challenge: string) {
  await globalTx((tx) => tx`insert into oauth_states (state, provider, code_verifier, expires_at) values (${key}, 'webauthn', ${challenge}, now() + interval '5 minutes')
                            on conflict (state) do update set code_verifier = excluded.code_verifier, expires_at = excluded.expires_at`);
}
async function takeChallenge(key: string): Promise<string> {
  const [r] = await globalTx((tx) => tx`delete from oauth_states where state = ${key} and provider = 'webauthn' and expires_at > now() returning code_verifier`);
  if (!r) throw new DomainError('INVALID', 'Passkey request expired. Try again.');
  return r.code_verifier as string;
}

export async function passkeyRegistrationOptions(user: { userId: string; email: string }) {
  const existing = await globalTx((tx) => tx`select credential_id, transports from passkeys where user_id = ${user.userId}`);
  const opts = await generateRegistrationOptions({
    rpName: rp().rpName,
    rpID: rp().rpID,
    userName: user.email,
    userID: new TextEncoder().encode(user.userId),
    attestationType: 'none',
    excludeCredentials: existing.map((c) => ({ id: c.credential_id as string, transports: (c.transports as never) ?? undefined })),
    // Discoverable credentials only: sign-in asks for no username (conditional UI), so it can't use any other kind.
    authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'preferred' },
  });
  await saveChallenge(`reg:${user.userId}`, opts.challenge);
  return opts;
}

export async function verifyPasskeyRegistration(user: { userId: string }, response: RegistrationResponseJSON, name?: string) {
  const expectedChallenge = await takeChallenge(`reg:${user.userId}`);
  const v = await verifyRegistrationResponse({ response, expectedChallenge, expectedOrigin: rp().origin, expectedRPID: rp().rpID });
  if (!v.verified || !v.registrationInfo) throw new DomainError('INVALID', 'Passkey could not be verified.');
  const c = v.registrationInfo.credential;
  await globalTx((tx) => tx`insert into passkeys (user_id, credential_id, public_key, counter, transports, name)
                            values (${user.userId}, ${c.id}, ${Buffer.from(c.publicKey)}, ${c.counter}, ${c.transports ?? null}, ${name ?? 'Passkey'})`);
  return true;
}

/**
 * Whether to suggest adding a passkey (plan 06 Phase 3 #8 "Passkeys (offered after first purchase)"; the caller
 * checks the purchase): the user has none yet and hasn't dismissed the suggestion.
 */
export async function passkeyPromptEligible(userId: string): Promise<boolean> {
  const [r] = await globalTx((tx) => tx`select u.passkey_prompt_dismissed_at is null and not exists (select 1 from passkeys p where p.user_id = u.id) as ok
                                        from users u where u.id = ${userId}`);
  return !!r?.ok;
}

export async function passkeyLoginOptions() {
  const flow = randomBytes(16).toString('base64url');
  const opts = await generateAuthenticationOptions({ rpID: rp().rpID, userVerification: 'preferred' });
  await saveChallenge(`auth:${flow}`, opts.challenge);
  return { flow, options: opts };
}

/** Passkey sign-in. A refused attempt is recorded as a failed sign-in (plan 05 §3) against the passkey's owner. */
export async function verifyPasskeyLogin(flow: string, response: AuthenticationResponseJSON, meta: LoginMeta) {
  let userId: string | null = null;
  try {
    const r = await verifyPasskey(flow, response, meta, (u) => (userId = u));
    await notifyIfNewDevice(r.userId, r.sessionId, meta);
    return r;
  } catch (e) {
    const reason = e instanceof DomainError ? e.message : 'Passkey could not be verified.';
    await recordLoginFailure('passkey', { userId }, reason, meta, /locked/i.test(reason) ? 'locked' : 'failed');
    throw e;
  }
}

async function verifyPasskey(flow: string, response: AuthenticationResponseJSON, meta: LoginMeta, seen: (userId: string) => void) {
  const expectedChallenge = await takeChallenge(`auth:${flow}`);
  const [pk] = await globalTx((tx) => tx`select * from passkeys where credential_id = ${response.id}`);
  if (!pk) throw new DomainError('INVALID', 'Unknown passkey.');
  seen(pk.user_id as string);
  const v = await verifyAuthenticationResponse({
    response,
    expectedChallenge,
    expectedOrigin: rp().origin,
    expectedRPID: rp().rpID,
    credential: { id: pk.credential_id as string, publicKey: new Uint8Array(pk.public_key as Buffer), counter: Number(pk.counter), transports: (pk.transports as never) ?? undefined },
  }).catch(() => ({ verified: false }) as Awaited<ReturnType<typeof verifyAuthenticationResponse>>);
  if (!v.verified) throw new DomainError('INVALID', 'Passkey could not be verified.');
  // A locked account can't sign in with a passkey either.
  return globalTx(async (tx) => {
    await assertUserActive(tx, pk.user_id as string);
    await tx`update passkeys set counter = ${v.authenticationInfo.newCounter}, last_used_at = now() where id = ${pk.id}`;
    const s = await createSession(pk.user_id as string, meta, tx, 'passkey');
    return { ...s, userId: pk.user_id as string };
  });
}
