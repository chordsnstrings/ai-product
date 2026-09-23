import { withAdmin } from '@arkiv/db';
import { diffRates, loadRates, planMarginImpact, rateViability, type RateTable } from '@arkiv/core';
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
  const { rows, inEffect } = await withAdmin(async (tx) => ({
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
    <Page title="Provider rate tables" sub={<>Standard 15s Creative Test estimate at the rates in effect: <strong>{money(current)}</strong> (ceiling {money(currentViability.ceilingMicros)}). Discounts are recorded as savings in notes, not as the rate.</>}>
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
                <ActButton small action="rates.publish" payload={{ rateTableId: r.id }} reason="Why (link to provider notice)">🔐 Publish (four-eyes)</ActButton>
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
      <Section title="Propose a new version">
        <div className="ak-panel" style={{ maxWidth: 560 }}>
          <ActForm action="rates.propose" submit="Create draft" fields={[
            { name: 'provider', label: 'Provider', type: 'select', options: ['anthropic', 'byteplus', 'minimax', 'internal'] },
            { name: 'model', label: 'Model (logical name)', required: true, placeholder: 'dreamina-seedance-2-5' },
            { name: 'unit', label: 'Unit', type: 'select', options: ['per_million_tokens', 'per_image', 'per_second', 'per_million_chars', 'per_output'] },
            { name: 'rates', label: 'Rates (JSON, micros)', type: 'json', required: true, defaultValue: '{"input": 0, "output": 0}' },
            { name: 'effectiveFrom', label: 'Effective from (your local time; empty = on approval)', type: 'datetime-local' },
            { name: 'sourceUrl', label: 'Source URL' },
            { name: 'notes', label: 'Notes', type: 'textarea' },
          ]} />
        </div>
      </Section>
    </Page>
  );
}
