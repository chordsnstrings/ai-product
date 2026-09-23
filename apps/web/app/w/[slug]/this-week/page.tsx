import type { Metadata } from 'next';
import Link from 'next/link';
import { withTenant } from '@arkiv/db';
import { balances, weekOf } from '@arkiv/core';
import { Banner, Empty, LinkButton, SignalChip } from '@arkiv/ui';
import { ActionButton, ActionForm, SheetButton } from '@/components/actions';
import { workspacePage } from '@/lib/tenant';

export const metadata: Metadata = { title: 'This Week · Arkiv' };

const SLOT: Record<string, string> = { EXPLOIT: 'Exploit · build on what works', EXPAND: 'Expand · adjacent bet', EXPLORE: 'Explore · new territory' };
const BASIS: Record<string, string> = { performance: 'Based on your results', context_limited: 'Limited performance data', cold_start: 'Based on your product and reviews — not performance yet' };
const SIGNIFICANT = ['CONFIDENCE_CHANGED', 'LEARNING_CREATED', 'LEARNING_WEAKENED', 'LEARNING_INVALIDATED', 'EXPERIMENT_CONFOUNDED', 'INTEGRATION_DEGRADED', 'INTEGRATION_DISCONNECTED', 'COMPOSITION_COMPLETED', 'CLAIM_BLOCKED', 'CLAIM_APPROVED'];
const EVENT_TEXT: Record<string, string> = {
  CONFIDENCE_CHANGED: 'A test’s confidence changed',
  LEARNING_CREATED: 'New learning recorded',
  LEARNING_WEAKENED: 'A learning weakened',
  LEARNING_INVALIDATED: 'A learning no longer holds',
  EXPERIMENT_CONFOUNDED: 'A test was marked confounded',
  INTEGRATION_DEGRADED: 'A connection needs attention',
  INTEGRATION_DISCONNECTED: 'A connection was removed',
  COMPOSITION_COMPLETED: 'An ad finished rendering',
  CLAIM_BLOCKED: 'A claim was blocked',
  CLAIM_APPROVED: 'A claim was approved',
};

function weekLine(d = new Date()) {
  const start = new Date(weekOf(d));
  const end = new Date(start.getTime() + 6 * 86400_000);
  const jan1 = new Date(Date.UTC(start.getUTCFullYear(), 0, 1));
  const wk = Math.ceil(((start.getTime() - jan1.getTime()) / 86400_000 + jan1.getUTCDay() + 1) / 7);
  const f = (x: Date) => x.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return `Week ${wk} · ${f(start)} – ${f(end)}`;
}

export default async function ThisWeek({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ subscribed?: string }> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const w = await workspacePage(slug);
  const data = await withTenant(w.ctx.workspaceId, async (tx) => {
    const skus = await tx`select id, name, catalogue_no, status from skus where status <> 'rejected' order by catalogue_no`;
    const recs = await tx`select r.*, s.name as sku_name, s.catalogue_no from recommendations r join skus s on s.id = r.sku_id
                          where r.status = 'open' and r.week_of >= ${weekOf(new Date(Date.now() - 7 * 86400_000))} order by r.week_of desc, r.score desc limit 9`;
    const jobs = await tx`select p.id, p.state, p.kind, s.name, e.id as experiment_id from projects p join skus s on s.id = p.sku_id left join experiments e on e.id = p.experiment_id
                          where p.state in ('STORYBOARD_APPROVED','RENDER_RESERVED','RENDERING','QA_RUNNING','COMPOSING','PLATFORM_VARIANTS','FINAL_QA','CONCEPT_SELECTED','STORYBOARD_READY')
                          order by p.updated_at desc limit 8`;
    const changes = await tx`select type, subject_type, subject_id, payload, at from events where type in ${tx(SIGNIFICANT)} and at > now() - interval '14 days' order by at desc limit 10`;
    const dismissedStreak = await tx`select count(*)::int as n from recommendations where status = 'dismissed' and created_at > now() - interval '21 days'`;
    const acceptedRecent = await tx`select count(*)::int as n from recommendations where status = 'accepted' and created_at > now() - interval '21 days'`;
    const [sub] = await tx`select plan_code from subscriptions where status in ('active','trialing','past_due') limit 1`;
    return { skus, recs, jobs, changes, bal: await balances(tx), ignored: dismissedStreak[0]!.n >= 6 && acceptedRecent[0]!.n === 0, sub };
  });
  const canCreate = ['OWNER', 'ADMIN', 'MEMBER'].includes(w.ctx.role);

  if (!data.skus.length) {
    return (
      <>
        <p className="ak-index">{weekLine()}</p>
        <h1 className="ak-h1">Welcome to your archive</h1>
        <Empty title="Add your first product" body="Paste a product link or add a photo. We’ll catalogue it and draft three test ideas in about a minute." action={<LinkButton href="/start">Add a product</LinkButton>} />
      </>
    );
  }
  const outOfTests = data.sub && data.bal.creativeTests <= 0;
  return (
    <>
      {sp.subscribed ? <Banner>Your plan is active. Creative Tests are ready to use.</Banner> : null}
      <p className="ak-index">{weekLine()}</p>
      <div className="ak-between" style={{ flexWrap: 'wrap', gap: 12 }}>
        <h1 className="ak-h1" style={{ margin: 0 }}>What to test this week</h1>
        {canCreate ? <ActionButton slug={slug} action="rec-refresh" variant="text">Refresh recommendations</ActionButton> : null}
      </div>
      {outOfTests ? (
        <Banner tone="warn">You’ve used this month’s Creative Tests. <Link href={`/w/${slug}/settings/billing`}>Upgrade your plan</Link> or wait for the renewal.</Banner>
      ) : null}
      {!data.sub ? <Banner>Recommendations are free to read. <Link href="/app/plan">Choose a plan</Link> to produce them as Creative Tests.</Banner> : null}
      {data.ignored ? <Banner>We noticed you’ve passed on recent suggestions. Are these the wrong kind of tests? <a href="mailto:support@arkiv.app?subject=Recommendations">Tell us in one line</a>.</Banner> : null}

      {data.recs.length === 0 ? (
        <Empty title="Recommendations are on their way" body="We plan tests every Monday from your product facts, reviews and results. Refresh to plan this week now." />
      ) : (
        <div className="ak-grid-3" style={{ marginTop: 24 }}>
          {data.recs.map((r) => {
            const p = r.proposal as { hypothesis: string; whyNow: string; hookOptions: string[]; primaryVariable: string; expectedLearning: string };
            return (
              <article key={r.id as string} className="ak-card">
                <div className="ak-between"><span className="ak-index">No. {String(r.catalogue_no).padStart(3, '0')} · {r.sku_name as string}</span></div>
                <p className="ak-label" style={{ marginTop: 12 }}>{SLOT[r.slot as string]}</p>
                <h2 className="ak-h2 ak-serif">“{p.hookOptions[0]}”</h2>
                <p className="ak-small">{p.hypothesis}</p>
                <dl className="ak-meta ak-small">
                  <dt>Why now</dt><dd>{p.whyNow}</dd>
                  <dt>Tests</dt><dd>{p.primaryVariable}</dd>
                  <dt>Cost</dt><dd>1 Creative Test</dd>
                </dl>
                <p className="ak-small ak-muted">{BASIS[r.basis as string]}</p>
                {canCreate ? (
                  <div className="ak-row">
                    <ActionButton slug={slug} action="rec-accept" body={{ id: r.id }} variant="primary">Approve</ActionButton>
                    <SheetButton variant="text" label="Not now" title="Not now" description="One line helps us plan better tests next week.">
                      <ActionForm slug={slug} action="rec-dismiss" extra={{ id: r.id }} submit="Dismiss" fields={[{ name: 'reason', label: 'Reason', type: 'select', options: [{ value: 'not_relevant', label: 'Not relevant to this product' }, { value: 'tried_before', label: 'We’ve tried this before' }, { value: 'off_brand', label: 'Off-brand' }, { value: 'timing', label: 'Wrong timing' }, { value: 'other', label: 'Other' }] }]} />
                    </SheetButton>
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      )}

      {data.jobs.length ? (
        <section className="ak-section">
          <p className="ak-label">In progress</p>
          {data.jobs.map((j) => (
            <Link key={j.id as string} className="ak-index-row" href={j.experiment_id ? `/w/${slug}/studio/${j.experiment_id}` : j.state === 'STORYBOARD_READY' ? `/storyboard/${j.id}` : `/produce/${j.id}`}>
              <span>{j.name as string}</span>
              <span className="ak-index">{String(j.state).replace(/_/g, ' ').toLowerCase()}</span>
            </Link>
          ))}
        </section>
      ) : null}

      <section className="ak-section">
        <p className="ak-label">What changed</p>
        {data.changes.length === 0 ? (
          <p className="ak-muted ak-small">Nothing significant in the last two weeks. We only list changes that should affect what you test.</p>
        ) : (
          data.changes.map((c, i) => (
            <div key={i} className="ak-index-row">
              <span>{EVENT_TEXT[c.type as string] ?? c.type}{(c.payload as { to?: string }).to ? <> · <SignalChip state={String((c.payload as { to: string }).to)} /></> : null}</span>
              <span className="ak-index">{new Date(c.at as string).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
            </div>
          ))
        )}
      </section>
    </>
  );
}
