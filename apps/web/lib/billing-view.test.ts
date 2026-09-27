import { describe, expect, it } from 'vitest';
import { noPlanPanel } from './billing-view';

const standalone = { kind: 'standalone' as const, priceMicros: 29_000_000, status: 'none', expiresAt: null };

describe('billing page without a plan (plan 02 §2, standard §5)', () => {
  it('a cancelled workspace sees when its plan ended, how long the archive is kept, and Reactivate — no per-ad price', () => {
    const p = noPlanPanel({ state: 'CANCELLED', cancelledAt: '2026-09-01T12:00:00Z', archiveDays: 90, quote: standalone, afterMicros: 29_000_000 });
    expect(p.kind).toBe('cancelled');
    expect(p.body).toMatch(/ended on 1 Sep/);
    expect(p.body).toMatch(/kept until 30 Nov/);
    expect(p.body).not.toMatch(/\$29/);
    expect(p.cta).toEqual({ href: '/app/plan', label: 'Reactivate' });
  });

  it('a live intro offer is quoted at its real price with its end, then the regular price', () => {
    const p = noPlanPanel({ state: 'ACTIVE_FREE', cancelledAt: null, archiveDays: 90, quote: { kind: 'taste', priceMicros: 19_000_000, status: 'active', expiresAt: '2026-09-27T10:00:00Z' }, afterMicros: 29_000_000 });
    expect(p.body).toMatch(/^Your first ad is \$19 \(intro price until .+\), then \$29 per ad/);
  });

  it('without an intro offer, the live standalone price', () => {
    expect(noPlanPanel({ state: 'ACTIVE_PAID', cancelledAt: null, archiveDays: 90, quote: { ...standalone, priceMicros: 24_000_000 }, afterMicros: 24_000_000 }).body).toMatch(/\(\$24 each\)/);
    // An intro quote that is no longer active is not presented as an intro price.
    expect(noPlanPanel({ state: 'ACTIVE_FREE', cancelledAt: null, archiveDays: 90, quote: { kind: 'taste', priceMicros: 19_000_000, status: 'expired', expiresAt: null }, afterMicros: 29_000_000 }).body).not.toMatch(/intro/);
  });

  it('a held workspace is offered nothing to buy', () => {
    expect(noPlanPanel({ state: 'SUSPENDED', cancelledAt: null, archiveDays: 90, quote: standalone, afterMicros: 29_000_000 })).toMatchObject({ kind: 'held', cta: null });
  });
});
