import type { Metadata } from 'next';
import Link from 'next/link';
import { PLANS, PRICES, formatUsd } from '@arkiv/shared';
import { MarketingShell } from '@/components/marketing';
import { currentUser } from '@/lib/session';

export const metadata: Metadata = { title: 'Pricing' };

/** P11 plans (plan 04 L9/L16): Growth recommended in the centre, per-test value anchored to the real $29. */
export default async function Pricing() {
  const user = await currentUser();
  const order = ['LAUNCH', 'GROWTH', 'SCALE'] as const;
  return (
    <div className="ak-marketing">
      <MarketingShell loggedIn={!!user}>
        <section className="ak-wrap ak-stack" style={{ ['--stack' as string]: '24px', paddingTop: 24, paddingBottom: 48 }}>
          <p className="ak-label">Pricing</p>
          <h1 className="ak-display-xl">Continuous testing for your hero products.</h1>
          <p className="ak-body-l ak-muted" style={{ maxWidth: 620 }}>
            Every plan includes Creative Tests: one hypothesis, a finished master ad, up to two extra hooks, TikTok/Reels/Feed exports, and product + claims checks. Cancel online anytime in two clicks.
          </p>
          <div className="ak-grid-3" style={{ alignItems: 'stretch' }}>
            {order.map((code) => {
              const p = PLANS[code];
              const per = p.priceMicros / p.creativeTestsPerMonth;
              const pick = code === 'GROWTH';
              return (
                <div key={code} className={`ak-card${pick ? ' ak-card--pick' : ''}`} style={pick ? { order: -1 } : undefined}>
                  <div className="ak-between">
                    <span className="ak-label">{p.name}</span>
                    {pick && <span className="ak-chip ak-chip--dec">Recommended</span>}
                  </div>
                  <p style={{ margin: 0 }}>
                    <span className="ak-price">{formatUsd(p.priceMicros, 0)}</span>
                    <span className="ak-muted"> / month</span>
                  </p>
                  <table className="ak-meta">
                    <tbody>
                      <tr><th>Creative Tests</th><td>{p.creativeTestsPerMonth} per month</td></tr>
                      <tr><th>Per test</th><td>≈ {formatUsd(per, 0)} <span className="ak-small ak-muted">vs {formatUsd(PRICES.STANDALONE, 0)} standalone</span></td></tr>
                      <tr><th>Brands</th><td>{p.brands}</td></tr>
                      <tr><th>Team</th><td>{p.members} people</td></tr>
                    </tbody>
                  </table>
                  <Link className={`ak-btn${pick ? ' ak-btn--accent' : ' ak-btn--secondary'} ak-btn--block`} href={user ? `/app/plan?plan=${code}` : `/login?next=${encodeURIComponent(`/app/plan?plan=${code}`)}`}>
                    Choose {p.name}
                  </Link>
                </div>
              );
            })}
          </div>
          <style>{`@media (min-width:900px){.ak-grid-3 .ak-card{order:0 !important}}`}</style>
          <table className="ak-meta" style={{ marginTop: 24 }}>
            <tbody>
              <tr><th>Try one ad first</th><td>{formatUsd(PRICES.STANDALONE, 0)} one-time, no subscription. New brands get an intro price of {formatUsd(PRICES.TASTE, 0)} for 60 minutes after their first storyboard.</td></tr>
              <tr><th>Cancel</th><td>Online in Settings → Billing. Your plan runs to the end of the period; your archive is kept for 90 days.</td></tr>
              <tr><th>Taxes</th><td>Sales tax, where it applies, is shown before you pay.</td></tr>
            </tbody>
          </table>
        </section>
      </MarketingShell>
    </div>
  );
}
