import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, globalTx, ownerPool, withAdmin } from '@arkiv/db';
import { truncateAll } from '@arkiv/db/testing';
import { addToWaitlist, waitlistCategory } from './waitlist';

beforeEach(truncateAll);
afterAll(closeAll);

describe('out-of-scope waitlist (plan 03 P2)', () => {
  it('adds a consenting address once per category, records the funnel stage, and the app role cannot read it back', async () => {
    const base = { email: 'Maker@Candles.com', consent: true, category: waitlistCategory('We’re built for skincare. This looks like candles.'), reason: 'We’re built for skincare. This looks like candles.', visitorId: 'v-1', ip: '5.6.7.8' };
    expect(base.category).toBe('non_skincare');
    expect(waitlistCategory('Sunscreen, SPF and OTC drug products (like acne treatments) are outside what we make ads for.')).toBe('excluded_category');
    expect(await globalTx((tx) => addToWaitlist(tx, base))).toEqual({ joined: true });
    expect(await globalTx((tx) => addToWaitlist(tx, { ...base, email: 'maker@candles.com' }))).toEqual({ joined: false });
    await expect(globalTx((tx) => addToWaitlist(tx, { ...base, consent: false }))).rejects.toMatchObject({ code: 'INVALID' });
    await expect(globalTx((tx) => addToWaitlist(tx, { ...base, email: 'nope' }))).rejects.toMatchObject({ code: 'INVALID' });

    const rows = await withAdmin((tx) => tx`select email, category, reason, visitor_id, consent_at from waitlist`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ email: 'maker@candles.com', category: 'non_skincare', visitor_id: 'v-1' });
    await expect(globalTx((tx) => tx`select * from waitlist`)).rejects.toThrow(/permission denied/);
    const [f] = await ownerPool()`select count(*)::int as n from funnel_events where type = 'WAITLIST_JOINED' and visitor_id = 'v-1'`;
    expect(f!.n).toBe(1);
  });

  it('rate-limits one visitor', async () => {
    for (let i = 0; i < 5; i++) await globalTx((tx) => addToWaitlist(tx, { email: `a${i}@x.com`, consent: true, category: 'non_skincare', visitorId: 'v-spam' }));
    await expect(globalTx((tx) => addToWaitlist(tx, { email: 'a9@x.com', consent: true, category: 'non_skincare', visitorId: 'v-spam' }))).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });
});
