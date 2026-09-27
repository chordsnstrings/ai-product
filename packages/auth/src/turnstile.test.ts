import { afterEach, describe, expect, it } from 'vitest';
import { env, resetEnvCache } from '@arkiv/shared';
import { verifyTurnstile } from './turnstile';

/**
 * Plan 03 P1 edge cases: bot traffic gets an invisible Turnstile challenge on submit only. Uses Cloudflare's
 * documented test keys; siteverify is stubbed so the suite runs offline.
 */
const TEST_SITE_KEY = '1x00000000000000000000AA'; // always passes, invisible
const PASS_SECRET = '1x0000000000000000000000000000000AA';
const FAIL_SECRET = '2x0000000000000000000000000000000AA';

/** Behaves like siteverify for Cloudflare's test secrets. */
const siteverify: typeof fetch = async (_url, init) => {
  const body = new URLSearchParams(String(init?.body));
  const success = body.get('secret') === PASS_SECRET && !!body.get('response');
  return new Response(JSON.stringify({ success, 'error-codes': success ? [] : ['invalid-input-response'] }), { status: 200 });
};

afterEach(() => {
  delete process.env.TURNSTILE_SECRET;
  delete process.env.TURNSTILE_SITE_KEY;
  resetEnvCache();
});

describe('Turnstile', () => {
  it('accepts a token that siteverify accepts and forwards secret, token and client IP', async () => {
    let sent: URLSearchParams | null = null;
    const spy: typeof fetch = async (url, init) => {
      sent = new URLSearchParams(String(init?.body));
      return siteverify(url, init);
    };
    expect(await verifyTurnstile('XXXX.DUMMY.TOKEN.XXXX', PASS_SECRET, '203.0.113.7', spy)).toBe(true);
    expect(sent!.get('secret')).toBe(PASS_SECRET);
    expect(sent!.get('response')).toBe('XXXX.DUMMY.TOKEN.XXXX');
    expect(sent!.get('remoteip')).toBe('203.0.113.7');
  });

  it('rejects a missing token, a failing secret, an HTTP error and a network error', async () => {
    expect(await verifyTurnstile(null, PASS_SECRET, null, siteverify)).toBe(false);
    expect(await verifyTurnstile('XXXX.DUMMY.TOKEN.XXXX', FAIL_SECRET, null, siteverify)).toBe(false);
    expect(await verifyTurnstile('t', PASS_SECRET, null, async () => new Response('oops', { status: 500 }))).toBe(false);
    expect(await verifyTurnstile('t', PASS_SECRET, null, async () => Promise.reject(new Error('offline')))).toBe(false);
  });

  it('requires the site key and the secret together (a lone secret would block every preview)', () => {
    process.env.TURNSTILE_SECRET = PASS_SECRET;
    resetEnvCache();
    expect(() => env()).toThrow(/set together/);
    process.env.TURNSTILE_SITE_KEY = TEST_SITE_KEY;
    resetEnvCache();
    expect(env().TURNSTILE_SITE_KEY).toBe(TEST_SITE_KEY);
  });
});
