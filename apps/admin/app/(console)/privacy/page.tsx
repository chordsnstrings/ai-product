import Link from 'next/link';
import { withAdmin } from '@arkiv/db';
import { ActForm } from '@/components/act';
import { dt, Mono, Page, Section, Table } from '@/components/ui';
import { requireStaff } from '@/lib/staff';

export const metadata = { title: 'Data requests' };

/** Plan 05 §21: statutory due dates (CCPA 45 days), purge certificates. */
export default async function Privacy() {
  await requireStaff('privacy.manage');
  const d0 = await withAdmin(async (tx) => ({
    requests: await tx`select * from data_requests order by (status in ('open','in_progress')) desc, due_at`,
    certs: await tx`select * from purge_certificates order by completed_at desc limit 50`,
  }));
  return (
    <Page title="Data requests & privacy">
      <Table head={['Opened', 'Kind', 'Requester', 'Workspace', 'Due', 'Status', '']} rows={d0.requests.map((r) => {
        const overdue = ['open', 'in_progress'].includes(r.status as string) && new Date(r.due_at as string) < new Date(Date.now() + 7 * 86400_000);
        return [dt(r.created_at), r.kind as string, r.requester_email as string, r.workspace_id ? <Link key="w" href={`/tenants/${r.workspace_id}?tab=danger`}>{String(r.workspace_id).slice(0, 8)}</Link> : '—', <span key="d" style={{ color: overdue ? 'var(--risk)' : undefined }}>{dt(r.due_at)}</span>, r.status as string,
          ['open', 'in_progress'].includes(r.status as string) ? <ActForm key="u" inline action="privacy.update" extra={{ id: r.id }} submit="Update" fields={[{ name: 'status', label: 'Status', type: 'select', options: ['in_progress', 'completed', 'rejected'] }, { name: 'notes', label: 'Notes' }]} /> : ((r.notes as string) ?? '')];
      })} empty="No requests." />
      <div className="ak-grid-2" style={{ alignItems: 'start' }}>
        <Section title="Log a request">
          <div className="ak-panel"><ActForm action="privacy.create" submit="Create (due in 45 days)" fields={[{ name: 'kind', label: 'Kind', type: 'select', options: ['access', 'export', 'delete_workspace', 'delete_user', 'delete_person_in_reviews'] }, { name: 'requesterEmail', label: 'Requester email', required: true }, { name: 'workspaceId', label: 'Workspace id' }, { name: 'notes', label: 'Notes', type: 'textarea' }]} /></div>
        </Section>
        <Section title="Erase a person’s review text (break-glass write + tenant notice)">
          <div className="ak-panel"><ActForm action="privacy.erase_reviews" submit="🔐 Erase" fields={[{ name: 'workspaceId', label: 'Workspace id', required: true }, { name: 'phrase', label: 'Distinctive phrase / name in the review', required: true }, { name: 'reason', label: 'Request reference', required: true }]} /></div>
        </Section>
      </div>
      <Section title="Purge certificates"><Table head={['Completed', 'Workspace', 'Rows deleted', 'Objects deleted', 'Undeletable']} rows={d0.certs.map((c) => [dt(c.completed_at), <Mono key="w">{String(c.workspace_id)}</Mono>, <Mono key="c">{JSON.stringify(c.counts).slice(0, 120)}</Mono>, c.objects_deleted as number, <Mono key="u">{JSON.stringify(c.undeletable)}</Mono>])} empty="No purges yet." /></Section>
    </Page>
  );
}
