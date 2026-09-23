import Link from 'next/link';
import { withAdmin } from '@arkiv/db';
import { ActButton } from '@/components/act';
import { ago, d, Mono, Page, pct, Section, Table } from '@/components/ui';
import { requireStaff } from '@/lib/staff';

export const metadata = { title: 'Integrations health' };

const API_VERSIONS = [
  ['Meta Marketing API', 'v23.0', 'Check sunset calendar quarterly; contract tests must pass before switching'],
  ['TikTok Business API', 'v1.3', '—'],
  ['Shopify Admin GraphQL', '2026-07', 'Quarterly versions; supported ~12 months'],
];

/** Plan 05 §16: metadata only. */
export default async function Integrations() {
  await requireStaff('integrations.read');
  const d0 = await withAdmin(async (tx) => ({
    summary: await tx`select provider, count(*)::int as n, count(*) filter (where status = 'active' and last_success_at > now() - interval '7 days')::int as fresh,
                             count(*) filter (where status = 'revoked')::int as revoked, count(*) filter (where status = 'degraded')::int as degraded
                      from integrations where status <> 'disconnected' group by provider`,
    errors: await tx`select provider, coalesce(error->>'kind', 'unknown') as kind, count(*)::int as n from integrations where error is not null and status <> 'disconnected' group by 1, 2 order by 3 desc`,
    stale: await tx`select i.id, i.workspace_id, w.name, i.provider, i.status, i.last_success_at, i.token_expires_at, i.scopes, i.error from integrations i join workspaces w on w.id = i.workspace_id
                    where i.status <> 'disconnected' and (i.status <> 'active' or i.last_success_at is null or i.last_success_at < now() - interval '7 days') order by i.last_success_at nulls first limit 100`,
    shops: await tx`select count(*)::int as n from shopify_shops`,
  }));
  return (
    <Page title="Integrations health" sub={`${d0.shops[0]!.n} Shopify shops routed (one workspace per shop).`} actions={<ActButton action="integration.verify" payload={{}}>Verify Shopify webhooks</ActButton>}>
      <Table head={['Connector', 'Connections', 'Fresh (7d)', 'Degraded', 'Revoked']} rows={d0.summary.map((x) => [x.provider as string, x.n as number, pct(Number(x.fresh) / Number(x.n), 0), x.degraded as number, x.revoked as number])} empty="No connections yet." />
      <div className="ak-grid-2" style={{ alignItems: 'start' }}>
        <Section title="Error classes"><Table head={['Connector', 'Kind', 'Count']} rows={d0.errors.map((e) => [e.provider as string, e.kind as string, e.n as number])} empty="No errors." /></Section>
        <Section title="API versions"><Table head={['API', 'In use', 'Notes']} rows={API_VERSIONS.map((v) => v.map((x, i) => (i === 1 ? <Mono key="v">{x}</Mono> : x)))} /></Section>
      </div>
      <Section title="Stale or unhealthy connections">
        <Table head={['Workspace', 'Connector', 'Status', 'Last success', 'Token expiry', 'Scopes', 'Error']} rows={d0.stale.map((x) => [<Link key="w" href={`/tenants/${x.workspace_id}?tab=integrations`}>{x.name as string}</Link>, x.provider as string, x.status as string, ago(x.last_success_at), d(x.token_expires_at), (x.scopes as string[]).join(','), <span key="e" className="ak-small">{(x.error as { message?: string } | null)?.message ?? ''}</span>])} empty="All connections fresh." />
      </Section>
    </Page>
  );
}
