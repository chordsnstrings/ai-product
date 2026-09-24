import { randomBytes } from 'node:crypto';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { withAdmin, type Tx } from '@arkiv/db';
import { DomainError, env } from '@arkiv/shared';
import { NETWORK_REFUSED, normalizeIp, openStaffSession, staffPasswordFactor, type RequestMeta, type StaffSession } from './staff';

/**
 * Staff passkeys (plan 05 §0.1 "mandatory passkey (WebAuthn) or TOTP"; "Re-authentication (passkey tap)"):
 * a second factor at sign-in after the password, the 🔐 re-auth tap, and, with require_passkey (§23), the only
 * second factor accepted. The relying party is the console origin (ADMIN_URL), never the customer app.
 * Passkeys must verify the user (PIN or biometric), not just presence.
 */
const rp = () => {
  const u = new URL(env().ADMIN_URL);
  return { rpID: u.hostname, rpName: 'Arkiv Admin', origin: u.origin };
};
type Purpose = 'register' | 'login' | 'reauth';

/** WebAuthn payloads as the browser posts them (re-exported so apps need no direct server dependency). */
export type StaffAssertion = AuthenticationResponseJSON;
export type StaffAttestation = RegistrationResponseJSON;

async function saveChallenge(tx: Tx, key: string, staffId: string, purpose: Purpose, challenge: string) {
  await tx`delete from staff_webauthn_challenges where expires_at < now()`;
  await tx`insert into staff_webauthn_challenges (key, staff_id, purpose, challenge, expires_at) values (${key}, ${staffId}, ${purpose}, ${challenge}, now() + interval '5 minutes')
           on conflict (key) do update set staff_id = excluded.staff_id, purpose = excluded.purpose, challenge = excluded.challenge, expires_at = excluded.expires_at`;
}
/** Single use: the challenge row is deleted whether or not the response then verifies. */
async function takeChallenge(key: string, purpose: Purpose): Promise<{ staffId: string; challenge: string }> {
  const [r] = await withAdmin((tx) => tx`delete from staff_webauthn_challenges where key = ${key} and purpose = ${purpose} and expires_at > now() returning staff_id, challenge`);
  if (!r) throw new DomainError('INVALID', 'Passkey request expired. Try again.');
  return { staffId: r.staff_id as string, challenge: r.challenge as string };
}

async function credentialsOf(tx: Tx, staffId: string) {
  return tx`select id, credential_id, public_key, counter, transports from staff_passkeys where staff_id = ${staffId}`;
}

/** Verify an assertion against one of the staff member's own passkeys and advance its counter. */
async function verifyAssertion(tx: Tx, staffId: string, challenge: string, response: AuthenticationResponseJSON) {
  const [pk] = await tx`select * from staff_passkeys where credential_id = ${response.id} and staff_id = ${staffId} for update`;
  if (!pk) throw new DomainError('FORBIDDEN', 'That passkey isn’t registered to this account.');
  const v = await verifyAuthenticationResponse({
    response,
    expectedChallenge: challenge,
    expectedOrigin: rp().origin,
    expectedRPID: rp().rpID,
    requireUserVerification: true,
    credential: { id: pk.credential_id as string, publicKey: new Uint8Array(pk.public_key as Buffer), counter: Number(pk.counter), transports: (pk.transports as never) ?? undefined },
  }).catch(() => ({ verified: false as const, authenticationInfo: null }));
  if (!v.verified || !v.authenticationInfo) throw new DomainError('FORBIDDEN', 'Passkey could not be verified.');
  await tx`update staff_passkeys set counter = ${v.authenticationInfo.newCounter}, last_used_at = now() where id = ${pk.id}`;
  return pk.id as string;
}

// ── Registration (signed-in staff, after a fresh second factor — the route enforces it) ──

export async function staffPasskeyRegistrationOptions(session: Pick<StaffSession, 'staffId' | 'email'>) {
  return withAdmin(async (tx) => {
    const existing = await credentialsOf(tx, session.staffId);
    const opts = await generateRegistrationOptions({
      rpName: rp().rpName,
      rpID: rp().rpID,
      userName: session.email,
      userID: new TextEncoder().encode(session.staffId),
      attestationType: 'none',
      excludeCredentials: existing.map((c) => ({ id: c.credential_id as string, transports: (c.transports as never) ?? undefined })),
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
    });
    await saveChallenge(tx, `reg:${session.staffId}`, session.staffId, 'register', opts.challenge);
    return opts;
  });
}

export async function verifyStaffPasskeyRegistration(session: Pick<StaffSession, 'staffId'>, response: RegistrationResponseJSON, name?: string | null) {
  const { challenge, staffId } = await takeChallenge(`reg:${session.staffId}`, 'register');
  if (staffId !== session.staffId) throw new DomainError('FORBIDDEN', 'Passkey request belongs to another account.');
  const v = await verifyRegistrationResponse({ response, expectedChallenge: challenge, expectedOrigin: rp().origin, expectedRPID: rp().rpID, requireUserVerification: true }).catch(() => ({ verified: false as const, registrationInfo: undefined }));
  if (!v.verified || !v.registrationInfo) throw new DomainError('INVALID', 'Passkey could not be verified.');
  const c = v.registrationInfo.credential;
  return withAdmin(async (tx) => {
    const [row] = await tx`insert into staff_passkeys (staff_id, credential_id, public_key, counter, transports, name)
                           values (${staffId}, ${c.id}, ${Buffer.from(c.publicKey)}, ${c.counter}, ${c.transports ?? null}, ${name?.trim().slice(0, 60) || 'Passkey'})
                           on conflict (credential_id) do nothing returning id`;
    if (!row) throw new DomainError('CONFLICT', 'That passkey is already registered.');
    await tx`insert into admin_audit_log (staff_id, action, target_type, target_id, after) values (${staffId}, 'staff.passkey_added', 'staff', ${staffId}, ${tx.json({ passkeyId: row.id, name: name ?? 'Passkey' })})`;
    return row.id as string;
  });
}

export async function listStaffPasskeys(staffId: string) {
  return withAdmin((tx) => tx`select id, name, created_at, last_used_at, transports from staff_passkeys where staff_id = ${staffId} order by created_at`);
}

/** Remove one of your own passkeys. The last one can't go while a passkey is required for the account. */
export async function removeStaffPasskey(tx: Tx, staffId: string, passkeyId: string) {
  const [u] = await tx`select require_passkey, (select count(*)::int from staff_passkeys where staff_id = ${staffId}) as n from staff_users where id = ${staffId} for update`;
  if (u?.require_passkey && Number(u.n) <= 1) throw new DomainError('CONFLICT', 'Your account requires a passkey; add another before removing this one.');
  const del = await tx`delete from staff_passkeys where id = ${passkeyId} and staff_id = ${staffId} returning name`;
  if (!del.length) throw new DomainError('NOT_FOUND', 'Passkey not found');
  return del[0]!.name as string;
}

// ── Sign-in: password first, then a passkey assertion bound to that account ──

export async function staffPasskeyLoginOptions(email: string, password: string, meta: RequestMeta) {
  const r = await withAdmin(async (tx) => {
    const s = await staffPasswordFactor(tx, email, password, meta);
    if (!s) return null;
    const creds = await credentialsOf(tx, s.id as string);
    if (!creds.length) return { none: true as const };
    const opts = await generateAuthenticationOptions({
      rpID: rp().rpID,
      userVerification: 'required',
      allowCredentials: creds.map((c) => ({ id: c.credential_id as string, transports: (c.transports as never) ?? undefined })),
    });
    const flow = randomBytes(16).toString('base64url');
    await saveChallenge(tx, `login:${flow}`, s.id as string, 'login', opts.challenge);
    return { flow, options: opts };
  });
  if (!r) throw new DomainError('FORBIDDEN', 'Email or password is incorrect.');
  if ('none' in r) throw new DomainError('CONFLICT', 'No passkey is registered for this account yet. Sign in with your authenticator code, then add one under Passkeys.');
  return r;
}

export async function staffPasskeyLogin(flow: string, response: AuthenticationResponseJSON, meta: RequestMeta): Promise<string> {
  const { staffId, challenge } = await takeChallenge(`login:${flow}`, 'login');
  const result = await withAdmin(async (tx) => {
    const [s] = await tx`select * from staff_users where id = ${staffId} and active`;
    if (!s) throw new DomainError('FORBIDDEN', 'Sign-in failed.');
    try {
      await verifyAssertion(tx, staffId, challenge, response);
    } catch (e) {
      await tx.savepoint((sp) => sp`insert into admin_audit_log (staff_id, action, target_type, target_id, ip, user_agent) values (${staffId}, 'staff.login_failed', 'staff', ${staffId}, ${normalizeIp(meta.ip)}, ${meta.userAgent ?? null})`);
      return { failed: (e as Error).message };
    }
    return openStaffSession(tx, s, meta, 'passkey');
  });
  if ('failed' in result) throw new DomainError('FORBIDDEN', result.failed === 'network' ? NETWORK_REFUSED : result.failed);
  return result.token;
}

// ── 🔐 Re-authentication tap ──

/** Options for a re-auth tap, or null when the staff member has no passkey (they confirm with TOTP). */
export async function staffPasskeyReauthOptions(session: Pick<StaffSession, 'staffId' | 'sessionId'>) {
  return withAdmin(async (tx) => {
    const creds = await credentialsOf(tx, session.staffId);
    if (!creds.length) return null;
    const opts = await generateAuthenticationOptions({
      rpID: rp().rpID,
      userVerification: 'required',
      allowCredentials: creds.map((c) => ({ id: c.credential_id as string, transports: (c.transports as never) ?? undefined })),
    });
    await saveChallenge(tx, `reauth:${session.sessionId}`, session.staffId, 'reauth', opts.challenge);
    return opts;
  });
}

export async function staffPasskeyReauth(session: Pick<StaffSession, 'staffId' | 'sessionId'>, response: AuthenticationResponseJSON) {
  const { staffId, challenge } = await takeChallenge(`reauth:${session.sessionId}`, 'reauth');
  if (staffId !== session.staffId) throw new DomainError('FORBIDDEN', 'Passkey request belongs to another account.');
  await withAdmin(async (tx) => {
    await verifyAssertion(tx, staffId, challenge, response);
    await tx`update staff_sessions set reauth_at = now() where id = ${session.sessionId} and staff_id = ${staffId}`;
  });
}
