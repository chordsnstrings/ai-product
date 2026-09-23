import { withAdmin } from '@arkiv/db';
import { Taxonomy } from '@arkiv/shared';
import { ActForm } from '@/components/act';
import { dt, Mono, Page, Section, Table } from '@/components/ui';
import { requireStaff } from '@/lib/staff';

export const metadata = { title: 'Taxonomy' };

/** Plan 05 §19: versioned families; coverage is aggregate counts only (no tenant content). */
export default async function TaxonomyPage() {
  await requireStaff('taxonomy.manage');
  const d0 = await withAdmin(async (tx) => ({
    versions: await tx`select version, created_at, spec->>'changeReason' as reason, spec->>'by' as by from taxonomy_versions order by version desc`,
    coverage: await tx`select k, v, count(*)::int as n from (
                         select 'angle' as k, genes->>'angle' as v from experiments union all select 'hook', genes->>'hookMechanism' from experiments
                         union all select 'treatment', genes->>'treatment' from experiments union all select 'angle', genome->>'angle' from creatives where genome is not null) x
                       where v is not null group by 1, 2`,
  }));
  const count = (k: string, v: string) => Number(d0.coverage.find((c) => c.k === k && c.v === v)?.n ?? 0);
  return (
    <Page title="Taxonomy & Creative Genome schema" sub="Free-text tags never become canonical silently: changes are new versions with a remapping plan.">
      <div className="ak-grid-3">
        {(['angle', 'hook', 'treatment'] as const).map((fam) => (
          <Section key={fam} title={fam}>
            <Table head={['Value', 'Uses']} rows={(Taxonomy[fam] as readonly string[]).map((v) => [<Mono key="v">{v}</Mono>, count(fam, v)])} />
          </Section>
        ))}
      </div>
      <Section title="Versions"><Table head={['Version', 'When', 'By', 'Reason']} rows={d0.versions.map((v) => [`v${v.version}`, dt(v.created_at), (v.by as string) ?? 'seed', (v.reason as string) ?? '—'])} /></Section>
      <Section title="Record a new version">
        <div className="ak-panel" style={{ maxWidth: 640 }}>
          <ActForm action="taxonomy.version" submit="🔐 Record version" fields={[{ name: 'spec', label: 'Change spec (JSON: add / rename / deprecate + remap)', type: 'json', required: true, defaultValue: JSON.stringify({ add: { angle: [] }, rename: {}, deprecate: {}, remap: {} }, null, 2) }, { name: 'reason', label: 'Reason', required: true }]} />
        </div>
      </Section>
    </Page>
  );
}
