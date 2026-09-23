import { createHash, createHmac, randomBytes } from 'node:crypto';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import { adminPool, withAdmin, type Tx } from '@arkiv/db';
import { DomainError, StaffRole, type StaffRole as StaffRoleT } from '@arkiv/shared';

/**
 * Staff identity (plan 05 §0): separate table and sessions from customers; password (Argon2id) + mandatory
 * TOTP; 8h absolute / 30 min idle sessions; passkey-tap style re-auth modelled as a fresh TOTP within 5 min.
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

export async function staffLogin(email: string, password: string, code: string, meta: { ip?: string | null; userAgent?: string | null }) {
  const result = await withAdmin(async (tx) => {
    const [s] = await tx`select * from staff_users where email = ${email.toLowerCase()} and active`;
    // Uniform failure message; argon verify still runs to keep timing similar.
    const okPw = s ? await argonVerify(s.password_hash as string, password) : await argonVerify('$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$Wf6n2cV2p6lzYxS2yXg9Rw', password).catch(() => false);
    if (!s || !okPw || !s.totp_secret_enc || !verifyTotp(s.totp_secret_enc as string, code)) {
      // Committed (not thrown inside the tx) so failed attempts are always audited.
      await tx`insert into admin_audit_log (action, target_type, target_id, reason, ip, user_agent) values ('staff.login_failed', 'staff', ${email}, null, ${meta.ip ?? null}, ${meta.userAgent ?? null})`;
      return { failed: 'credentials' as const };
    }
    const allow = (s.ip_allowlist as string[] | null) ?? null;
    if (allow?.length && meta.ip && !allow.some((cidr) => ipInCidr(meta.ip!, cidr))) {
      await tx`insert into admin_audit_log (staff_id, action, target_type, target_id, ip) values (${s.id}, 'staff.login_blocked_ip', 'staff', ${s.id}, ${meta.ip})`;
      return { failed: 'network' as const };
    }
    const token = randomBytes(32).toString('base64url');
    await tx`insert into staff_sessions (staff_id, token_hash, expires_at, ip, user_agent) values (${s.id}, ${sha(token)}, now() + interval '8 hours', ${meta.ip ?? null}, ${meta.userAgent ?? null})`;
    await tx`insert into admin_audit_log (staff_id, staff_roles, action, target_type, target_id, ip, user_agent) values (${s.id}, ${s.roles}, 'staff.login', 'staff', ${s.id}, ${meta.ip ?? null}, ${meta.userAgent ?? null})`;
    return { token };
  });
  if ('failed' in result) {
    throw new DomainError('FORBIDDEN', result.failed === 'network' ? 'Sign-in not allowed from this network.' : 'Email, password or code is incorrect.');
  }
  return result.token;
}

export async function getStaffSession(token: string | undefined | null): Promise<StaffSession | null> {
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
    await tx`update staff_sessions set last_seen_at = now() where id = ${s.id}`;
    return { sessionId: s.id, staffId: s.staff_id, email: s.email, name: s.name, roles: s.roles as StaffRoleT[], reauthAt: new Date(s.reauth_at as string) };
  });
}

/** 🔐 actions need a fresh second factor within 5 minutes (plan 05 §0.1). */
export async function staffReauth(session: StaffSession, code: string) {
  await withAdmin(async (tx) => {
    const [s] = await tx`select totp_secret_enc from staff_users where id = ${session.staffId}`;
    if (!s?.totp_secret_enc || !verifyTotp(s.totp_secret_enc as string, code)) throw new DomainError('FORBIDDEN', 'Code is incorrect.');
    await tx`update staff_sessions set reauth_at = now() where id = ${session.sessionId}`;
  });
}
export function assertFreshReauth(s: StaffSession) {
  if (Date.now() - s.reauthAt.getTime() > 5 * 60_000) throw new DomainError('FORBIDDEN', 'Confirm with your authenticator code to continue.', { reauth: true });
}

export async function staffLogout(sessionId: string) {
  await withAdmin((tx) => tx`update staff_sessions set revoked_at = now() where id = ${sessionId}`);
}

export async function deprovisionStaff(tx: Tx, staffId: string) {
  await tx`update staff_users set active = false where id = ${staffId}`;
  await tx`update staff_sessions set revoked_at = now() where staff_id = ${staffId} and revoked_at is null`;
}

function ipInCidr(ip: string, cidr: string) {
  const [range, bitsS] = cidr.split('/');
  const bits = Number(bitsS ?? 32);
  const toInt = (x: string) => x.split('.').reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip) || !range) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (toInt(ip) & mask) === (toInt(range) & mask);
}
