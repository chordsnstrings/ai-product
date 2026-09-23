import Link from 'next/link';
import { withAdmin } from '@arkiv/db';
import { PROVISIONAL } from '@arkiv/shared';
import { ActButton, ActForm } from '@/components/act';
import { ago, dt, money, Mono, Page, Section, Table } from '@/components/ui';
import { requireStaff } from '@/lib/staff';

export const metadata = { title: 'Abuse & rights' };

/** Plan 05 §15. */
export default async function Abuse() {
  await requireStaff('abuse.manage');
  const d0 = await withAdmin(async (tx) => ({
    signals: await tx`select kind, key, count(*)::int as n, max(at) as last, max(workspace_id::text) as ws from abuse_signals where at > now() - interval '7 days' group by 1, 2 order by n desc limit 100`,
    farms: await tx`select substring(host(created_ip) from '^\\d+\\.\\d+\\.\\d+') as net, count(*)::int as n from magic_links where created_at > now() - interval '24 hours' and created_ip is not null group by 1 having count(*) > 10 order by 2 desc`,
    cogsOutliers: await tx`select l.workspace_id, w.name, w.state, sum(l.amount)::bigint as spend from ledger_entries l join workspaces w on w.id = l.workspace_id
                           where l.type = 'PROVIDER_COST_RECORDED' and w.state in ('PROVISIONAL','ACTIVE_FREE') and l.created_at > now() - interval '7 days' group by 1, 2, 3 having sum(l.amount) > 1000000 order by spend desc`,
    allow: await tx`select a.*, s.name from abuse_allowlist a join staff_users s on s.id = a.created_by where a.until > now() order by a.until`,
    cases: await tx`select * from rights_cases order by (status in ('open','frozen')) desc, created_at desc limit 50`,
    expiring: await tx`select a.id, a.workspace_id, w.name, a.kind, a.rights_expires_at from assets a join workspaces w on w.id = a.workspace_id where a.rights_expires_at between now() and now() + interval '30 days' order by a.rights_expires_at`,
  }));
  return (
    <Page title="Abuse, rights & trust-safety">
      <Section title="Signals (7d)"><Table head={['Kind', 'Key', 'Count', 'Last', 'Workspace', '']} rows={d0.signals.map((x) => [x.kind as string, <Mono key="k">{x.key as string}</Mono>, x.n as number, ago(x.last), x.ws ? <Link key="w" href={`/tenants/${x.ws}?tab=risk`}>{String(x.ws).slice(0, 8)}</Link> : '—', <ActButton key="a" small action="abuse.allowlist" payload={{ key: x.key, days: 30 }} reason="Why is this legitimate (e.g. agency evaluating SKUs)?">Allowlist 30d</ActButton>])} empty="No abuse signals." /></Section>
      <div className="ak-grid-2" style={{ alignItems: 'start' }}>
        <Section title="Sign-in bursts by /24 (24h)"><Table head={['Network', 'Links']} rows={d0.farms.map((f) => [<Mono key="n">{`${f.net}.0/24`}</Mono>, f.n as number])} empty="No bursts." /></Section>
        <Section title="Free-preview COGS outliers (7d)"><Table head={['Workspace', 'State', 'Spend']} rows={d0.cogsOutliers.map((c) => [<Link key="w" href={`/tenants/${c.workspace_id}`}>{c.name as string}</Link>, c.state as string, money(c.spend)])} empty="Within caps." /></Section>
      </div>
      <Section title="Allowlist">
        <p className="ak-small ak-muted">Allowlisted keys lift the free-preview multi-SKU limit (to a bounded {PROVISIONAL.ALLOWLISTED_MAX_SKUS} SKUs) and the per-network preview rate limit. Keys: <Mono>ip:1.2.3</Mono> (a /24), <Mono>domain:agency.com</Mono>, <Mono>ws:&lt;workspace id&gt;</Mono> — an IP, email or workspace id is normalised.</p>
        <Table head={['Key', 'Reason', 'Until', 'By', '']} rows={d0.allow.map((a) => [<Mono key="k">{a.key as string}</Mono>, a.reason as string, dt(a.until), a.name as string, <ActButton key="r" small action="abuse.allowlist_remove" payload={{ key: a.key }} reason>Remove</ActButton>])} empty="Empty." />
        <div className="ak-panel" style={{ maxWidth: 560, marginTop: 12 }}>
          <ActForm action="abuse.allowlist" submit="Allowlist" fields={[{ name: 'key', label: 'Key (IP, email domain or workspace id)', required: true }, { name: 'days', label: 'Days (max 30)', type: 'number', defaultValue: 30, required: true }, { name: 'reason', label: 'Why is this legitimate?', type: 'textarea', required: true }]} />
        </div>
      </Section>
      <Section title="Rights & takedown cases">
        <Table head={['Opened', 'Complainant', 'Detail', 'Workspace', 'Status', '']} rows={d0.cases.map((c) => [dt(c.created_at), c.complainant as string, <span key="d" className="ak-small">{c.detail as string}</span>, c.workspace_id ? <Link key="w" href={`/tenants/${c.workspace_id}`}>{String(c.workspace_id).slice(0, 8)}</Link> : '—', c.status as string,
          ['open', 'frozen'].includes(c.status as string) ? <ActForm key="u" inline action="rights.update" extra={{ id: c.id }} submit="Update" fields={[{ name: 'status', label: 'Status', type: 'select', options: ['frozen', 'resolved_kept', 'resolved_removed'] }, { name: 'resolution', label: 'Resolution' }]} /> : ((c.resolution as string) ?? '')])} empty="No cases." />
        <div className="ak-panel" style={{ maxWidth: 560, marginTop: 12 }}>
          <ActForm action="rights.create" submit="Open case" fields={[{ name: 'complainant', label: 'Complainant', required: true }, { name: 'detail', label: 'Detail', type: 'textarea', required: true }, { name: 'workspaceId', label: 'Workspace id' }, { name: 'assetId', label: 'Asset id' }]} />
        </div>
      </Section>
      <Section title="Creator rights expiring (30d)"><Table head={['Asset', 'Workspace', 'Kind', 'Expires']} rows={d0.expiring.map((a) => [<Mono key="a">{String(a.id).slice(0, 8)}</Mono>, a.name as string, a.kind as string, dt(a.rights_expires_at)])} empty="Nothing expiring." /></Section>
    </Page>
  );
}
