/**
 * Time left on a server-issued expiry, on the server's clock (plan 03 P7 edge case: a device whose clock is off
 * shows the same deadline as everyone else). The page renders with the server's `now`; after that only the time
 * elapsed since render counts — measured on a monotonic clock — so a device clock that is wrong, or is changed
 * while the page is open, can't move the deadline.
 */
export function remainingMs(expiresAt: string, serverNow: string, elapsedSinceRenderMs = 0): number {
  return new Date(expiresAt).getTime() - new Date(serverNow).getTime() - Math.max(0, elapsedSinceRenderMs);
}

/** Milliseconds on a clock that never jumps (performance.now), falling back to Date.now where unavailable. */
export const monotonicNow = (): number => (typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now());
