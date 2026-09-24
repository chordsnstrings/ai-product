import Link from 'next/link';
import { withAdmin } from '@arkiv/db';
import { API_VERSIONS, apiVersions, auditView, CONNECTOR_POLICY, missingScopes, setting, staffCan, type ConnectorProvider } from '@arkiv/core';
import { ActButton, ActForm } from '@/components/act';
import { ago, d, dt, Mono, Page, pct, Section, Table } from '@/components/ui';
import { consolePrefs } from '@/lib/prefs';
import { integrationFresh, notTest } from '@/lib/sql';
import { requireStaff } from '@/lib/staff';

export const metadata = { title: 'Integrations health' };

const PROVIDERS = Object.keys(CONNECTOR_POLICY) as ConnectorProvider[];
const hours = (p: ConnectorProvider) => CONNECTOR_POLICY[p].freshnessHours;
const APP_STATUSES = ['unknown', 'in_review', 'approved', 'live', 'rejected', 'suspended', 'action_required'];

/** Plan 05 §16: metadata only. Freshness is judged against each connector's policy (standard §31). */
export default async function Integrations({ searchParams }: { searchParams: Promise<{ stale?: string }> }) {
  const s = await requireStaff('integrations.read');
  const canManage = staffCan(s.roles, 'integrations.manage');
  const staleOnly = (await searchParams).stale === '1';
  const prefs = await consolePrefs();
  const d0 = await withAdmin(async (tx) => {
    await auditView(tx, s, 'integrations', { stale: staleOnly, includeTest: prefs.includeTest });
    // "Fresh" = active and synced inside the connector's own freshness window.
    const fresh = () => integrationFresh(tx);
    const days = Number(await setting(tx, 'integrations.sunset_banner_days'));
    return {
      days,
      summary: await tx`select provider, count(*)::int as n, count(*) filter (where ${fresh()})::int as fresh,
                               count(*) filter (where status = 'revoked')::int as revoked, count(*) filter (where status = 'degraded')::int as degraded,
                               count(*) filter (where token_expires_at < now() + interval '7 days')::int as expiring
                        from integrations where status <> 'disconnected' ${notTest(tx, prefs)} group by provider`,
      rateLimits: await tx`select provider, count(*)::int as n, count(distinct integration_id)::int as connections from integration_rate_limits
                           where at > now() - interval '7 days' ${notTest(tx, prefs)} group by provider`,
      errors: await tx`select provider, coalesce(error->>'kind', 'unknown') as kind, count(*)::int as n from integrations where error is not null and status <> 'disconnected' ${notTest(tx, prefs)} group by 1, 2 order by 3 desc`,
      stale: await tx`select i.id, i.workspace_id, w.name, i.provider, i.status, i.last_success_at, i.last_complete_date, i.cursor, i.token_expires_at, i.scopes, i.error
                      from (select *, ${fresh()} as fresh from integrations) i join workspaces w on w.id = i.workspace_id
                      where i.status <> 'disconnected' and not i.fresh ${notTest(tx, prefs, 'i.workspace_id')} order by i.last_success_at nulls first limit 100`,
      shops: await tx`select s.shop_domain, s.workspace_id, w.name, s.webhooks_verified_at, s.webhook_health from shopify_shops s join workspaces w on w.id = s.workspace_id
                      order by (s.webhook_health->>'ok')::boolean nulls first, s.webhooks_verified_at nulls first limit 100`,
      versions: await apiVersions(tx),
      appStatus: ((await tx`select value, updated_at from platform_settings where key = 'integrations.app_status'`)[0]?.value ?? {}) as Record<string, { status?: string; note?: string | null; updatedAt?: string; by?: string }>,
      contract: await tx`select provider, api_version, passed, total, failed, commit_sha, ran_at from contract_test_runs order by ran_at desc limit 15`,
    };
  });
  const scopeCell = (p: ConnectorProvider, granted: string[]) => {
    const missing = missingScopes(p, granted);
    return (
      <span key="s" className="ak-small">
        {granted.join(', ') || '—'}
        {missing.length ? <strong> · missing {missing.join(', ')}</strong> : CONNECTOR_POLICY[p].requestedScopes.length ? ' · as requested' : ''}
      </span>
    );
  };
  const staleTable = (
    <Section title="Stale or unhealthy connections">
      <Table
        head={['Workspace', 'Connector', 'Status', 'Last success', 'Last complete date', 'Cursor', 'Scopes (granted vs requested)', 'Token expiry', 'Error']}
        rows={d0.stale.map((x) => {
          const p = x.provider as ConnectorProvider;
          const exp = x.token_expires_at ? new Date(x.token_expires_at as string) : null;
          return [
            <Link key="w" href={`/tenants/${x.workspace_id}?tab=integrations`}>{x.name as string}</Link>,
            CONNECTOR_POLICY[p]?.label ?? p,
            x.status === 'degraded' ? <strong key="st">degraded</strong> : (x.status as string),
            ago(x.last_success_at),
            d(x.last_complete_date),
            <Mono key="c">{JSON.stringify(x.cursor ?? {}).slice(0, 80)}</Mono>,
            scopeCell(p, (x.scopes as string[]) ?? []),
            exp ? (exp < new Date() ? <strong key="e">expired {d(exp)}</strong> : d(exp)) : '—',
            <span key="er" className="ak-small">{(x.error as { kind?: string; message?: string } | null)?.message ?? ''}</span>,
          ];
        })}
        empty="All connections inside their freshness policy."
      />
    </Section>
  );
  if (staleOnly) {
    return (
      <Page title="Integrations health" sub={<>Showing stale or unhealthy connections only (from Pulse). <Link href="/integrations">Show everything</Link></>}>
        {staleTable}
      </Page>
    );
  }
  const byProvider = new Map(d0.summary.map((x) => [x.provider as string, x]));
  const rl = new Map(d0.rateLimits.map((x) => [x.provider as string, x]));
  const verified = d0.shops.filter((x) => x.webhooks_verified_at);
  const unhealthy = d0.shops.filter((x) => (x.webhook_health as { ok?: boolean } | null)?.ok === false);
  return (
    <Page title="Integrations health" sub={`${d0.shops.length} Shopify shops routed (one workspace per shop). Test accounts ${prefs.includeTest ? 'included' : 'excluded'}.`} actions={canManage ? <ActButton action="integration.verify" payload={{}}>Verify Shopify webhooks now</ActButton> : null}>
      <Table
        head={['Connector', 'Freshness policy', 'Connections', 'Fresh', 'Degraded', 'Revoked', 'Tokens expiring (7d)', 'Rate-limit hits (7d)', 'API version']}
        rows={PROVIDERS.map((p) => {
          const x = byProvider.get(p);
          const n = Number(x?.n ?? 0);
          const r = rl.get(p);
          return [CONNECTOR_POLICY[p].label, `synced within ${hours(p) >= 48 && hours(p) % 24 === 0 ? `${hours(p) / 24} days` : `${hours(p)} h`}`, n, n ? pct(Number(x!.fresh) / n, 0) : '—', Number(x?.degraded ?? 0), Number(x?.revoked ?? 0), Number(x?.expiring ?? 0), r ? `${r.n} (${r.connections} conn.)` : 0, <Mono key="v">{API_VERSIONS[p]}</Mono>];
        })}
      />
      <div className="ak-grid-2" style={{ alignItems: 'start' }}>
        <Section title="Error classes"><Table head={['Connector', 'Kind', 'Count']} rows={d0.errors.map((e) => [e.provider as string, e.kind as string, e.n as number])} empty="No errors." /></Section>
        <Section title="API versions">
          <Table
            head={['API', 'In use', 'Deprecates', 'Sunset', '']}
            rows={d0.versions.map((v) => {
              const left = v.sunsetOn ? Math.ceil((Date.parse(v.sunsetOn) - Date.now()) / 86400_000) : null;
              const mismatch = API_VERSIONS[v.provider] && API_VERSIONS[v.provider] !== v.version;
              return [
                v.api,
                <Mono key="v">{v.version}{mismatch ? ` (code calls ${API_VERSIONS[v.provider]})` : ''}</Mono>,
                v.deprecatesOn ?? '—',
                v.sunsetOn ? (left != null && left <= d0.days ? <strong key="s">{v.sunsetOn} ({left} days)</strong> : v.sunsetOn) : '—',
                <span key="n" className="ak-small">{v.notes ?? ''}</span>,
              ];
            })}
            empty="No API versions recorded (setting integrations.api_versions)."
          />
          <p className="ak-small ak-muted">Dates live in the <Mono>integrations.api_versions</Mono> setting (Flags & config). The console warns {d0.days} days before a sunset; an <Mono>api.&lt;platform&gt;_version.&lt;version&gt;</Mono> switch flag can only be enabled after a passing contract test run on that version.</p>
        </Section>
      </div>
      <div className="ak-grid-2" style={{ alignItems: 'start' }}>
        <Section title="Platform app status">
          <Table
            head={['Platform', 'Status', 'Note', 'Updated']}
            rows={PROVIDERS.map((p) => {
              const a = d0.appStatus[p] ?? {};
              return [CONNECTOR_POLICY[p].label, (a.status ?? 'unknown').replace(/_/g, ' '), <span key="n" className="ak-small">{a.note ?? ''}</span>, a.updatedAt ? `${dt(a.updatedAt)}${a.by ? ` · ${a.by}` : ''}` : '—'];
            })}
          />
          {canManage ? (
            <div className="ak-panel" style={{ marginTop: 12 }}>
              <ActForm action="integration.app_status" submit="Record status" fields={[{ name: 'provider', label: 'Platform', type: 'select', options: PROVIDERS }, { name: 'status', label: 'Status (Meta app review, TikTok app, Shopify listing)', type: 'select', options: APP_STATUSES }, { name: 'note', label: 'Note' }]} />
            </div>
          ) : null}
        </Section>
        <Section title="Contract test runs (§51)">
          <Table head={['Platform', 'Version', 'Result', 'When', 'Commit']} rows={d0.contract.map((c) => [c.provider as string, <Mono key="v">{c.api_version as string}</Mono>, c.passed ? `passed ${c.total}` : <strong key="f">failed {c.failed}/{c.total}</strong>, dt(c.ran_at), <Mono key="c">{String(c.commit_sha ?? '—').slice(0, 8)}</Mono>])} empty="No runs recorded yet (pnpm test:contract)." />
        </Section>
      </div>
      <Section title={`Shopify webhook subscriptions (verified nightly) · ${verified.length}/${d0.shops.length} checked · ${unhealthy.length} unhealthy`}>
        <Table
          head={['Shop', 'Workspace', 'Verified', 'Health', 'Re-registered', 'Error']}
          rows={d0.shops.map((x) => {
            const h = x.webhook_health as { ok?: boolean; missing?: string[]; repaired?: string[]; error?: string | null } | null;
            return [<Mono key="s">{x.shop_domain as string}</Mono>, <Link key="w" href={`/tenants/${x.workspace_id}?tab=integrations`}>{x.name as string}</Link>, ago(x.webhooks_verified_at), !h ? 'not checked' : h.ok ? 'ok' : <strong key="h">missing {(h.missing ?? []).join(', ') || '—'}</strong>, (h?.repaired ?? []).join(', ') || '—', <span key="e" className="ak-small">{h?.error ?? ''}</span>];
          })}
          empty="No Shopify shops connected."
        />
      </Section>
      {staleTable}
    </Page>
  );
}
