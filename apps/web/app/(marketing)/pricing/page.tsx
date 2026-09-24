import type { Metadata } from 'next';
import Link from 'next/link';
import { globalTx } from '@arkiv/db';
import { publicOneOffPrices } from '@arkiv/core';
import { PLANS, formatUsd, type PlanCode } from '@arkiv/shared';
import { MarketingShell } from '@/components/marketing';
import { currentPlanFor } from '@/lib/pricing';
import { currentUser } from '@/lib/session';
import { userWorkspaces } from '@/lib/tenant';

export const metadata: Metadata = { title: 'Pricing' };

const ORDER = ['LAUNCH', 'GROWTH', 'SCALE'] as const;

/**
 * P11 plans (plan 04 L9/L16): Growth recommended in the centre, per-test value anchored to the standalone price a
 * visitor can actually pay today (the live offer definition, never a constant); then a comparison table and FAQ
 * (plan 03 P11). A signed-in subscriber sees their current plan marked, with upgrade/downgrade in Billing.
 */
export default async function Pricing() {
  const user = await currentUser();
  const oneOff = await globalTx((tx) => publicOneOffPrices(tx));
  const memberships = user
    ? (await userWorkspaces(user.userId)).map((w) => ({ workspace_id: w.workspace_id as string, slug: w.slug as string, plan_code: (w.plan_code as string | null) ?? null, role: w.role as string, state: w.state as string }))
    : [];
  const current = user ? currentPlanFor(memberships, user.lastWorkspaceId ?? null) : null;
  const billing = current ? `/w/${current.slug}/settings/billing` : null;
  const perTest = (code: PlanCode) => PLANS[code].priceMicros / PLANS[code].creativeTestsPerMonth;
  const rank = (code: PlanCode) => ORDER.indexOf(code as (typeof ORDER)[number]);
  return (
    <div className="ak-marketing">
      <MarketingShell loggedIn={!!user}>
        <section className="ak-wrap ak-stack" style={{ ['--stack' as string]: '24px', paddingTop: 24, paddingBottom: 48 }}>
          <p className="ak-label">Pricing</p>
          <h1 className="ak-display-xl">Continuous testing for your hero products.</h1>
          <p className="ak-body-l ak-muted" style={{ maxWidth: 620 }}>
            Every plan includes Creative Tests: one hypothesis, a finished master ad, up to two extra hooks, TikTok/Reels/Feed exports, and product + claims checks. Cancel online anytime in two clicks.
          </p>
          {current ? (
            <p className="ak-panel" role="status" style={{ margin: 0 }}>
              You’re on <strong>{PLANS[current.planCode].name}</strong> ({PLANS[current.planCode].creativeTestsPerMonth} Creative Tests a month).{' '}
              {current.canManage ? <Link href={billing!}>Manage your plan in Billing</Link> : 'Ask an owner or admin of your workspace to change it.'}
            </p>
          ) : null}
          <div className="ak-grid-3" style={{ alignItems: 'stretch' }}>
            {ORDER.map((code) => {
              const p = PLANS[code];
              const pick = code === 'GROWTH';
              const mine = current?.planCode === code;
              const cta = mine
                ? { href: billing!, label: 'Your plan · manage' }
                : current
                  ? { href: billing!, label: `${rank(code) > rank(current.planCode) ? 'Upgrade' : 'Switch'} to ${p.name}` }
                  : { href: user ? `/app/plan?plan=${code}` : `/login?next=${encodeURIComponent(`/app/plan?plan=${code}`)}`, label: `Choose ${p.name}` };
              return (
                <div key={code} className={`ak-card${pick ? ' ak-card--pick' : ''}`} style={pick ? { order: -1 } : undefined} aria-current={mine ? 'true' : undefined}>
                  <div className="ak-between">
                    <span className="ak-label">{p.name}</span>
                    {mine ? <span className="ak-chip ak-chip--ok">Your plan</span> : pick ? <span className="ak-chip ak-chip--dec">Recommended</span> : null}
                  </div>
                  <p style={{ margin: 0 }}>
                    <span className="ak-price">{formatUsd(p.priceMicros, 0)}</span>
                    <span className="ak-muted"> / month</span>
                  </p>
                  <table className="ak-meta">
                    <tbody>
                      <tr><th>Creative Tests</th><td>{p.creativeTestsPerMonth} per month</td></tr>
                      <tr><th>Per test</th><td>≈ {formatUsd(perTest(code), 0)} <span className="ak-small ak-muted">vs {formatUsd(oneOff.standaloneMicros, 0)} standalone</span></td></tr>
                      <tr><th>Brands</th><td>{p.brands}</td></tr>
                      <tr><th>Team</th><td>{p.members} people</td></tr>
                    </tbody>
                  </table>
                  {current && !current.canManage ? (
                    <span className={`ak-btn ak-btn--secondary ak-btn--block`} aria-disabled="true">{mine ? 'Your plan' : p.name}</span>
                  ) : (
                    <Link className={`ak-btn${pick && !current ? ' ak-btn--accent' : ' ak-btn--secondary'} ak-btn--block`} href={cta.href}>
                      {cta.label}
                    </Link>
                  )}
                </div>
              );
            })}
          </div>
          <style>{`@media (min-width:900px){.ak-grid-3 .ak-card{order:0 !important}}`}</style>

          <h2 className="ak-h2" style={{ marginTop: 24 }}>Compare plans</h2>
          <div className="ak-scroll-x">
            <table className="ak-table">
              <caption className="ak-sr">Plan comparison</caption>
              <thead>
                <tr>
                  <th scope="col"><span className="ak-sr">Feature</span></th>
                  {ORDER.map((c) => <th key={c} scope="col">{PLANS[c].name}{current?.planCode === c ? ' (yours)' : ''}</th>)}
                  <th scope="col">One ad</th>
                </tr>
              </thead>
              <tbody>
                <tr><th scope="row">Price</th>{ORDER.map((c) => <td key={c}>{formatUsd(PLANS[c].priceMicros, 0)}/mo</td>)}<td>{formatUsd(oneOff.standaloneMicros, 0)} once</td></tr>
                <tr><th scope="row">Creative Tests a month</th>{ORDER.map((c) => <td key={c}>{PLANS[c].creativeTestsPerMonth}</td>)}<td>1 ad</td></tr>
                <tr><th scope="row">Per test</th>{ORDER.map((c) => <td key={c}>≈ {formatUsd(perTest(c), 0)}</td>)}<td>{formatUsd(oneOff.standaloneMicros, 0)}</td></tr>
                <tr><th scope="row">Hook variants per test</th>{ORDER.map((c) => <td key={c}>Up to 3 opening hooks</td>)}<td>1 hook</td></tr>
                <tr><th scope="row">Exports</th>{ORDER.map((c) => <td key={c}>9:16, 4:5, 1:1</td>)}<td>9:16, 4:5, 1:1</td></tr>
                <tr><th scope="row">Product + claims QA</th>{ORDER.map((c) => <td key={c}>Every ad</td>)}<td>Yes</td></tr>
                <tr><th scope="row">Weekly test recommendations</th>{ORDER.map((c) => <td key={c}>Yes</td>)}<td>—</td></tr>
                <tr><th scope="row">Results from Meta / TikTok / Shopify</th>{ORDER.map((c) => <td key={c}>Yes</td>)}<td>—</td></tr>
                <tr><th scope="row">Brands</th>{ORDER.map((c) => <td key={c}>{PLANS[c].brands}</td>)}<td>1</td></tr>
                <tr><th scope="row">Team members</th>{ORDER.map((c) => <td key={c}>{PLANS[c].members}</td>)}<td>—</td></tr>
              </tbody>
            </table>
          </div>

          <h2 className="ak-h2" style={{ marginTop: 24 }}>Questions</h2>
          <div>
            {[
              { q: 'Can I cancel anytime?', a: 'Yes — cancel anytime online in two clicks, in Settings → Billing. Your plan runs to the end of the period you paid for, and your archive is kept for 90 days.' },
              { q: 'What does a Creative Test include?', a: 'One hypothesis to test, a finished 15-second master ad, up to two extra opening hooks, exports for TikTok, Reels, Feed and Square, and product-accuracy and claims checks before you see it.' },
              { q: 'What happens to Creative Tests I don’t use?', a: 'They’re available until the end of the month they’re for and don’t carry over. If a test fails our checks, it comes back to your balance.' },
              { q: 'Can I try one ad without a plan?', a: `Yes. One ad is ${formatUsd(oneOff.standaloneMicros, 0)}, one-time, with no subscription${oneOff.tasteMicros != null && oneOff.tasteMicros < oneOff.standaloneMicros ? ` — new brands get an intro price of ${formatUsd(oneOff.tasteMicros, 0)} for ${oneOff.tasteWindowMinutes} minutes after their first storyboard` : ''}. On a plan, ads are made with your Creative Tests instead.` },
              { q: 'Can I change plans?', a: 'Yes, in Settings → Billing. An upgrade applies straight away; a downgrade applies from your next billing date.' },
              { q: 'What about taxes?', a: 'Sales tax, where it applies, is shown before you pay.' },
            ].map(({ q, a }) => (
              <details key={q} style={{ borderBottom: '1px solid var(--rule)', padding: '14px 0' }}>
                <summary style={{ cursor: 'pointer', fontWeight: 500 }}>{q}</summary>
                <p className="ak-muted" style={{ margin: '8px 0 0' }}>{a}</p>
              </details>
            ))}
          </div>
        </section>
      </MarketingShell>
    </div>
  );
}
