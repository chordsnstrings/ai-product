import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, globalTx, ownerPool, withSystem } from '@arkiv/db';
import { truncateAll } from '@arkiv/db/testing';
import { devOutbox } from '@arkiv/email';
import { sweepSignInRecords } from '@arkiv/core';
import { MAGIC_LINK_TTL_MIN, PRIVACY_VERSION, TERMS_VERSION, disposableEmailDomain, emailSuggestion } from '@arkiv/shared';
import { claimToken, readClaimToken } from './claim';
import { consumeMagicLink, magicLinkStatus, previewMagicLink, requestMagicLink } from './magic-link';
import { MOCK_IDENTITIES, mockAuthorize, mockClientId, mockExchange, type MockIdentity, type OAuthProvider } from './mock-idp';
import { finishOAuth, providerEnabled, startOAuth } from './oauth';
import { passkeyLoginOptions, passkeyPromptEligible, passkeyRegistrationOptions, verifyPasskeyLogin, verifyPasskeyRegistration } from './passkeys';
import { passwordLogin, removePassword, setPassword } from './password';
import { safeRedirect } from './redirect';
import { createSession, getSession, rotateSession } from './sessions';
import { notifyIfNewDevice } from './signals';
import { assertLoginBudget, LOGIN_ATTEMPTS_PER_IP, TURNSTILE_DUMMY_TOKEN } from './turnstile';
import { SoftAuthenticator } from './webauthn-testing';

beforeEach(async () => {
  await truncateAll();
  devOutbox.length = 0;
});
afterAll(closeAll);

const lastToken = () => /\/auth\/magic\/([A-Za-z0-9_-]+)/.exec(JSON.stringify(devOutbox.at(-1)?.data))![1]!;
const APP = 'http://localhost:3000';

/** Drive the whole OAuth flow through the mock identity provider, as the browser would. */
async function oauth(p: OAuthProvider, identity: MockIdentity, opts: { binding?: string | null; redirectTo?: string; provisionalWorkspaceId?: string | null; linkUserId?: string; meta?: { ip?: string; userAgent?: string } } = {}) {
  const start = await startOAuth(p, { redirectTo: opts.redirectTo ?? null, provisionalWorkspaceId: opts.provisionalWorkspaceId ?? null, linkUserId: opts.linkUserId ?? null });
  const q = new URL(start.url).searchParams;
  const code = await mockAuthorize({ provider: p, clientId: q.get('client_id')!, redirectUri: q.get('redirect_uri')!, nonce: q.get('nonce')!, codeChallenge: q.get('code_challenge'), identity });
  const binding = opts.binding === undefined ? start.binding : opts.binding;
  return finishOAuth(p, { code, state: q.get('state')! }, opts.meta ?? {}, binding);
}
const google = MOCK_IDENTITIES.google[0]!.identity;
const appleRelay = MOCK_IDENTITIES.apple[1]!.identity;

describe('safe post-login redirects (auth-01)', () => {
  it('keeps same-site paths and refuses everything that can leave the site', () => {
    expect(safeRedirect('/concepts/abc?x=1#top')).toBe('/concepts/abc?x=1#top');
    expect(safeRedirect('/w/glow/settings/profile')).toBe('/w/glow/settings/profile');
    for (const bad of ['/\\evil.com', '/\\/evil.com', decodeURIComponent('/%5Cevil.com'), '/%5Cevil.com', '/%2F/evil.com', '/\tevil', '/\n/evil.com', 'https://evil.com', '//evil.com', 'evil.com', '', null, undefined]) {
      expect(safeRedirect(bad as string), String(bad)).toBeNull();
    }
    // What a browser would do with the classic trick: it must not be what we return.
    expect(new URL('/\\evil.com', APP).origin).toBe('http://evil.com');
  });

  it('magic links and OAuth states store only a safe destination', async () => {
    await requestMagicLink({ email: 'r@glowlab.com', purpose: 'login', redirectTo: '/\\evil.com' });
    const r = await consumeMagicLink(lastToken(), {});
    expect(r.redirectTo).toBeNull();
    const s = await oauth('google', google, { redirectTo: '/\\evil.com' });
    expect(s.redirectTo).toBeNull();
  });
});

describe('Google / Apple through the mock identity provider (auth-16, auth-02, auth-17)', () => {
  it('is available in mock mode and signs in a new user with a verified email, recording method and terms', async () => {
    expect(providerEnabled('google')).toBe(true);
    expect(providerEnabled('apple')).toBe(true);
    const r = await oauth('google', google, { redirectTo: '/concepts/x', meta: { ip: '198.51.100.7' } });
    expect(r).toMatchObject({ kind: 'session', email: 'founder@glowlab.test', created: true, redirectTo: '/concepts/x' });
    if (r.kind !== 'session') throw new Error('expected a session');
    expect((await getSession(r.token))?.email).toBe('founder@glowlab.test');
    const [u] = await ownerPool()`select u.terms_version, u.privacy_version, u.terms_method, u.terms_accepted_at is not null as accepted, s.method
                                  from users u join sessions s on s.user_id = u.id`;
    expect(u).toEqual({ terms_version: TERMS_VERSION, privacy_version: PRIVACY_VERSION, terms_method: 'google', accepted: true, method: 'google' });
  });

  it('links Apple to the Google account with the same verified email; the Apple relay makes a separate user', async () => {
    const g = await oauth('google', google);
    const a = await oauth('apple', MOCK_IDENTITIES.apple[0]!.identity);
    expect(a.userId).toBe(g.userId);
    const relay = await oauth('apple', appleRelay);
    expect(relay.userId).not.toBe(g.userId);
    expect(relay.email).toBe('k7x2q9@privaterelay.appleid.com');
  });

  it('refuses a callback without the starting browser’s binding cookie, or with another one (login CSRF)', async () => {
    await expect(oauth('google', google, { binding: null })).rejects.toMatchObject({ code: 'INVALID' });
    await expect(oauth('google', google, { binding: 'someone-elses-binding-value' })).rejects.toMatchObject({ code: 'INVALID' });
    // The attacker's state survives a wrong-binding attempt only until it expires; nobody was signed in.
    expect(await ownerPool()`select 1 from sessions`).toHaveLength(0);
  });

  it('refuses a tampered code, a wrong PKCE verifier and an unverified email', async () => {
    const start = await startOAuth('google', {});
    const q = new URL(start.url).searchParams;
    const code = await mockAuthorize({ provider: 'google', clientId: mockClientId('google'), redirectUri: q.get('redirect_uri')!, nonce: q.get('nonce')!, codeChallenge: q.get('code_challenge'), identity: google });
    await expect(mockExchange('google', code, { clientId: mockClientId('google'), redirectUri: q.get('redirect_uri')!, codeVerifier: 'wrong' })).rejects.toMatchObject({ code: 'INVALID' });
    await expect(finishOAuth('google', { code: `${code}x`, state: q.get('state')! }, {}, start.binding)).rejects.toThrow();
    await expect(oauth('google', MOCK_IDENTITIES.google[1]!.identity)).rejects.toThrow(/isn’t verified/);
  });

  it('refuses a locked or deleted user on the existing-identity path and records it', async () => {
    const r = await oauth('google', google);
    await ownerPool()`update users set locked_at = now(), locked_reason = 'ATO' where id = ${r.userId}`;
    await expect(oauth('google', google)).rejects.toMatchObject({ code: 'FORBIDDEN', message: expect.stringMatching(/locked/) });
    await ownerPool()`update users set locked_at = null, deleted_at = now() where id = ${r.userId}`;
    await expect(oauth('google', google)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await ownerPool()`select count(*)::int as n from sessions where user_id = ${r.userId}`).toEqual([{ n: 1 }]);
    const failed = await ownerPool()`select method, outcome from login_attempts order by id`;
    expect(failed).toEqual([{ method: 'google', outcome: 'locked' }, { method: 'google', outcome: 'failed' }]);
  });

  it('links an identity to the signed-in user from Profile, refuses one owned by another user, and emails a notice', async () => {
    await requestMagicLink({ email: 'owner@glowlab.com', purpose: 'login' });
    const me = await consumeMagicLink(lastToken(), {});
    devOutbox.length = 0;
    const linked = await oauth('apple', appleRelay, { linkUserId: me.userId, redirectTo: '/w/glow/settings/profile' });
    expect(linked).toEqual({ kind: 'linked', userId: me.userId, email: appleRelay.email, redirectTo: '/w/glow/settings/profile' });
    expect(devOutbox.map((m) => [m.template, m.to])).toEqual([['security_alert', 'owner@glowlab.com']]);
    // Signing in with the relay now reaches the same account (plan 03 Part C: "two users unless linked").
    const back = await oauth('apple', appleRelay);
    expect(back.userId).toBe(me.userId);
    const other = await oauth('google', google);
    await expect(oauth('google', google, { linkUserId: me.userId, redirectTo: '/w/glow/settings/profile' })).rejects.toMatchObject({
      code: 'CONFLICT',
      details: expect.objectContaining({ linkRedirect: '/w/glow/settings/profile' }),
    });
    const idents = await ownerPool()`select user_id, provider from user_identities where provider = 'google'`;
    expect(idents).toEqual([{ user_id: other.userId, provider: 'google' }]);
  });

  it('flags a new account on a disposable domain, once, without refusing it (auth-21)', async () => {
    expect(disposableEmailDomain('a@mailinator.com')).toBe('mailinator.com');
    expect(disposableEmailDomain('a@x.yopmail.com')).toBe('yopmail.com');
    expect(disposableEmailDomain('a@glowlab.com')).toBeNull();
    const r = await oauth('google', { sub: 'g-throwaway', email: 'x@mailinator.com', emailVerified: true });
    expect(r.kind).toBe('session');
    await oauth('google', { sub: 'g-throwaway', email: 'x@mailinator.com', emailVerified: true }); // existing user: no new signal
    await requestMagicLink({ email: 'y@yopmail.com', purpose: 'login', ip: '203.0.113.9' });
    await requestMagicLink({ email: 'y@yopmail.com', purpose: 'login', ip: '203.0.113.9' });
    expect(await ownerPool()`select 1 from abuse_signals where key = 'domain:yopmail.com'`).toHaveLength(0); // flagged on sign-up, not per request
    await consumeMagicLink(lastToken(), { ip: '203.0.113.9' });
    const signals = await ownerPool()`select kind, key, detail from abuse_signals order by id`;
    expect(signals).toEqual([
      { kind: 'disposable_email', key: 'domain:mailinator.com', detail: { ip: null, method: 'google' } },
      { kind: 'disposable_email', key: 'domain:yopmail.com', detail: { ip: '203.0.113.9', method: 'magic_link' } },
    ]);
  });
});

describe('magic links (auth-05, auth-07, auth-08, auth-22)', () => {
  it('records who consumed a link, for "Already signed in" in the same browser', async () => {
    await requestMagicLink({ email: 'twice@glowlab.com', purpose: 'login', redirectTo: '/app/plan' });
    const token = lastToken();
    const r = await consumeMagicLink(token, {});
    const p = await previewMagicLink(token);
    expect(p).toMatchObject({ status: 'used', consumedUserId: r.userId, consumedSessionId: r.sessionId, redirectTo: '/app/plan' });
  });

  it('tells the requesting tab when its link was used, via a handle only that tab holds', async () => {
    const { pendingHandle } = await requestMagicLink({ email: 'tab@glowlab.com', purpose: 'login' });
    expect(await magicLinkStatus(pendingHandle)).toBe('pending');
    expect(await magicLinkStatus('x'.repeat(32))).toBe('unknown');
    await consumeMagicLink(lastToken(), {});
    expect(await magicLinkStatus(pendingHandle)).toBe('consumed');
    const again = await requestMagicLink({ email: 'tab@glowlab.com', purpose: 'login' });
    await ownerPool()`update magic_links set expires_at = now() - interval '1 minute' where consumed_at is null`;
    expect(await magicLinkStatus(again.pendingHandle)).toBe('expired');
  });

  it('shares the 15-minute lifetime with the email copy, and suggests typo fixes client-side too', async () => {
    expect(MAGIC_LINK_TTL_MIN).toBe(15);
    await requestMagicLink({ email: 'ttl@glowlab.com', purpose: 'claim', productName: 'Serum No. 3' });
    const html = devOutbox.at(-1)!.html;
    expect(html).toContain(`${MAGIC_LINK_TTL_MIN} minutes`);
    expect(html).toContain('Serum No. 3 catalogue and 3 ad ideas are saved');
    expect(html).not.toContain('being prepared');
    expect(emailSuggestion('jo@gmial.com')).toBe('jo@gmail.com');
    expect(emailSuggestion('jo@gmail.com')).toBeNull();
  });
});

describe('new-device security email (auth-24)', () => {
  it('stays quiet for the first sign-in and a known device, and emails for a new browser or network', async () => {
    const mac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
    const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
    const login = async (ua: string, ip: string) => {
      await requestMagicLink({ email: 'dev@glowlab.com', purpose: 'login' });
      const token = lastToken();
      devOutbox.length = 0;
      await consumeMagicLink(token, { ip, userAgent: ua });
      return devOutbox.filter((m) => m.template === 'security_alert');
    };
    expect(await login(mac, '203.0.113.10')).toHaveLength(0); // account creation
    expect(await login(mac, '203.0.113.99')).toHaveLength(0); // same browser, same /24
    const alerts = await login(iphone, '198.51.100.4');
    expect(alerts).toHaveLength(1);
    expect((alerts[0]!.data as { event: string }).event).toBe('New sign-in on Safari on iOS');
  });

  it('never throws', async () => {
    await expect(notifyIfNewDevice('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000', {})).resolves.toBe(false);
  });
});

describe('sessions (auth-13, auth-17)', () => {
  it('rotation revokes the old token, keeps the sign-in time and device, and refuses a revoked session', async () => {
    await requestMagicLink({ email: 'rot@glowlab.com', purpose: 'login' });
    const r = await consumeMagicLink(r0(), { ip: '203.0.113.5', userAgent: 'Safari' });
    const before = await getSession(r.token);
    const n = await rotateSession(r.sessionId, r.userId);
    expect(await getSession(r.token)).toBeNull();
    const after = await getSession(n.token);
    expect(after?.userId).toBe(r.userId);
    expect(after?.createdAt).toEqual(before?.createdAt);
    const [row] = await ownerPool()`select ip::text as ip, user_agent, method from sessions where id = ${n.sessionId}`;
    expect(row).toEqual({ ip: '203.0.113.5/32', user_agent: 'Safari', method: 'magic_link' });
    await expect(rotateSession(r.sessionId, r.userId)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('createSession refuses a locked account whatever the path', async () => {
    const [u] = await ownerPool()`insert into users (email, locked_at) values ('lk@x.com', now()) returning id`;
    await expect(createSession(u!.id as string)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('passkeys: discoverable credentials only, a locked user is refused, sign-in records the method', async () => {
    await requestMagicLink({ email: 'pk@glowlab.com', purpose: 'login' });
    const me = await consumeMagicLink(lastToken(), {});
    expect(await passkeyPromptEligible(me.userId)).toBe(true);
    const reg = await passkeyRegistrationOptions({ userId: me.userId, email: 'pk@glowlab.com' });
    expect(reg.authenticatorSelection?.residentKey).toBe('required');
    const device = new SoftAuthenticator('localhost', APP);
    await verifyPasskeyRegistration({ userId: me.userId }, device.register(reg.challenge));
    expect(await passkeyPromptEligible(me.userId)).toBe(false);
    const a = await passkeyLoginOptions();
    const s = await verifyPasskeyLogin(a.flow, device.authenticate(a.options.challenge), {});
    expect((await getSession(s.token))?.userId).toBe(me.userId);
    await ownerPool()`update users set locked_at = now() where id = ${me.userId}`;
    const b = await passkeyLoginOptions();
    await expect(verifyPasskeyLogin(b.flow, device.authenticate(b.options.challenge), {})).rejects.toThrow(/locked/);
    const methods = await ownerPool()`select method from sessions order by created_at`;
    expect(methods.map((m) => m.method)).toEqual(['magic_link', 'passkey']);
  });
});

function r0() {
  return lastToken();
}

describe('optional password (auth-09)', () => {
  it('sets, signs in, refuses uniformly, and removes', async () => {
    await requestMagicLink({ email: 'pw@glowlab.com', purpose: 'login' });
    const me = await consumeMagicLink(lastToken(), {});
    await expect(setPassword(me.userId, 'short')).rejects.toMatchObject({ code: 'INVALID' });
    await expect(setPassword(me.userId, 'pw@glowlab.com')).rejects.toMatchObject({ code: 'INVALID' });
    await expect(setPassword(me.userId, 'aaaaaaaaaaaa')).rejects.toMatchObject({ code: 'INVALID' });
    await setPassword(me.userId, 'correct horse battery');
    const [h] = await ownerPool()`select password_hash from users where id = ${me.userId}`;
    expect(String(h!.password_hash)).toMatch(/^\$argon2id\$/);
    const ok = await passwordLogin('PW@glowlab.com', 'correct horse battery', { ip: '203.0.113.1' });
    expect((await getSession(ok.token))?.userId).toBe(me.userId);
    const wrong = passwordLogin('pw@glowlab.com', 'nope nope nope', {});
    await expect(wrong).rejects.toMatchObject({ code: 'UNAUTHENTICATED', message: 'Email or password is wrong.' });
    await expect(passwordLogin('nobody@glowlab.com', 'whatever whatever', {})).rejects.toMatchObject({ message: 'Email or password is wrong.' });
    await removePassword(me.userId);
    await expect(passwordLogin('pw@glowlab.com', 'correct horse battery', {})).rejects.toMatchObject({ message: 'Email or password is wrong.' });
    const failed = await ownerPool()`select method, email from login_attempts order by id`;
    expect(failed).toEqual([
      { method: 'password', email: 'pw@glowlab.com' },
      { method: 'password', email: 'nobody@glowlab.com' },
      { method: 'password', email: 'pw@glowlab.com' },
    ]);
  });

  it('a locked account is refused even with the right password', async () => {
    await requestMagicLink({ email: 'pwl@glowlab.com', purpose: 'login' });
    const me = await consumeMagicLink(lastToken(), {});
    await setPassword(me.userId, 'correct horse battery');
    await ownerPool()`update users set locked_at = now() where id = ${me.userId}`;
    await expect(passwordLogin('pwl@glowlab.com', 'correct horse battery', {})).rejects.toThrow(/locked/);
  });
});

describe('login budget and Turnstile escalation (auth-03)', () => {
  it('allows 10 attempts per IP per 15 minutes, then asks for the human check', async () => {
    for (let i = 0; i < LOGIN_ATTEMPTS_PER_IP; i++) await assertLoginBudget('203.0.113.50');
    await expect(assertLoginBudget('203.0.113.50')).rejects.toMatchObject({ code: 'RATE_LIMITED', details: expect.objectContaining({ challenge: true, siteKey: expect.any(String) }) });
    await expect(assertLoginBudget('203.0.113.50', 'not-a-valid-token')).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    // Mock mode without Turnstile keys accepts the test widget's dummy token.
    await expect(assertLoginBudget('203.0.113.50', TURNSTILE_DUMMY_TOKEN)).resolves.toBeUndefined();
    // Other networks are unaffected.
    await expect(assertLoginBudget('198.51.100.50')).resolves.toBeUndefined();
    await expect(assertLoginBudget(null)).resolves.toBeUndefined();
  });

  it('a staff-forced challenge applies from the first attempt; a blocked range is refused', async () => {
    const staffId = '00000000-0000-4000-8000-000000000001';
    await ownerPool()`insert into abuse_overrides (key, force_challenge, reason, until, created_by) values ('ip:192.0.2', true, 'bot burst', now() + interval '1 day', ${staffId})`;
    await expect(assertLoginBudget('192.0.2.7')).rejects.toMatchObject({ details: expect.objectContaining({ challenge: true }) });
    await expect(assertLoginBudget('192.0.2.7', TURNSTILE_DUMMY_TOKEN)).resolves.toBeUndefined();
    await ownerPool()`insert into ip_blocks (cidr, reason, until, created_by) values ('198.18.0.0/24', 'abuse', now() + interval '1 day', ${staffId})`;
    await expect(assertLoginBudget('198.18.0.9', TURNSTILE_DUMMY_TOKEN)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('existing-account claim token (auth-18)', () => {
  it('is bound to the user and expires', () => {
    const t = claimToken('11111111-1111-1111-1111-111111111111', 'user-a', 'google');
    expect(readClaimToken(t, 'user-a')).toEqual({ provisionalWorkspaceId: '11111111-1111-1111-1111-111111111111', method: 'google' });
    expect(readClaimToken(t, 'user-b')).toBeNull();
    expect(readClaimToken(`${t}x`, 'user-a')).toBeNull();
    expect(readClaimToken(t, 'user-a', Date.now() + 2 * 3600_000)).toBeNull();
    expect(readClaimToken('garbage', 'user-a')).toBeNull();
  });
});

describe('sign-in record retention (auth-25)', () => {
  it('drops old failed attempts, finished sessions, links and stale challenges; keeps live sessions', async () => {
    await requestMagicLink({ email: 'old@glowlab.com', purpose: 'login' });
    const live = await consumeMagicLink(lastToken(), {});
    await requestMagicLink({ email: 'old@glowlab.com', purpose: 'login' });
    const old = await consumeMagicLink(lastToken(), {});
    await ownerPool()`update sessions set revoked_at = now() - interval '200 days', last_seen_at = now() - interval '200 days' where id = ${old.sessionId}`;
    await ownerPool()`update sessions set last_seen_at = now() - interval '200 days' where id = ${live.sessionId}`;
    await ownerPool()`update magic_links set created_at = now() - interval '181 days'`;
    await ownerPool()`insert into login_attempts (email, method, at) values ('old@glowlab.com', 'google', now() - interval '181 days'), ('old@glowlab.com', 'google', now())`;
    await globalTx((tx) => tx`insert into oauth_states (state, provider, expires_at) values ('stale', 'google', now() - interval '2 days'), ('fresh', 'google', now() + interval '5 minutes')`);
    expect(await withSystem((tx) => sweepSignInRecords(tx))).toBe(1 + 1 + 2 + 1);
    expect((await ownerPool()`select id from sessions`).map((r) => r.id)).toEqual([live.sessionId]);
    expect(await ownerPool()`select state from oauth_states`).toEqual([{ state: 'fresh' }]);
    expect(await ownerPool()`select count(*)::int as n from login_attempts`).toEqual([{ n: 1 }]);
  });
});
