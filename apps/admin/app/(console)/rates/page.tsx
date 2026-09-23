import { withAdmin } from '@arkiv/db';
import { estimateStandardTest } from '@/lib/estimates';
import { ActButton, ActForm } from '@/components/act';
import { dt, money, Mono, Page, Section, Table } from '@/components/ui';
import { requireStaff } from '@/lib/staff';

export const metadata = { title: 'Rate tables' };

/** Plan 05 §9: FINANCE proposes; publishing always needs a second approver; impact preview on the standard test. */
export default async function Rates() {
  await requireStaff('rates.propose');
  const rows = await withAdmin((tx) => tx`select r.*, c.name as creator, a.name as approver from provider_rate_tables r left join staff_users c on c.id = r.created_by left join staff_users a on a.id = r.approved_by order by r.provider, r.model, r.version desc`);
  const current = await estimateStandardTest('published');
  return (
    <Page title="Provider rate tables" sub={<>Standard 15s Creative Test estimate at published rates: <strong>{money(current)}</strong> (ceiling $8.50). Discounts are recorded as savings in notes, not as the rate.</>}>
      <Table head={['Provider', 'Model', 'Version', 'Unit', 'Rates', 'Status', 'Effective', 'Created by', 'Approved by', 'Impact', '']} rows={await Promise.all(rows.map(async (r) => [
        r.provider as string, <Mono key="m">{r.model as string}</Mono>, `v${r.version}`, r.unit as string, <Mono key="r">{JSON.stringify(r.rates)}</Mono>, r.status as string, dt(r.effective_from), (r.creator as string) ?? 'seed', (r.approver as string) ?? '—',
        r.status === 'draft' ? `${money(current)} → ${money(await estimateStandardTest(r.id as string))}` : '',
        r.status === 'draft' ? <ActButton key="p" small action="rates.publish" payload={{ rateTableId: r.id }} reason="Why (link to provider notice)">🔐 Publish (four-eyes)</ActButton> : null,
      ]))} />
      <Section title="Propose a new version">
        <div className="ak-panel" style={{ maxWidth: 560 }}>
          <ActForm action="rates.propose" submit="Create draft" fields={[
            { name: 'provider', label: 'Provider', type: 'select', options: ['anthropic', 'byteplus', 'minimax'] },
            { name: 'model', label: 'Model (logical name)', required: true, placeholder: 'dreamina-seedance-2-5' },
            { name: 'unit', label: 'Unit', type: 'select', options: ['per_mtok', 'per_image', 'per_second', 'per_kchar'] },
            { name: 'rates', label: 'Rates (JSON, USD)', type: 'json', required: true, defaultValue: '{"input": 0, "output": 0}' },
            { name: 'sourceUrl', label: 'Source URL' },
            { name: 'notes', label: 'Notes', type: 'textarea' },
          ]} />
        </div>
      </Section>
    </Page>
  );
}
