import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, globalTx, ownerPool } from '@arkiv/db';
import { truncateAll } from '@arkiv/db/testing';
import { devOutbox } from '@arkiv/email';
import { geoFromHeaders, geoLabel } from '@arkiv/shared';
import { consumeMagicLink, requestMagicLink } from './magic-link';
import { verifyPasskeyLogin } from './passkeys';
import { recordLoginFailure } from './login-attempts';

beforeEach(async () => {
  await truncateAll();
  devOutbox.length = 0;
});
afterAll(closeAll);

const lastToken = () => /\/auth\/magic\/([A-Za-z0-9_-]+)/.exec(JSON.stringify(devOutbox.at(-1)?.data))![1]!;
const geo = { city: 'Austin', region: 'TX', country: 'US' };

describe('failed sign-ins and session location (plan 05 §3)', () => {
  it('records a reused or expired magic link against the address, and a locked account as locked', async () => {
    await requestMagicLink({ email: 'founder@glowlab.com', purpose: 'login' });
    const token = lastToken();
    const ok = await consumeMagicLink(token, { ip: '203.0.113.5', userAgent: 'Safari', geo });
    const [s] = await ownerPool()`select geo from sessions`;
    expect(s!.geo).toEqual(geo);
    await expect(consumeMagicLink(token, { ip: '203.0.113.5', userAgent: 'Safari', geo })).rejects.toMatchObject({ code: 'CONFLICT' });
    await ownerPool()`update users set locked_at = now(), locked_reason = 'ATO' where id = ${ok.userId}`;
    await requestMagicLink({ email: 'founder@glowlab.com', purpose: 'login' });
    await expect(consumeMagicLink(lastToken(), { ip: 'not-an-ip' })).rejects.toThrow(/locked/);
    const rows = await ownerPool()`select email, user_id, method, outcome, reason, ip::text as ip, geo from login_attempts order by id`;
    expect(rows).toEqual([
      { email: 'founder@glowlab.com', user_id: ok.userId, method: 'magic_link', outcome: 'failed', reason: 'This link was already used.', ip: '203.0.113.5/32', geo },
      { email: 'founder@glowlab.com', user_id: ok.userId, method: 'magic_link', outcome: 'locked', reason: 'This account is locked. Contact support.', ip: null, geo: null },
    ]);
    // The customer app can write attempts but never read them back.
    await expect(globalTx((tx) => tx`select * from login_attempts`)).rejects.toThrow(/permission denied/);
  });

  it('records an unknown or unverifiable passkey', async () => {
    await globalTx((tx) => tx`insert into oauth_states (state, provider, code_verifier, expires_at) values ('auth:flow1', 'webauthn', 'challenge', now() + interval '5 minutes')`);
    await expect(verifyPasskeyLogin('flow1', { id: 'no-such-credential' } as never, { ip: '198.51.100.1' })).rejects.toThrow(/Unknown passkey/);
    await expect(verifyPasskeyLogin('flow-expired', { id: 'x' } as never, {})).rejects.toThrow(/expired/);
    const rows = await ownerPool()`select method, reason from login_attempts order by id`;
    expect(rows).toEqual([{ method: 'passkey', reason: 'Unknown passkey.' }, { method: 'passkey', reason: 'Passkey request expired. Try again.' }]);
  });

  it('never lets recording a failure break sign-in', async () => {
    await expect(recordLoginFailure('google', { email: 'x@example.com' }, 'r'.repeat(500), { ip: '::1', userAgent: 'u'.repeat(1000) })).resolves.toBeUndefined();
    const [r] = await ownerPool()`select length(reason) as r, length(user_agent) as u from login_attempts`;
    expect(r).toEqual({ r: 200, u: 300 });
  });

  it('reads the edge location headers and ignores unknown values', () => {
    const h = (o: Record<string, string>) => ({ get: (k: string) => o[k] ?? null });
    expect(geoFromHeaders(h({ 'cf-ipcountry': 'us', 'cf-region-code': 'TX', 'cf-ipcity': 'Austin' }))).toEqual({ city: 'Austin', region: 'TX', country: 'US' });
    expect(geoFromHeaders(h({ 'x-vercel-ip-country': 'DE', 'x-vercel-ip-city': 'M%C3%BCnchen', 'x-vercel-ip-country-region': 'BY' }))).toEqual({ city: 'München', region: 'BY', country: 'DE' });
    expect(geoFromHeaders(h({ 'cf-ipcountry': 'XX' }))).toBeNull();
    expect(geoFromHeaders(h({}))).toBeNull();
    expect(geoLabel({ city: 'Austin', region: null, country: 'US' })).toBe('Austin, US');
  });
});
