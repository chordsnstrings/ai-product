import { withAdmin } from '@arkiv/db';
import { canonicalTaxonomy, TAXONOMY_FAMILIES } from '@arkiv/core';
import { ActForm } from '@/components/act';
import { dt, Mono, Page, Section, Table } from '@/components/ui';
import { requireStaff } from '@/lib/staff';

export const metadata = { title: 'Taxonomy' };

/** Where each family's value is stored on experiments' genes and creatives' genomes. */
const KEY = { angle: 'angle', hook: 'hookMechanism', proof: 'proofMechanism', treatment: 'treatment' } as const;

/**
 * Plan 05 §19: the canonical families (versioned), coverage as aggregate counts only (no tenant content), and
 * proposals to add, rename or deprecate a value, reviewed by a second staff member, with their migration plan.
 */
export default async function TaxonomyPage() {
  const s = await requireStaff('taxonomy.manage');
  const d0 = await withAdmin(async (tx) => ({
    tax: await canonicalTaxonomy(tx),
    versions: await tx`select version, created_at, coalesce(spec->>'reason', spec->>'changeReason') as reason, spec->'change' as change, spec->>'by' as by from taxonomy_versions order by version desc limit 30`,
    coverage: await tx`select k, v, count(*)::int as n from (
                         ${tx.unsafe(TAXONOMY_FAMILIES.map((f) => `select '${f}' as k, genes->>'${KEY[f]}' as v from experiments union all select '${f}', genome->>'${KEY[f]}' from creatives where genome is not null`).join(' union all '))}
                       ) x where v is not null group by 1, 2`,
    proposals: await tx`select p.*, a.name as proposer, r.name as reviewer from taxonomy_proposals p left join staff_users a on a.id = p.proposed_by left join staff_users r on r.id = p.reviewed_by
                        order by (p.status = 'proposed') desc, p.created_at desc limit 50`,
  }));
  const count = (k: string, v: string) => Number(d0.coverage.find((c) => c.k === k && c.v === v)?.n ?? 0);
  // Values found on genomes that aren't canonical (legacy or free text): shown, never promoted silently.
  const unknown = d0.coverage.filter((c) => !d0.tax.families[c.k as (typeof TAXONOMY_FAMILIES)[number]].includes(c.v as string));
  const plan = (p: Record<string, unknown>) =>
    p.op === 'add' ? 'new value; no existing genomes change' : p.op === 'rename' ? `genomes with ${p.value as string} → ${p.to_value as string}` : p.to_value ? `deprecated; genomes move to ${p.to_value as string}` : 'deprecated; existing genomes keep the value, new work can’t use it';
  return (
    <Page title="Taxonomy & Creative Genome schema" sub={`Canonical taxonomy v${d0.tax.version}. Free-text tags never become canonical silently: every change is a reviewed proposal with a migration plan.`}>
      <div className="ak-grid-2">
        {TAXONOMY_FAMILIES.map((fam) => (
          <Section key={fam} title={`${fam} (${d0.tax.families[fam].length})`}>
            <Table head={['Value', 'Uses']} rows={[...d0.tax.families[fam].map((v) => [<Mono key="v">{v}</Mono>, count(fam, v)]), ...d0.tax.deprecated[fam].map((v) => [<span key="d" className="ak-muted"><Mono>{v}</Mono> (deprecated)</span>, count(fam, v)])]} />
          </Section>
        ))}
      </div>
      {unknown.length ? (
        <Section title="Non-canonical values found on genomes">
          <Table head={['Family', 'Value', 'Uses']} rows={unknown.map((u) => [u.k as string, <Mono key="v">{u.v as string}</Mono>, u.n as number])} />
        </Section>
      ) : null}
      <Section title="Proposals">
        <Table
          head={['Proposed', 'Change', 'Reason', 'Migration plan', 'By', 'Status', '']}
          rows={d0.proposals.map((p) => [
            dt(p.created_at),
            <span key="c"><Mono>{p.family as string}</Mono> {p.op as string} <Mono>{p.value as string}</Mono>{p.to_value ? <> → <Mono>{p.to_value as string}</Mono></> : null}</span>,
            <span key="r" className="ak-small">{p.reason as string}</span>,
            <span key="m" className="ak-small">{plan(p)}</span>,
            (p.proposer as string) ?? '—',
            p.status === 'approved' ? `v${p.version as number} · remap ${(p.remap_status as string) ?? 'none'}${p.remap_result ? ` ${JSON.stringify(p.remap_result).slice(0, 80)}` : ''}` : p.status === 'rejected' ? `rejected by ${(p.reviewer as string) ?? '—'}: ${(p.review_note as string) ?? ''}` : 'awaiting review',
            p.status === 'proposed' && p.proposed_by !== s.staffId ? (
              <span key="a" className="ak-stack" style={{ ['--stack' as string]: '4px' }}>
                <ActForm inline action="taxonomy.review" extra={{ id: p.id, approve: true }} submit="🔐 Approve" fields={[{ name: 'note', label: 'Review note', required: true }]} />
                <ActForm inline action="taxonomy.review" extra={{ id: p.id, approve: false }} submit="Reject" fields={[{ name: 'note', label: 'Why not', required: true }]} />
              </span>
            ) : p.status === 'proposed' ? <span key="w" className="ak-small ak-muted">needs another reviewer</span> : null,
          ])}
          empty="No proposals."
        />
        <div className="ak-panel" style={{ maxWidth: 640, marginTop: 12 }}>
          <ActForm
            action="taxonomy.propose"
            submit="Propose change"
            fields={[
              { name: 'family', label: 'Family', type: 'select', options: [...TAXONOMY_FAMILIES] },
              { name: 'op', label: 'Change', type: 'select', options: ['add', 'rename', 'deprecate'] },
              { name: 'value', label: 'Value (UPPER_SNAKE_CASE)', required: true },
              { name: 'to', label: 'Rename to / replacement for deprecated genomes (optional for deprecate)' },
              { name: 'reason', label: 'Reason', type: 'textarea', required: true },
            ]}
          />
        </div>
      </Section>
      <Section title="Versions">
        <Table head={['Version', 'When', 'Change', 'Reason']} rows={d0.versions.map((v) => {
          const c = v.change as { family?: string; op?: string; value?: string; to?: string | null } | null;
          return [`v${v.version}`, dt(v.created_at), c ? `${c.family} ${c.op} ${c.value}${c.to ? ` → ${c.to}` : ''}` : ((v.by as string) ? `recorded by ${v.by as string}` : 'Appendix A'), (v.reason as string) ?? '—'];
        })} />
      </Section>
    </Page>
  );
}
