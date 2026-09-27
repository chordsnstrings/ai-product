import { createHash, createHmac, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import { adminPool, withAdmin, type Tx } from '@arkiv/db';
import { DomainError, StaffRole, type StaffRole as StaffRoleT } from '@arkiv/shared';

/**
 * Staff identity (plan 05 §0.1): separate table and sessions from customers; password (Argon2id) plus a
 * mandatory second factor — a passkey (WebAuthn, staff-passkeys.ts) or TOTP; staff with "require passkey"
 * can only use a passkey. 8h absolute / 30 min idle sessions; 🔐 actions need a fresh second factor within
 * 5 minutes. Role IP allowlists are checked at sign-in and on every request.
 */
export const STAFF_COOKIE = 'arkiv_staff';
const sha = (t: string) => createHash('sha256').update(t).digest('hex');

// ── TOTP (RFC 6238, SHA-1, 30s, 6 digits) ──
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32Encode(buf: Buffer) {
  let bits = '';
  for (const b of buf) bits += b.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i < bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  return out;
}
function base32Decode(s: string) {
  let bits = '';
  for (const c of s.replace(/=+$/, '').toUpperCase()) bits += B32.indexOf(c).toString(2).padStart(5, '0');
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}
export function totp(secretB32: string, t = Date.now(), step = 30) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(t / 1000 / step)));
  const h = createHmac('sha1', base32Decode(secretB32)).update(counter).digest();
  const o = h[h.length - 1]! & 0xf;
  const code = ((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0');
  return code;
}
export function verifyTotp(secretB32: string, code: string) {
  const c = code.replace(/\s/g, '');
  return [-1, 0, 1].some((w) => totp(secretB32, Date.now() + w * 30_000) === c);
}

export async function createStaff(input: { email: string; name: string; password: string; roles: StaffRoleT[] }) {
  if (input.password.length < 14) throw new DomainError('INVALID', 'Staff passwords must be at least 14 characters.');
  for (const r of input.roles) if (!StaffRole.includes(r)) throw new DomainError('INVALID', `Unknown role ${r}`);
  const secret = base32Encode(randomBytes(20));
  const [s] = await adminPool()`insert into staff_users (email, name, password_hash, totp_secret_enc, roles)
                                values (${input.email.toLowerCase()}, ${input.name}, ${await argonHash(input.password)}, ${secret}, ${input.roles})
                                returning id`;
  return { staffId: s!.id as string, totpSecret: secret, otpauth: `otpauth://totp/Arkiv%20Admin:${encodeURIComponent(input.email)}?secret=${secret}&issuer=Arkiv%20Admin` };
}

export interface StaffSession {
  sessionId: string;
  staffId: string;
  email: string;
  name: string;
  roles: StaffRoleT[];
  reauthAt: Date;
}
export interface RequestMeta {
  ip?: string | null;
  userAgent?: string | null;
}

// ── Network policy (plan 05 §0.1 "Optional IP allowlist per staff role, on by default for FINANCE and SUPER_ADMIN") ──

/** A syntactically valid client IP, or null ("unknown"). IPv4-mapped IPv6 addresses are unwrapped. */
export function normalizeIp(ip: string | null | undefined): string | null {
  const v = ip?.trim().replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i, '$1') ?? '';
  return v && isIP(v) ? v : null;
}

/**
 * Whether a staff member may use the console from `ip`. The networks that apply are the union of their roles'
 * enabled policies and their personal list; with none, any network is fine. When some apply, an unknown IP is
 * refused (fail closed: a missing X-Forwarded-For must not bypass the allowlist).
 */
export async function staffNetworkAllowed(tx: Tx, staff: { id: string; roles: readonly string[] }, ip: string | null | undefined): Promise<boolean> {
  const addr = normalizeIp(ip);
  const [r] = await tx`
    select count(*)::int as n, coalesce(bool_or(${addr}::inet <<= c), false) as ok from (
      select unnest(p.cidrs) as c from staff_role_ip_policies p where p.enabled and p.role = any(${staff.roles as string[]})
      union all
      select unnest(u.ip_allowlist) from staff_users u where u.id = ${staff.id}) x`;
  if (!r || Number(r.n) === 0) return true;
  return !!addr && r.ok === true;
}

async function loginFailed(tx: Tx, email: string, meta: RequestMeta) {
  // Committed (not thrown inside the tx) so failed attempts are always audited.
  await tx`insert into admin_audit_log (action, target_type, target_id, reason, ip, user_agent) values ('staff.login_failed', 'staff', ${email}, null, ${normalizeIp(meta.ip)}, ${meta.userAgent ?? null})`;
}

/** First factor: the staff row when the password matches (uniform failure otherwise; argon always runs). */
export async function staffPasswordFactor(tx: Tx, email: string, password: string, meta: RequestMeta) {
  const [s] = await tx`select * from staff_users where email = ${email.toLowerCase()} and active`;
  const okPw = s ? await argonVerify(s.password_hash as string, password) : await argonVerify('$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$Wf6n2cV2p6lzYxS2yXg9Rw', password).catch(() => false);
  if (!s || !okPw) {
    await loginFailed(tx, email, meta);
    return null;
  }
  return s;
}

type OpenResult = { token: string } | { failed: 'network' };

/** Second factor passed: check the network policy, then open an 8-hour session. */
export async function openStaffSession(tx: Tx, s: Record<string, unknown>, meta: RequestMeta, factor: 'totp' | 'passkey'): Promise<OpenResult> {
  const ip = normalizeIp(meta.ip);
  if (!(await staffNetworkAllowed(tx, { id: s.id as string, roles: s.roles as string[] }, ip))) {
    await tx`insert into admin_audit_log (staff_id, staff_roles, action, target_type, target_id, ip, user_agent) values (${s.id as string}, ${s.roles as string[]}, 'staff.login_blocked_ip', 'staff', ${s.id as string}, ${ip}, ${meta.userAgent ?? null})`;
    return { failed: 'network' };
  }
  const token = randomBytes(32).toString('base64url');
  await tx`insert into staff_sessions (staff_id, token_hash, expires_at, ip, user_agent) values (${s.id as string}, ${sha(token)}, now() + interval '8 hours', ${ip}, ${meta.userAgent ?? null})`;
  await tx`insert into admin_audit_log (staff_id, staff_roles, action, target_type, target_id, ip, user_agent, after)
           values (${s.id as string}, ${s.roles as string[]}, 'staff.login', 'staff', ${s.id as string}, ${ip}, ${meta.userAgent ?? null}, ${tx.json({ factor })})`;
  return { token };
}

export const NETWORK_REFUSED = 'Sign-in not allowed from this network.';

/** Password + authenticator code. Refused for staff who must use a passkey. */
export async function staffLogin(email: string, password: string, code: string, meta: RequestMeta) {
  const result = await withAdmin(async (tx): Promise<OpenResult | { failed: 'credentials' | 'passkey_required' }> => {
    const s = await staffPasswordFactor(tx, email, password, meta);
    if (!s || !s.totp_secret_enc || !verifyTotp(s.totp_secret_enc as string, code)) {
      if (s) await loginFailed(tx, email, meta);
      return { failed: 'credentials' };
    }
    if (s.require_passkey) {
      await tx`insert into admin_audit_log (staff_id, staff_roles, action, target_type, target_id, ip) values (${s.id}, ${s.roles}, 'staff.login_totp_refused', 'staff', ${s.id}, ${normalizeIp(meta.ip)})`;
      return { failed: 'passkey_required' };
    }
    return openStaffSession(tx, s, meta, 'totp');
  });
  if ('failed' in result) {
    const msg = result.failed === 'network' ? NETWORK_REFUSED : result.failed === 'passkey_required' ? 'This account signs in with a passkey. Use “Sign in with passkey”.' : 'Email, password or code is incorrect.';
    throw new DomainError('FORBIDDEN', msg);
  }
  return result.token;
}

/**
 * The session behind a console cookie, or null. Sessions end after 8 hours, or 30 idle minutes, or when the
 * request comes from a network the staff member's IP policy doesn't allow (checked on every request).
 */
export async function getStaffSession(token: string | undefined | null, meta: RequestMeta = {}): Promise<StaffSession | null> {
  if (!token) return null;
  return withAdmin(async (tx) => {
    const [s] = await tx`select ss.id, ss.staff_id, ss.last_seen_at, ss.reauth_at, u.email, u.name, u.roles, u.active
                         from staff_sessions ss join staff_users u on u.id = ss.staff_id
                         where ss.token_hash = ${sha(token)} and ss.revoked_at is null and ss.expires_at > now()`;
    if (!s || !s.active) return null;
    if (Date.now() - new Date(s.last_seen_at as string).getTime() > 30 * 60_000) {
      await tx`update staff_sessions set revoked_at = now() where id = ${s.id}`; // 30 min idle
      return null;
    }
    if (!(await staffNetworkAllowed(tx, { id: s.staff_id as string, roles: s.roles as string[] }, meta.ip))) return null;
    await tx`update staff_sessions set last_seen_at = now() where id = ${s.id}`;
    return { sessionId: s.id, staffId: s.staff_id, email: s.email, name: s.name, roles: s.roles as StaffRoleT[], reauthAt: new Date(s.reauth_at as string) };
  });
}

/** 🔐 actions need a fresh second factor within 5 minutes (plan 05 §0.1). TOTP here; passkey in staff-passkeys. */
export async function staffReauth(session: StaffSession, code: string) {
  await withAdmin(async (tx) => {
    const [s] = await tx`select totp_secret_enc, require_passkey from staff_users where id = ${session.staffId}`;
    if (s?.require_passkey) throw new DomainError('FORBIDDEN', 'Confirm with your passkey.', { passkey: true });
    if (!s?.totp_secret_enc || !verifyTotp(s.totp_secret_enc as string, code)) throw new DomainError('FORBIDDEN', 'Code is incorrect.');
    await tx`update staff_sessions set reauth_at = now() where id = ${session.sessionId}`;
  });
}
export function assertFreshReauth(s: Pick<StaffSession, 'reauthAt'>) {
  if (Date.now() - s.reauthAt.getTime() > 5 * 60_000) throw new DomainError('FORBIDDEN', 'Confirm it’s you (passkey or authenticator code) to continue.', { reauth: true });
}

export async function staffLogout(sessionId: string) {
  await withAdmin((tx) => tx`update staff_sessions set revoked_at = now() where id = ${sessionId}`);
}

/** Sign-out by cookie: ends the session even when the current network couldn't use it (IP policy). */
export async function staffLogoutToken(token: string | undefined | null) {
  if (!token) return;
  await withAdmin((tx) => tx`update staff_sessions set revoked_at = now() where token_hash = ${sha(token)} and revoked_at is null`);
}

export async function deprovisionStaff(tx: Tx, staffId: string) {
  await tx`update staff_users set active = false where id = ${staffId}`;
  await tx`update staff_sessions set revoked_at = now() where staff_id = ${staffId} and revoked_at is null`;
  await tx`update staff_invites set revoked_at = now() where staff_id = ${staffId} and accepted_at is null and revoked_at is null`;
}

// ── Invites (plan 05 §23 "Invite staff … require passkey") ──
// The inviter never learns either factor: the invitee opens a single-use link, sets their own password and enrols
// their authenticator (a passkey can be added after the first sign-in, or required by a SUPER_ADMIN).

export const STAFF_INVITE_HOURS = 48;
/** Never a valid Argon2 hash: an invited (inactive) staff row can't be signed into before the invite is accepted. */
const NO_PASSWORD = '!invited';

/**
 * Invite someone (admin role, inside the caller's transaction). The staff row starts inactive and without roles, so
 * requested roles can go through four-eyes meanwhile. Re-inviting a deprovisioned member reuses their row with its
 * roles cleared. Returns the link token (shown once, in the email).
 */
export async function inviteStaff(tx: Tx, input: { email: string; name: string; createdBy: string }) {
  const email = input.email.trim().toLowerCase();
  const [existing] = await tx`select id, active from staff_users where email = ${email} for update`;
  if (existing?.active) throw new DomainError('CONFLICT', `${email} already has an active staff account.`);
  let staffId = existing?.id as string | undefined;
  if (staffId) {
    const [open] = await tx`select 1 from staff_invites where staff_id = ${staffId} and accepted_at is null and revoked_at is null and expires_at > now()`;
    if (open) throw new DomainError('CONFLICT', `${email} already has an open invite. Resend it instead.`);
    await tx`update staff_users set name = ${input.name}, roles = '{}', password_hash = ${NO_PASSWORD}, totp_secret_enc = null, require_passkey = false where id = ${staffId}`;
  } else {
    const [s] = await tx`insert into staff_users (email, name, password_hash, roles, active) values (${email}, ${input.name}, ${NO_PASSWORD}, '{}', false) returning id`;
    staffId = s!.id as string;
  }
  return { staffId, ...(await issueInvite(tx, staffId, email, input.createdBy)) };
}

/** A fresh single-use link for an invited, not yet active member; earlier links stop working. */
export async function resendStaffInvite(tx: Tx, staffId: string, createdBy: string) {
  const [s] = await tx`select email, active from staff_users where id = ${staffId} for update`;
  if (!s) throw new DomainError('NOT_FOUND', 'Staff member not found');
  if (s.active) throw new DomainError('CONFLICT', 'This member has already accepted their invite.');
  const [inv] = await tx`select 1 from staff_invites where staff_id = ${staffId} and accepted_at is null`;
  if (!inv) throw new DomainError('CONFLICT', 'This member was deprovisioned. Invite them again.');
  return { email: s.email as string, ...(await issueInvite(tx, staffId, s.email as string, createdBy)) };
}

async function issueInvite(tx: Tx, staffId: string, email: string, createdBy: string) {
  await tx`update staff_invites set revoked_at = now() where staff_id = ${staffId} and accepted_at is null and revoked_at is null`;
  const token = randomBytes(32).toString('base64url');
  const [i] = await tx`insert into staff_invites (staff_id, email, token_hash, created_by, expires_at)
                       values (${staffId}, ${email}, ${sha(token)}, ${createdBy}, now() + make_interval(hours => ${STAFF_INVITE_HOURS})) returning id, expires_at`;
  return { inviteId: i!.id as string, token, expiresAt: new Date(i!.expires_at as string) };
}

async function openInvite(tx: Tx, token: string, lock = false) {
  const [i] = await tx`select i.id, i.staff_id, i.email, i.totp_secret, u.name, u.active from staff_invites i join staff_users u on u.id = i.staff_id
                       where i.token_hash = ${sha(token)} and i.accepted_at is null and i.revoked_at is null and i.expires_at > now()
                       ${lock ? tx`for update of i` : tx``}`;
  if (!i || i.active) throw new DomainError('NOT_FOUND', 'This invite link has expired or was already used. Ask a SUPER_ADMIN to resend it.');
  return i;
}

/**
 * The invite page: who it is for, and the authenticator secret to enrol (created on first view and kept on the
 * invite until accepted, so reloading the page shows the same one).
 */
export async function viewStaffInvite(token: string) {
  return withAdmin(async (tx) => {
    const i = await openInvite(tx, token, true);
    let secret = i.totp_secret as string | null;
    if (!secret) {
      secret = base32Encode(randomBytes(20));
      await tx`update staff_invites set totp_secret = ${secret} where id = ${i.id}`;
    }
    return { email: i.email as string, name: i.name as string, totpSecret: secret, otpauth: `otpauth://totp/Arkiv%20Admin:${encodeURIComponent(i.email as string)}?secret=${secret}&issuer=Arkiv%20Admin` };
  });
}

/** Accept: the invitee's own password and a code proving their authenticator is enrolled. Single use. */
export async function acceptStaffInvite(token: string, password: string, code: string, meta: RequestMeta = {}) {
  if (password.length < 14) throw new DomainError('INVALID', 'Staff passwords must be at least 14 characters.');
  return withAdmin(async (tx) => {
    const i = await openInvite(tx, token, true);
    if (!i.totp_secret || !verifyTotp(i.totp_secret as string, code)) throw new DomainError('INVALID', 'That code doesn’t match. Scan the secret again and enter the current code.');
    await tx`update staff_users set password_hash = ${await argonHash(password)}, totp_secret_enc = ${i.totp_secret as string}, active = true, roles_confirmed_at = now()
             where id = ${i.staff_id}`;
    await tx`update staff_invites set accepted_at = now() where id = ${i.id}`;
    const [u] = await tx`select roles from staff_users where id = ${i.staff_id}`;
    await tx`insert into admin_audit_log (staff_id, staff_roles, action, target_type, target_id, ip, user_agent)
             values (${i.staff_id}, ${u!.roles as string[]}, 'staff.invite_accepted', 'staff', ${i.staff_id as string}, ${normalizeIp(meta.ip)}, ${meta.userAgent ?? null})`;
    return { staffId: i.staff_id as string, email: i.email as string };
  });
}
