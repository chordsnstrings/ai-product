import type { Metadata } from 'next';
import Link from 'next/link';
import { withTenant } from '@arkiv/db';
import { periodUsage, setting } from '@arkiv/core';
import { formatUsd, PLANS, PRICES, type PlanCode } from '@arkiv/shared';
import { Banner, LinkButton } from '@arkiv/ui';
import { ActionButton } from '@/components/actions';
import { CancelFlow } from '@/components/cancel-flow';
import { workspacePage } from '@/lib/tenant';

export const metadata: Metadata = { title: 'Billing · Arkiv' };

const fmt = (d: string) => new Date(d).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

export default async function Billing({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const w = await workspacePage(slug);
  const d = await withTenant(w.ctx.workspaceId, async (tx) => {
    const [sub] = await tx`select * from subscriptions where status in ('active','trialing','past_due') order by created_at desc limit 1`;
    const usage = sub ? await periodUsage(tx, new Date(sub.current_period_start as string).toISOString().slice(0, 10)) : null;
    const purchases = await tx`select p.kind, p.amount_micros, p.status, p.paid_at, p.created_at, s.name from purchases p left join projects pr on pr.id = p.project_id left join skus s on s.id = pr.sku_id where p.status in ('paid','refunded') order by p.created_at desc limit 20`;
    const [cust] = await tx`select customer_id from stripe_customers where workspace_id = ${w.ctx.workspaceId}`;
    return { sub, usage, purchases, hasCustomer: !!cust, archiveDays: await setting(tx, 'retention.cancelled_archive_days'), support: await setting(tx, 'support.email') };
  });
  const canManage = ['OWNER', 'ADMIN'].includes(w.ctx.role);
  const plan = d.sub ? PLANS[d.sub.plan_code as PlanCode] : null;
  return (
    <div className="ak-stack" style={{ ['--stack' as string]: '32px' }}>
      {!d.sub ? (
        <div className="ak-panel">
          <h2 className="ak-label">No plan</h2>
          <p>You’re paying per ad ({formatUsd(PRICES.STANDALONE, 0)} each). Choose a plan to test continuously.</p>
          {canManage ? <LinkButton href="/app/plan">See plans</LinkButton> : null}
        </div>
      ) : (
        <div className="ak-panel">
          <div className="ak-between" style={{ flexWrap: 'wrap', gap: 12 }}>
            <div>
              <h2 className="ak-label">Current plan</h2>
              <p className="ak-h2" style={{ margin: 0 }}>{plan!.name} · {formatUsd(plan!.priceMicros, 0)}/month</p>
              <p className="ak-small ak-muted">
                {d.usage ? `${d.usage.remaining} of ${d.usage.granted} Creative Tests left this period` : null}
                {d.sub.current_period_end ? ` · ${d.sub.cancel_at_period_end ? 'ends' : 'renews'} ${fmt(d.sub.current_period_end as string)}` : null}
              </p>
            </div>
            {canManage && d.hasCustomer ? <ActionButton slug={slug} action="portal">Payment method & invoices</ActionButton> : null}
          </div>
          {d.sub.status === 'past_due' ? <Banner tone="risk">Your last payment failed. Update your card to keep producing tests.</Banner> : null}
          {d.sub.pending_plan_code ? <Banner>Switching to {PLANS[d.sub.pending_plan_code as PlanCode].name} on {fmt(d.sub.current_period_end as string)}.</Banner> : null}
          {d.sub.cancel_at_period_end ? (
            <Banner>
              Your plan is cancelled and ends {fmt(d.sub.current_period_end as string)}. You keep access until then.{' '}
              {canManage ? <ActionButton slug={slug} action="uncancel" variant="text">Keep my plan</ActionButton> : null}
            </Banner>
          ) : null}
        </div>
      )}

      {d.sub && canManage && !d.sub.cancel_at_period_end ? (
        <section>
          <h2 className="ak-label">Change plan</h2>
          <div className="ak-grid-3">
            {(['LAUNCH', 'GROWTH', 'SCALE'] as const).map((c) => {
              const p = PLANS[c];
              const current = c === d.sub!.plan_code;
              const up = p.priceMicros > plan!.priceMicros;
              return (
                <div key={c} className={`ak-card${current ? ' ak-card--pick' : ''}`}>
                  <h3 className="ak-label">{p.name}</h3>
                  <p style={{ margin: 0 }}>{formatUsd(p.priceMicros, 0)}/mo · {p.creativeTestsPerMonth} tests</p>
                  {current ? <span className="ak-small ak-muted">Current plan</span> : (
                    <ActionButton slug={slug} action="change-plan" body={{ plan: c }} confirm={up ? `Upgrade to ${p.name} now? You'll be charged the prorated difference today and get extra tests for this period.` : `Downgrade to ${p.name} at the end of this period? Nothing changes until then.`}>
                      {up ? 'Upgrade now' : 'Downgrade at renewal'}
                    </ActionButton>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      ) : null}

      <section>
        <h2 className="ak-label">One-time purchases</h2>
        {d.purchases.length === 0 ? <p className="ak-small ak-muted">None yet.</p> : d.purchases.map((p, i) => (
          <div key={i} className="ak-index-row">
            <span>{p.kind === 'taste' ? 'Intro ad' : 'Standalone ad'}{p.name ? ` · ${p.name}` : ''}</span>
            <span className="ak-index">{formatUsd(Number(p.amount_micros), 0)} · {p.status as string} · {new Date((p.paid_at ?? p.created_at) as string).toLocaleDateString()}</span>
          </div>
        ))}
      </section>

      {d.sub && canManage && !d.sub.cancel_at_period_end ? (
        <section>
          <h2 className="ak-label">Cancel</h2>
          <CancelFlow slug={slug} endsOn={d.sub.current_period_end ? fmt(d.sub.current_period_end as string) : 'the end of this period'} planCode={d.sub.plan_code as string} archiveDays={d.archiveDays} />
        </section>
      ) : null}
      <p className="ak-small ak-muted">Questions about a charge? <Link href={`mailto:${d.support}`}>{d.support}</Link></p>
    </div>
  );
}
