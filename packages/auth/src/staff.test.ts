import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool, withAdmin } from '@arkiv/db';
import { truncateAll } from '@arkiv/db/testing';
import { createStaff, getStaffSession, normalizeIp, staffLogin, staffLogoutToken, staffReauth, totp, type StaffSession } from './staff';
import {
  listStaffPasskeys,
  removeStaffPasskey,
  staffPasskeyLogin,
  staffPasskeyLoginOptions,
  staffPasskeyReauth,
  staffPasskeyReauthOptions,
  staffPasskeyRegistrationOptions,
  verifyStaffPasskeyRegistration,
} from './staff-passkeys';
import { SoftAuthenticator } from './webauthn-testing';

beforeEach(truncateAll);
afterAll(closeAll);

const PW = 'correct horse battery staple';
const ADMIN = { rpId: 'localhost', origin: 'http://localhost:3001' }; // ADMIN_URL default in tests

async function signedIn(email: string, roles: Parameters<typeof createStaff>[0]['roles'], ip = '10.0.0.5') {
  const s = await createStaff({ email, name: email.split('@')[0]!, password: PW, roles });
  const token = await staffLogin(email, PW, totp(s.totpSecret), { ip });
  const session = (await getStaffSession(token, { ip }))!;
  return { ...s, token, session };
}

describe('staff IP allowlist per role (plan 05 §0.1)', () => {
  it('is enforced at sign-in and on every request, and refuses an unknown IP once a policy applies', async () => {
    const fin = await createStaff({ email: 'fin@arkiv.test', name: 'Fin', password: PW, roles: ['FINANCE'] });
    const sup = await createStaff({ email: 'sup@arkiv.test', name: 'Sup', password: PW, roles: ['SUPPORT'] });
    // On by default for FINANCE, but not enforced until a network is listed.
    await ownerPool()`insert into staff_role_ip_policies (role, enabled, cidrs) values ('FINANCE', true, '{}'), ('SUPPORT', false, '{198.51.100.0/24}')`;
    const early = await staffLogin('fin@arkiv.test', PW, totp(fin.totpSecret), { ip: null });
    expect(await getStaffSession(early, {})).not.toBeNull();

    await ownerPool()`update staff_role_ip_policies set cidrs = '{203.0.113.0/24, 2001:db8::/32}' where role = 'FINANCE'`;
    // The session opened from an unknown network no longer works…
    expect(await getStaffSession(early, { ip: '192.0.2.10' })).toBeNull();
    expect(await getStaffSession(early, {})).toBeNull(); // …and a missing X-Forwarded-For doesn't bypass it
    // …but it isn't revoked: from the office it still works.
    expect(await getStaffSession(early, { ip: '203.0.113.9' })).not.toBeNull();
    expect(await getStaffSession(early, { ip: '::ffff:203.0.113.9' })).not.toBeNull();
    expect(await getStaffSession(early, { ip: '2001:db8::1' })).not.toBeNull();

    await expect(staffLogin('fin@arkiv.test', PW, totp(fin.totpSecret), { ip: '192.0.2.10' })).rejects.toThrow(/not allowed from this network/);
    await expect(staffLogin('fin@arkiv.test', PW, totp(fin.totpSecret), { ip: null })).rejects.toThrow(/not allowed from this network/);
    await expect(staffLogin('fin@arkiv.test', PW, totp(fin.totpSecret), { ip: 'not-an-ip' })).rejects.toThrow(/not allowed from this network/);
    await staffLogin('fin@arkiv.test', PW, totp(fin.totpSecret), { ip: '203.0.113.200' });
    // A disabled policy doesn't apply; SUPPORT signs in from anywhere.
    await staffLogin('sup@arkiv.test', PW, totp(sup.totpSecret), { ip: '192.0.2.10' });
    // A personal allowlist also applies (union with the role's networks).
    await ownerPool()`update staff_users set ip_allowlist = '{192.0.2.0/28}' where id = ${sup.staffId}`;
    await expect(staffLogin('sup@arkiv.test', PW, totp(sup.totpSecret), { ip: '192.0.2.100' })).rejects.toThrow(/network/);
    await staffLogin('sup@arkiv.test', PW, totp(sup.totpSecret), { ip: '192.0.2.10' });
    const blocked = await ownerPool()`select count(*)::int as n from admin_audit_log where action = 'staff.login_blocked_ip'`;
    expect(blocked[0]!.n).toBe(4);
    // Signing out works from anywhere: the session ends even though this network can't use it.
    await staffLogoutToken(early);
    expect(await getStaffSession(early, { ip: '203.0.113.9' })).toBeNull();
  });

  it('normalises client IPs', () => {
    expect(normalizeIp(' 203.0.113.9 ')).toBe('203.0.113.9');
    expect(normalizeIp('::ffff:10.1.2.3')).toBe('10.1.2.3');
    expect(normalizeIp('unknown')).toBeNull();
    expect(normalizeIp(undefined)).toBeNull();
  });
});

describe('staff passkeys (plan 05 §0.1, §23)', () => {
  it('registers a passkey, signs in with password + passkey, and re-authenticates with a tap', async () => {
    const a = await signedIn('ops@arkiv.test', ['OPS']);
    const key = new SoftAuthenticator(ADMIN.rpId, ADMIN.origin);
    const opts = await staffPasskeyRegistrationOptions(a.session);
    expect(opts.authenticatorSelection?.userVerification).toBe('required');
    await verifyStaffPasskeyRegistration(a.session, key.register(opts.challenge), 'YubiKey');
    expect((await listStaffPasskeys(a.staffId)).map((p) => p.name)).toEqual(['YubiKey']);
    // A registration challenge is single use.
    await expect(verifyStaffPasskeyRegistration(a.session, key.register(opts.challenge))).rejects.toThrow(/expired/);

    // Sign-in: password first (uniform failure), then the passkey bound to that account.
    await expect(staffPasskeyLoginOptions('ops@arkiv.test', 'wrong password!!', {})).rejects.toThrow(/incorrect/);
    const lo = await staffPasskeyLoginOptions('ops@arkiv.test', PW, {});
    expect(lo.options.allowCredentials?.map((c) => c.id)).toEqual([key.id]);
    const token = await staffPasskeyLogin(lo.flow, key.authenticate(lo.options.challenge), { ip: '10.0.0.6' });
    const s = (await getStaffSession(token, {}))!;
    expect(s.staffId).toBe(a.staffId);
    const [login] = await ownerPool()`select after from admin_audit_log where action = 'staff.login' order by id desc limit 1`;
    expect(login!.after).toEqual({ factor: 'passkey' });
    // A signature for another origin (phishing page) is refused.
    const lo2 = await staffPasskeyLoginOptions('ops@arkiv.test', PW, {});
    await expect(staffPasskeyLogin(lo2.flow, key.authenticate(lo2.options.challenge, { origin: 'https://arkiv-admin.evil.test' }), {})).rejects.toThrow(/could not be verified/);

    // 🔐 re-auth tap refreshes reauth_at.
    await ownerPool()`update staff_sessions set reauth_at = now() - interval '1 hour' where id = ${s.sessionId}`;
    const ro = await staffPasskeyReauthOptions(s);
    await staffPasskeyReauth(s, key.authenticate(ro!.challenge));
    const [fresh] = await ownerPool()`select reauth_at > now() - interval '1 minute' as fresh from staff_sessions where id = ${s.sessionId}`;
    expect(fresh!.fresh).toBe(true);
  });

  it('never accepts another staff member’s passkey', async () => {
    const a = await signedIn('a@arkiv.test', ['OPS']);
    const b = await signedIn('b@arkiv.test', ['OPS']);
    const keyA = new SoftAuthenticator(ADMIN.rpId, ADMIN.origin);
    const keyB = new SoftAuthenticator(ADMIN.rpId, ADMIN.origin);
    await verifyStaffPasskeyRegistration(a.session, keyA.register((await staffPasskeyRegistrationOptions(a.session)).challenge));
    await verifyStaffPasskeyRegistration(b.session, keyB.register((await staffPasskeyRegistrationOptions(b.session)).challenge));
    const lo = await staffPasskeyLoginOptions('b@arkiv.test', PW, {});
    await expect(staffPasskeyLogin(lo.flow, keyA.authenticate(lo.options.challenge), {})).rejects.toThrow(/isn’t registered to this account/);
    const ro = await staffPasskeyReauthOptions(b.session);
    await expect(staffPasskeyReauth(b.session, keyA.authenticate(ro!.challenge))).rejects.toThrow(/isn’t registered/);
  });

  it('require passkey: authenticator codes stop working for sign-in and re-auth; the last passkey stays', async () => {
    const a = await signedIn('fin2@arkiv.test', ['FINANCE']);
    const key = new SoftAuthenticator(ADMIN.rpId, ADMIN.origin);
    await verifyStaffPasskeyRegistration(a.session, key.register((await staffPasskeyRegistrationOptions(a.session)).challenge));
    await ownerPool()`update staff_users set require_passkey = true where id = ${a.staffId}`;
    await expect(staffLogin('fin2@arkiv.test', PW, totp(a.totpSecret), {})).rejects.toThrow(/signs in with a passkey/);
    // A wrong code still gets the uniform message (no hint that the account requires a passkey).
    await expect(staffLogin('fin2@arkiv.test', PW, '000000', {})).rejects.toThrow(/incorrect/);
    await expect(staffReauth(a.session as StaffSession, totp(a.totpSecret))).rejects.toThrow(/passkey/);
    const [pk] = await listStaffPasskeys(a.staffId);
    await expect(withAdmin((tx) => removeStaffPasskey(tx, a.staffId, pk!.id as string))).rejects.toThrow(/requires a passkey/);
    const lo = await staffPasskeyLoginOptions('fin2@arkiv.test', PW, {});
    expect(await staffPasskeyLogin(lo.flow, key.authenticate(lo.options.challenge), {})).toBeTruthy();
  });

  it('password + passkey sign-in explains when no passkey is registered yet', async () => {
    await createStaff({ email: 'new@arkiv.test', name: 'New', password: PW, roles: ['SUPPORT'] });
    await expect(staffPasskeyLoginOptions('new@arkiv.test', PW, {})).rejects.toThrow(/No passkey is registered/);
  });
});
