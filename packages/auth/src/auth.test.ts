import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool } from '@arkiv/db';
import { truncateAll } from '@arkiv/db/testing';
import { devOutbox } from '@arkiv/email';
import { consumeMagicLink, emailSuggestion, previewMagicLink, requestMagicLink } from './magic-link';
import { getSession, listSessions, revokeAllSessions } from './sessions';
import { base32Encode, createStaff, getStaffSession, staffLogin, totp, verifyTotp } from './staff';

beforeEach(async () => {
  await truncateAll();
  devOutbox.length = 0;
});
afterAll(closeAll);

const lastToken = () => /\/auth\/magic\/([A-Za-z0-9_-]+)/.exec(JSON.stringify(devOutbox.at(-1)?.data))![1]!;

describe('magic links (plan 03 Part C)', () => {
  it('sends, previews without consuming (scanner-safe), consumes once, creates a verified user + session', async () => {
    await requestMagicLink({ email: 'Founder@GlowLab.com', purpose: 'login', ip: '1.2.3.4' });
    const token = lastToken();
    expect((await previewMagicLink(token)).status).toBe('ok');
    expect((await previewMagicLink(token)).status).toBe('ok'); // GET twice (e.g. link scanner) doesn't burn it
    const r = await consumeMagicLink(token, { ip: '1.2.3.4' });
    expect(r.email).toBe('founder@glowlab.com');
    expect(r.created).toBe(true);
    const s = await getSession(r.token);
    expect(s?.email).toBe('founder@glowlab.com');
    await expect(consumeMagicLink(token, {})).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await previewMagicLink(token)).status).toBe('used');
  });

  it('rate-limits per mailbox including plus-addressing', async () => {
    for (let i = 0; i < 5; i++) await requestMagicLink({ email: `a+${i}@x.com`, purpose: 'login' });
    await expect(requestMagicLink({ email: 'a+9@x.com', purpose: 'login' })).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('suggests fixes for common email typos', () => {
    expect(emailSuggestion('jo@gmial.com')).toBe('jo@gmail.com');
  });

  it('revoking all sessions logs out other devices', async () => {
    await requestMagicLink({ email: 'b@x.com', purpose: 'login' });
    const a = await consumeMagicLink(lastToken(), {});
    await requestMagicLink({ email: 'b@x.com', purpose: 'login' });
    const b = await consumeMagicLink(lastToken(), {});
    expect(await listSessions(a.userId)).toHaveLength(2);
    const sa = await getSession(a.token);
    await revokeAllSessions(a.userId, sa!.sessionId);
    expect(await getSession(b.token)).toBeNull();
    expect(await getSession(a.token)).not.toBeNull();
  });

  it('locked users cannot sign in', async () => {
    await ownerPool()`insert into users (email, locked_at) values ('locked@x.com', now())`;
    await requestMagicLink({ email: 'locked@x.com', purpose: 'login' });
    await expect(consumeMagicLink(lastToken(), {})).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('staff auth (plan 05 §0)', () => {
  it('TOTP matches RFC 6238 test vector', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    expect(totp(secret, 59_000)).toBe('287082');
    expect(verifyTotp(secret, totp(secret))).toBe(true);
  });

  it('requires password + TOTP and audits failures', async () => {
    const s = await createStaff({ email: 'ops@arkiv.test', name: 'Ops', password: 'correct horse battery', roles: ['OPS'] });
    await expect(staffLogin('ops@arkiv.test', 'correct horse battery', '000000', {})).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const token = await staffLogin('ops@arkiv.test', 'correct horse battery', totp(s.totpSecret), { ip: '10.0.0.1' });
    const sess = await getStaffSession(token);
    expect(sess?.roles).toEqual(['OPS']);
    const audit = await ownerPool()`select action from admin_audit_log order by id`;
    expect(audit.map((a) => a.action)).toEqual(['staff.login_failed', 'staff.login']);
  });
});
