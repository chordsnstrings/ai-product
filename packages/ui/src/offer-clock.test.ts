import { afterEach, describe, expect, it, vi } from 'vitest';
import { remainingMs } from './offer-clock';

/** Plan 06 Phase 2 "offer timer tests (refresh, second device, clock skew, never reissued)". */
describe('offer timer on the server clock', () => {
  const server = Date.parse('2026-09-24T12:00:00Z');
  const expiresAt = new Date(server + 15 * 60_000).toISOString();
  const serverNow = new Date(server).toISOString();
  afterEach(() => vi.useRealTimers());

  it('shows the same time left whether the device clock is right, 10 minutes fast or 10 minutes slow', () => {
    for (const skew of [0, 10 * 60_000, -10 * 60_000]) {
      vi.useFakeTimers({ now: server + skew });
      expect(remainingMs(expiresAt, serverNow)).toBe(15 * 60_000);
      // Five minutes later: five minutes less, whatever the device's wall clock says.
      expect(remainingMs(expiresAt, serverNow, 5 * 60_000)).toBe(10 * 60_000);
    }
  });

  it('a refresh or a second device reads the same deadline from the server; it never resets or grows', () => {
    const later = new Date(server + 12 * 60_000).toISOString(); // the server's now on a refresh 12 minutes in
    expect(remainingMs(expiresAt, later)).toBe(3 * 60_000);
    expect(remainingMs(expiresAt, later, 4 * 60_000)).toBeLessThan(0); // ended
    expect(remainingMs(expiresAt, serverNow, -60_000)).toBe(15 * 60_000); // a clock can't run backwards into more time
  });
});
