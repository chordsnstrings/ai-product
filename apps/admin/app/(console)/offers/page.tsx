import Link from 'next/link';
import { withAdmin } from '@arkiv/db';
import { auditView, offerExperimentResults, type OfferExperiment, type OfferVariantResult } from '@arkiv/core';
import { ActButton, ActForm } from '@/components/act';
import { d, dt, money, Mono, Page, pct, Section, Table } from '@/components/ui';
import { requireStaff } from '@/lib/staff';

export const metadata = { title: 'Offers' };

type Ended = OfferExperiment & { endedAt: string; endedBy: string; reason: string };

const EXPERIMENT_TEMPLATE = JSON.stringify(
  {
    key: 'taste-price-2026q4',
    variants: [
      { key: 'p19', weight: 1, priceMicros: 19_000_000 },
      { key: 'p24', weight: 1, priceMicros: 24_000_000 },
    ],
    guardrails: { maxRefundRate: 0.08, maxDisputeRate: 0.01, maxSupportRate: 0.1, minSample: 30 },
  },
  null,
  2,
);

function Results({ rows }: { rows: OfferVariantResult[] }) {
  return (
    <Table head={['Variant', 'Issued', 'Redeemed', 'Conversion', 'Expired', 'Paid', 'Refund rate', 'Dispute rate', 'Support tickets']} rows={rows.map((r) => [
      r.variant, r.issued, r.redeemed, pct(r.conversion ?? NaN), r.expired, r.paid, pct(r.refundRate ?? NaN), pct(r.disputeRate ?? NaN), `${r.support} (${pct(r.supportRate ?? NaN)})`,
    ])} empty="No offers issued under this experiment yet." />
  );
}

/** Offer Engine (plan 05 §6): deterministic, versioned, honest anchors only; experiments with guardrails. */
export default async function Offers() {
  const s = await requireStaff('offers.manage');
  const d0 = await withAdmin(async (tx) => {
    await auditView(tx, s, 'offers');
    const defs = await tx`select * from offer_definitions order by type, code`;
    const results = new Map<string, OfferVariantResult[]>();
    for (const o of defs) {
      const keys = [(o.experiment as OfferExperiment | null)?.key, ...((o.experiment_history as Ended[]) ?? []).map((h) => h.key)].filter(Boolean) as string[];
      for (const k of keys) results.set(`${o.code}:${k}`, await offerExperimentResults(tx, o.code as string, k));
    }
    return {
      defs,
      results,
      issued: await tx`select o.type, o.status, count(*)::int as n from offers o join workspaces w on w.id = o.workspace_id where not w.is_test and o.created_at > now() - interval '30 days' group by 1, 2`,
      recent: await tx`select o.*, w.name from offers o join workspaces w on w.id = o.workspace_id order by o.created_at desc limit 50`,
      testimonials: await tx`select * from testimonials order by created_at desc`,
      alerts: await tx`select id, message, created_at from platform_alerts where subject_type in ('offer', 'offer_experiment', 'stripe_price') and resolved_at is null order by created_at desc`,
    };
  });
  const taste = (st: string) => Number(d0.issued.find((i) => i.type === 'TASTE' && i.status === st)?.n ?? 0);
  const tasteTotal = ['active', 'expired', 'redeemed', 'superseded'].reduce((a, st) => a + taste(st), 0);
  // The engine resolves the latest active version per type whose eligibility matches (first match wins).
  const latest = new Map<string, string>();
  for (const o of [...d0.defs].filter((x) => x.active).sort((a, b) => Number(b.version) - Number(a.version))) if (!latest.has(o.type as string)) latest.set(o.type as string, o.code as string);
  const tasteDefs = d0.defs.filter((o) => o.type === 'TASTE');
  return (
    <Page title="Offers & pricing" sub="Prices on live offers can’t be edited — create a new code (a new version). A reference (strike-through) price must be the price we currently charge for its type. An offer whose Stripe Price is archived pauses itself.">
      {d0.alerts.length ? (
        <Section title="Alerts">
          <Table head={['When', 'What', '']} rows={d0.alerts.map((a) => [dt(a.created_at), a.message as string, <ActButton key="r" small action="alert.resolve" payload={{ id: a.id }} reason="What did you do about it?">Resolve</ActButton>])} />
        </Section>
      ) : null}
      <Table head={['Code', 'Type', 'Version', 'Price', 'Reference', 'Window', 'Eligibility', 'Next offer', 'Stripe Price', 'Bonus', 'Experiment', 'Status', '']} rows={d0.defs.map((o) => {
        const exp = o.experiment as OfferExperiment | null;
        return [
          <Mono key="c">{o.code as string}</Mono>, o.type as string, `v${o.version}${latest.get(o.type as string) === o.code ? ' · latest' : ''}`, `${money(o.price_micros)} ${o.currency as string}`, (o.reference_code as string) ?? '—', o.window_minutes ? `${o.window_minutes} min` : '—',
          <Mono key="e">{JSON.stringify(o.eligibility)}</Mono>, (o.next_offer_policy as { next?: string } | null)?.next ?? '—',
          <span key="s"><Mono>{(o.stripe_price_id as string) ?? '—'}</Mono>{o.stripe_price_archived_at ? <span className="ak-chip ak-chip--risk" style={{ marginLeft: 6 }}>archived in Stripe</span> : null}</span>,
          <Mono key="b">{JSON.stringify(o.bonus)}</Mono>,
          exp ? `${exp.key} (${exp.variants.map((v) => v.key).join(' / ')})` : '—',
          o.active ? 'active' : `paused${o.paused_reason ? ` — ${o.paused_reason as string}` : ''}`,
          <ActButton key="a" small action="offer.active" payload={{ code: o.code, active: !o.active }}>{o.active ? 'Pause' : 'Activate'}</ActButton>,
        ];
      })} />
      <p className="ak-small" style={{ marginTop: 12 }}>Taste offers (30d): issued {tasteTotal} · redeemed {taste('redeemed')} ({pct(tasteTotal ? taste('redeemed') / tasteTotal : NaN)}) · expired {taste('expired')}</p>

      <Section title="Experiments (Taste offer)">
        <p className="ak-small ak-muted">Variants set price and/or timer; workspaces are assigned by weight when the offer is issued and keep their offer. Guardrails are checked every 15 minutes once a variant has the minimum sample; a breach stops the experiment and raises an alert.</p>
        {tasteDefs.map((o) => {
          const exp = o.experiment as OfferExperiment | null;
          const history = ((o.experiment_history as Ended[]) ?? []).slice().reverse();
          return (
            <div key={o.code as string} className="ak-panel" style={{ marginTop: 12 }}>
              <p className="ak-label"><Mono>{o.code as string}</Mono> · base {money(o.price_micros)}{o.window_minutes ? ` · ${o.window_minutes} min` : ''}{o.active ? '' : ' · paused'}</p>
              {exp ? (
                <>
                  <p className="ak-small">Running <strong>{exp.key}</strong> since {dt(exp.startedAt)}: {exp.variants.map((v) => `${v.key} (weight ${v.weight}${v.priceMicros ? `, ${money(v.priceMicros)}` : ''}${v.windowMinutes ? `, ${v.windowMinutes} min` : ''})`).join(' · ')}. Guardrails: {[exp.guardrails.maxRefundRate !== undefined ? `refunds ≤ ${pct(exp.guardrails.maxRefundRate)}` : null, exp.guardrails.maxDisputeRate !== undefined ? `disputes ≤ ${pct(exp.guardrails.maxDisputeRate)}` : null, exp.guardrails.maxSupportRate !== undefined ? `support ≤ ${pct(exp.guardrails.maxSupportRate)}` : null].filter(Boolean).join(', ')} (n ≥ {exp.guardrails.minSample ?? 30}).</p>
                  <Results rows={d0.results.get(`${o.code}:${exp.key}`) ?? []} />
                  <ActButton action="offer.experiment" payload={{ code: o.code, experiment: null }} reason="Why stop it?" confirm="Stop the experiment? New offers go back to the base price and window.">Stop experiment</ActButton>
                </>
              ) : (
                <div style={{ maxWidth: 560 }}>
                  <ActForm action="offer.experiment" extra={{ code: o.code }} submit="Start experiment" fields={[
                    { name: 'experiment', label: 'Experiment (variants: key, weight, priceMicros, windowMinutes 30–1440; guardrails: maxRefundRate, maxDisputeRate, maxSupportRate, minSample)', type: 'json', defaultValue: EXPERIMENT_TEMPLATE },
                    { name: 'reason', label: 'Hypothesis / reason', required: true },
                  ]} />
                </div>
              )}
              {history.length ? (
                <details style={{ marginTop: 8 }}>
                  <summary className="ak-small">Past experiments ({history.length})</summary>
                  {history.map((h) => (
                    <div key={h.key} style={{ marginTop: 8 }}>
                      <p className="ak-small"><strong>{h.key}</strong> · {dt(h.startedAt)} → {dt(h.endedAt)} · ended by {h.endedBy}: {h.reason}</p>
                      <Results rows={d0.results.get(`${o.code}:${h.key}`) ?? []} />
                    </div>
                  ))}
                </details>
              ) : null}
            </div>
          );
        })}
      </Section>

      <div className="ak-grid-2" style={{ alignItems: 'start' }}>
        <Section title="New offer version">
          <div className="ak-panel">
            <ActForm action="offer.create" submit="Create" fields={[
              { name: 'code', label: 'Code', required: true, placeholder: 'TASTE_24_V2' },
              { name: 'type', label: 'Type', type: 'select', options: ['TASTE', 'STANDALONE', 'PLAN_UPGRADE', 'WIN_BACK'] },
              { name: 'price', label: 'Price $ (USD)', type: 'number', required: true },
              { name: 'stripePriceId', label: 'Stripe Price ID (optional)', placeholder: 'price_…' },
              { name: 'referenceCode', label: 'Reference price code (optional)', placeholder: 'STANDALONE_29' },
              { name: 'windowMinutes', label: 'Window (minutes)', type: 'number' },
              { name: 'bonus', label: 'Bonus (JSON)', type: 'json', defaultValue: '{}' },
              { name: 'eligibility', label: 'Eligibility (JSON logic over never_purchased, new_workspace, workspace_age_days, state, plan, source_page)', type: 'json', defaultValue: '{"and": [{"var": "never_purchased"}, {"var": "new_workspace"}]}' },
              { name: 'nextOfferPolicy', label: 'Next-eligible offer once this one ends (JSON)', type: 'json', defaultValue: '{"next": "STANDALONE_29"}' },
            ]} />
          </div>
        </Section>
        <Section title="Recent assignments (per workspace: tenant → Billing)">
          <Table head={['Issued', 'Workspace', 'Offer', 'Variant', 'Price', 'Expires', 'Status']} rows={d0.recent.map((o) => [dt(o.created_at), <Link key="w" href={`/tenants/${o.workspace_id}?tab=billing`}>{o.name as string}</Link>, <Mono key="c">{o.definition_code as string}</Mono>, (o.variant as string) ?? '—', money(o.price_micros), dt(o.expires_at), o.status as string])} />
        </Section>
      </div>
      <Section title="Testimonials (need a stored consent record — FTC)">
        <Table head={['Quote', 'Person', 'Consent', 'Given', 'Status', '']} rows={d0.testimonials.map((t) => [t.quote as string, `${t.person_name}${t.brand_name ? `, ${t.brand_name}` : ''}`, t.consent_document as string, d(t.consent_given_at), t.revoked_at ? 'revoked' : 'live', !t.revoked_at ? <ActButton key="r" small action="testimonial.revoke" payload={{ id: t.id }}>Revoke</ActButton> : null])} empty="No testimonials. Pages show none until real ones with consent exist." />
        <div className="ak-panel" style={{ maxWidth: 560, marginTop: 12 }}>
          <ActForm action="testimonial.create" submit="Add testimonial" fields={[
            { name: 'quote', label: 'Exact quote', type: 'textarea', required: true },
            { name: 'personName', label: 'Name', required: true },
            { name: 'brandName', label: 'Brand' },
            { name: 'consentDocument', label: 'Consent record (signed doc reference)', required: true },
            { name: 'consentGivenAt', label: 'Consent date', type: 'date', required: true },
          ]} />
        </div>
      </Section>
    </Page>
  );
}
