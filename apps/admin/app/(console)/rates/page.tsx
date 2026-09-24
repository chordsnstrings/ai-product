import { withAdmin } from '@arkiv/db';
import { diffRates, loadRates, planMarginImpact, RATE_PROVIDERS, RATE_TEMPLATES, RATE_UNITS, rateViability, type RateTable } from '@arkiv/core';
import { estimateStandardTest } from '@/lib/estimates';
import { ActButton, ActForm } from '@/components/act';
import { dt, money, Mono, Page, pct, Section, Table } from '@/components/ui';
import { requireStaff } from '@/lib/staff';

export const metadata = { title: 'Rate tables' };

/**
 * Plan 05 §9: FINANCE proposes; publishing always needs a second approver. Publish flow: draft → diff against
 * the version in effect → impact preview (standard test estimate, plans' margins) → approve → effective at a time.
 */
export default async function Rates() {
  await requireStaff('rates.propose');
  const { rows, inEffect, fx } = await withAdmin(async (tx) => ({
    // FX rates for the reporting currency (§47): newest version per currency.
    fx: await tx`select distinct on (currency) currency, usd_per_unit, version, effective_from, source from fx_rates order by currency, version desc`,
    rows: await tx`select r.*, c.name as creator, a.name as approver from provider_rate_tables r left join staff_users c on c.id = r.created_by left join staff_users a on a.id = r.approved_by order by r.provider, r.model, r.version desc`,
    inEffect: await loadRates(tx),
  }));
  const current = await estimateStandardTest('published');
  const currentViability = rateViability(current);
  const now = Date.now();
  const status = (r: Record<string, unknown>) => {
    if (r.status !== 'published') return r.status as string;
    const live = inEffect.get(`${r.provider}/${r.model}`);
    if (live && live.version === Number(r.version)) return 'published · in effect';
    if (new Date(r.effective_from as string).getTime() > now) return `published · scheduled ${dt(r.effective_from)}`;
    return 'published · superseded';
  };
  const drafts = await Promise.all(
    rows.filter((r) => r.status === 'draft').map(async (r) => {
      const after = await estimateStandardTest(r.id as string);
      const live = inEffect.get(`${r.provider}/${r.model}`) as RateTable | undefined;
      const margins = planMarginImpact(current, after);
      return { r, after, live, diff: diffRates(live?.rates, r.rates as Record<string, number>), margins, affected: margins.filter((m) => m.cogsAfterMicros !== m.cogsBeforeMicros).length, viability: rateViability(after) };
    }),
  );
  return (
    <Page title="Provider rate tables" sub={<>Standard 15s Creative Test estimate at the rates in effect: <strong>{money(current)}</strong> (ceiling {money(currentViability.ceilingMicros)}). A promotional package is never the rate: set <Mono>promo_paid_ppm</Mono> (share of list actually paid, per million) and realized cost drops while estimates stay at list; the difference is reported as savings under Ledger → COGS.</>}>
      {currentViability.alert ? <p className="ak-banner ak-banner--risk" role="alert">{currentViability.alert}</p> : null}
      <Table head={['Provider', 'Model', 'Version', 'Unit', 'Rates', 'Status', 'Effective', 'Created by', 'Approved by']} rows={rows.map((r) => [
        r.provider as string, <Mono key="m">{r.model as string}</Mono>, `v${r.version}`, r.unit as string, <Mono key="r">{JSON.stringify(r.rates)}</Mono>, status(r), dt(r.effective_from), (r.creator as string) ?? 'seed', (r.approver as string) ?? '—',
      ])} />
      {drafts.length ? (
        <Section title="Drafts awaiting publish">
          {drafts.map(({ r, after, live, diff, margins, affected, viability }) => (
            <div key={r.id as string} className="ak-panel" style={{ marginBottom: 12 }}>
              <div className="ak-between" style={{ flexWrap: 'wrap', gap: 8 }}>
                <p style={{ margin: 0 }}><strong>{r.provider as string}/{r.model as string} v{r.version as number}</strong> · effective {dt(r.effective_from)} {live ? <>· replaces v{live.version}</> : <>· new model</>}</p>
                {Number.isFinite(after) ? (
                  <ActButton small action="rates.publish" payload={{ rateTableId: r.id }} reason="Why (link to provider notice)">🔐 Publish (four-eyes)</ActButton>
                ) : (
                  <span className="ak-small" style={{ color: 'var(--risk)' }}>Can’t publish: the standard test can’t be priced with this draft</span>
                )}
              </div>
              <Table head={['Rate', 'In effect', 'Draft', 'Change']} rows={diff.map((x) => [<Mono key="k">{x.key}</Mono>, x.before ?? '—', x.after ?? 'removed', x.change === null ? (x.before === null ? 'new' : 'removed') : `${x.change > 0 ? '+' : ''}${pct(x.change)}`])} empty="No rate changes against the version in effect." />
              <p className="ak-small" style={{ marginTop: 8 }}>
                Standard 15s test estimate changes {money(current)} → {money(after)}; {affected} plan{affected === 1 ? '’s' : 's’'} margins affected.
              </p>
              <Table head={['Plan', 'Price', 'Tests', 'COGS if fully used', 'Margin']} rows={margins.map((m) => [m.plan.toLowerCase(), money(m.priceMicros, 0), m.tests, `${money(m.cogsBeforeMicros)} → ${money(m.cogsAfterMicros)}`, <span key="m" style={{ color: m.viable ? undefined : 'var(--risk)' }}>{pct(m.marginBefore)} → {pct(m.marginAfter)}{m.viable ? '' : ' (below cost)'}</span>])} />
              {viability.alert ? <p className="ak-banner ak-banner--risk" style={{ marginTop: 8 }}>{viability.alert}</p> : null}
            </div>
          ))}
        </Section>
      ) : null}
      <Section title="FX rates (reporting currency)">
        <p className="ak-small ak-muted">Ad spend and purchase value are stored in their native currency and converted to each workspace’s reporting currency at ingest with these rates; money is never summed raw across currencies.</p>
        <Table head={['Currency', 'USD per unit', 'Version', 'Effective', 'Source']} rows={fx.map((f) => [<Mono key="c">{f.currency as string}</Mono>, String(Number(f.usd_per_unit)), `v${f.version}`, dt(f.effective_from), f.source as string])} />
        <div className="ak-panel" style={{ maxWidth: 560, marginTop: 12 }}>
          <ActForm action="fx.set" submit="Save new rate" fields={[
            { name: 'currency', label: 'Currency (ISO 4217)', required: true, placeholder: 'EUR' },
            { name: 'usdPerUnit', label: 'USD per 1 unit', required: true, placeholder: '1.08' },
            { name: 'source', label: 'Source', required: true, placeholder: 'ECB reference rate 2026-09-24' },
            { name: 'reason', label: 'Reason', required: true },
          ]} />
        </div>
      </Section>
      <Section title="New version of a model in effect">
        <p className="ak-small ak-muted">Starts from the rates in effect, in micros (1 USD = 1,000,000). The keys are the ones the Cost Governor reads for the unit.</p>
        {[...inEffect.values()].map((t) => (
          <details key={`${t.provider}/${t.model}`} className="ak-panel" style={{ maxWidth: 560, marginBottom: 8 }}>
            <summary><Mono>{t.provider}/{t.model}</Mono> · v{t.version} · {t.unit}</summary>
            <ActForm action="rates.propose" submit="Create draft" extra={{ provider: t.provider, model: t.model, unit: t.unit }} fields={[
              { name: 'rates', label: 'Rates (JSON, micros)', type: 'json', required: true, defaultValue: JSON.stringify(t.rates) },
              { name: 'effectiveFrom', label: 'Effective from (your local time; empty = on approval)', type: 'datetime-local' },
              { name: 'sourceUrl', label: 'Source URL' },
              { name: 'notes', label: 'Notes', type: 'textarea' },
            ]} />
          </details>
        ))}
      </Section>
      <Section title="Propose a new model">
        <p className="ak-small ak-muted">Rate keys per unit: {RATE_UNITS.map((u) => `${u} → ${JSON.stringify(RATE_TEMPLATES[u])}`).join(' · ')}</p>
        <div className="ak-panel" style={{ maxWidth: 560 }}>
          <ActForm action="rates.propose" submit="Create draft" fields={[
            { name: 'provider', label: 'Provider', type: 'select', options: [...RATE_PROVIDERS] },
            { name: 'model', label: 'Model (logical name)', required: true, placeholder: 'dreamina-seedance-2-5' },
            { name: 'unit', label: 'Unit', type: 'select', options: [...RATE_UNITS] },
            { name: 'rates', label: 'Rates (JSON, micros)', type: 'json', required: true, defaultValue: JSON.stringify(RATE_TEMPLATES.per_million_tokens) },
            { name: 'effectiveFrom', label: 'Effective from (your local time; empty = on approval)', type: 'datetime-local' },
            { name: 'sourceUrl', label: 'Source URL' },
            { name: 'notes', label: 'Notes', type: 'textarea' },
          ]} />
        </div>
      </Section>
    </Page>
  );
}
