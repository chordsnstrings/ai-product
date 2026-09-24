import { withAdmin } from '@arkiv/db';
import { describeAudience, HEARTBEAT_STALE_SECONDS, lastBackup, setting, staffCan, type StatusBannerValue } from '@arkiv/core';
import { ActForm } from '@/components/act';
import { ago, dt, Grid, Kpi, Mono, Page, Section, Table } from '@/components/ui';
import { requireStaff } from '@/lib/staff';

export const metadata = { title: 'System health' };

const SERVICES = ['web', 'worker', 'admin'] as const;

/** Plan 05 §22: service status, database, queues, storage errors, backups and restore drills, observability links, status banner. */
export default async function SystemHealth() {
  const s = await requireStaff('system.read');
  const d0 = await withAdmin(async (tx) => {
    const [db] = await tx`select current_setting('server_version') as version, (select count(*) from pg_stat_activity)::int as connections,
                                 current_setting('max_connections')::int as max_connections, pg_database_size(current_database())::bigint as size, pg_is_in_recovery() as replica`;
    const settings = await tx`select key, value, updated_at from platform_settings where key in ('status.banner', 'ops.restore_drill')`;
    const [outbox] = await tx`select count(*)::int as n, min(created_at) filter (where run_after <= now()) as oldest from outbox where dispatched_at is null`;
    const [lastOps] = await tx`select max(executed_at) as last from ops_commands`;
    const heartbeats = await tx`select service, instance, started_at, last_seen_at, detail, last_seen_at > now() - make_interval(secs => ${HEARTBEAT_STALE_SECONDS}) as up
                                from service_heartbeats order by service, last_seen_at desc`;
    const migrations = await tx.savepoint((sp) => sp`select name, applied_at from schema_migrations order by 1 desc limit 10`).catch(() => []);
    // Replication: standbys as seen from the primary (lag per standby), or this server's replay lag when it is one.
    const replication = await tx
      .savepoint((sp) => sp`select coalesce(application_name, client_addr::text, 'standby') as name, state,
                               extract(epoch from replay_lag)::float8 as lag_s from pg_stat_replication`)
      .catch(() => []);
    const [replay] = await tx.savepoint((sp) => sp`select extract(epoch from now() - pg_last_xact_replay_timestamp())::float8 as lag_s`).catch(() => [undefined]);
    // Slow statements (pg_stat_statements, when the extension is installed and readable).
    const slow = await tx
      .savepoint((sp) => sp`select left(regexp_replace(query, '\\s+', ' ', 'g'), 160) as query, calls::bigint as calls, round(mean_exec_time::numeric, 1)::float8 as mean_ms,
                               round(total_exec_time::numeric / 1000, 1)::float8 as total_s
                            from pg_stat_statements where dbid = (select oid from pg_database where datname = current_database())
                            order by mean_exec_time desc limit 10`)
      .catch(() => null);
    const boss = await tx
      .savepoint((sp) => sp`select state, count(*)::int as n, min(created_on) as oldest from pgboss.job where state in ('created', 'retry', 'active', 'failed') group by state`)
      .catch(() => null);
    const [failed24] = boss ? await tx.savepoint((sp) => sp`select count(*)::int as n from pgboss.job where state = 'failed' and completed_on > now() - interval '24 hours'`).catch(() => [undefined]) : [undefined];
    return {
      db,
      settings,
      outbox,
      lastOps,
      heartbeats,
      migrations,
      replication,
      replayLag: replay?.lag_s == null ? null : Number(replay.lag_s),
      slow,
      boss,
      failed24: failed24 ? Number(failed24.n) : null,
      backup: await lastBackup(tx),
      links: { logs: await setting(tx, 'ops.logs_url'), traces: await setting(tx, 'ops.traces_url'), metrics: await setting(tx, 'ops.metrics_url') },
    };
  });
  const banner = d0.settings.find((x) => x.key === 'status.banner')?.value as StatusBannerValue | null;
  const drill = d0.settings.find((x) => x.key === 'ops.restore_drill')?.value as { at: string; result: string; notes?: string; by?: string } | null;
  const drillStale = !drill || Date.now() - new Date(drill.at).getTime() > 90 * 86400_000;
  const backupStale = !d0.backup.lastAt || Date.now() - new Date(d0.backup.lastAt).getTime() > 36 * 3600_000;
  const up = (svc: string) => d0.heartbeats.filter((h) => h.service === svc && h.up).length;
  const storageErrors = d0.heartbeats.filter((h) => h.up).reduce((n, h) => n + Number((h.detail as { storageErrors?: number }).storageErrors ?? 0), 0);
  const bossBy = new Map((d0.boss ?? []).map((b) => [b.state as string, b]));
  const maxLag = Math.max(0, ...d0.replication.map((r) => Number(r.lag_s ?? 0)), d0.replayLag ?? 0);
  const link = (label: string, url: string) => (url ? <a key={label} href={url} target="_blank" rel="noreferrer">{label}</a> : <span key={label} className="ak-muted">{label} (not set)</span>);
  return (
    <Page title="System health" sub={<span className="ak-row" style={{ gap: 12 }}>{link('Logs', d0.links.logs)}{link('Traces', d0.links.traces)}{link('Metrics', d0.links.metrics)}<span className="ak-small ak-muted">Links are the ops.logs_url / ops.traces_url / ops.metrics_url settings.</span></span>}>
      <Grid>
        {SERVICES.map((svc) => (
          <Kpi key={svc} label={`Service: ${svc}`} value={`${up(svc)} up`} alert={svc !== 'admin' && up(svc) === 0} alertText="Down" sub={`last seen ${ago(d0.heartbeats.find((h) => h.service === svc)?.last_seen_at)}`} />
        ))}
        <Kpi label="Postgres" value={String(d0.db!.version)} sub={`${d0.db!.connections}/${d0.db!.max_connections} connections · ${(Number(d0.db!.size) / 1e9).toFixed(2)} GB${d0.db!.replica ? ' · replica' : ''}`} alert={Number(d0.db!.connections) > 0.8 * Number(d0.db!.max_connections)} />
        <Kpi label="Replication lag" value={d0.replication.length || d0.db!.replica ? `${maxLag.toFixed(1)} s` : 'no standbys'} alert={maxLag > 30} sub={d0.replication.length ? `${d0.replication.length} standby(s)` : 'managed failover standby not visible to this role'} />
        <Kpi label="Outbox backlog" value={d0.outbox!.n} alert={Number(d0.outbox!.n) > 100} sub={`committed, not dispatched · oldest due ${ago(d0.outbox!.oldest)}`} />
        <Kpi label="pg-boss" value={d0.boss ? `${Number(bossBy.get('active')?.n ?? 0)} active` : 'not readable'} sub={d0.boss ? `${Number(bossBy.get('created')?.n ?? 0) + Number(bossBy.get('retry')?.n ?? 0)} queued · ${d0.failed24 ?? 0} failed 24h · ops command ${ago(d0.lastOps!.last)}` : '—'} alert={(d0.failed24 ?? 0) > 50} />
        <Kpi label="Spaces errors" value={storageErrors} alert={storageErrors > 0} sub="since each live instance started" />
        <Kpi label="Last backup" value={d0.backup.lastAt ? ago(d0.backup.lastAt) : 'unknown'} alert={backupStale} sub={`${d0.backup.source === 'digitalocean' ? 'DigitalOcean API' : d0.backup.source === 'manual' ? 'recorded by staff' : 'not recorded'}${d0.backup.detail ? ` · ${d0.backup.detail}` : ''}`} />
        <Kpi label="Restore drill" value={drill ? drill.result : 'never'} alert={drillStale || drill?.result === 'failed'} sub={drill ? `${dt(drill.at)} by ${drill.by ?? '—'}` : 'Required before paid launch (§39)'} />
      </Grid>
      <Section title="Service instances">
        <Table
          head={['Service', 'Instance', 'Status', 'Started', 'Last seen', 'Spaces errors', 'Last storage error']}
          rows={d0.heartbeats.map((h) => {
            const x = h.detail as { storageErrors?: number; lastStorageError?: string | null; startedAt?: string };
            return [h.service as string, <Mono key="i">{h.instance as string}</Mono>, h.up ? 'up' : <strong key="s">stale</strong>, dt(x.startedAt ?? h.started_at), ago(h.last_seen_at), x.storageErrors ?? 0, <span key="e" className="ak-small">{x.lastStorageError ?? ''}</span>];
          })}
          empty="No heartbeats yet (web and admin report on health checks; the worker every minute)."
        />
      </Section>
      <div className="ak-grid-2" style={{ alignItems: 'start' }}>
        <Section title="Replication">
          <Table head={['Standby', 'State', 'Replay lag']} rows={d0.replication.map((r) => [r.name as string, r.state as string, r.lag_s == null ? '—' : `${Number(r.lag_s).toFixed(1)} s`])} empty={d0.db!.replica ? `This server is a replica (replay lag ${d0.replayLag?.toFixed(1) ?? '—'} s).` : 'No standbys visible.'} />
        </Section>
        <Section title="pg-boss queues">
          <Table head={['State', 'Jobs', 'Oldest']} rows={(d0.boss ?? []).map((b) => [b.state as string, b.n as number, ago(b.oldest)])} empty={d0.boss ? 'No pending jobs.' : 'pg-boss schema not readable by this role.'} />
        </Section>
      </div>
      <Section title="Slowest statements (mean time)">
        {d0.slow ? (
          <Table head={['Statement', 'Calls', 'Mean', 'Total']} rows={d0.slow.map((q) => [<Mono key="q">{q.query as string}</Mono>, Number(q.calls), `${q.mean_ms} ms`, `${q.total_s} s`])} empty="No statements recorded." />
        ) : (
          <p className="ak-small ak-muted">pg_stat_statements isn’t installed or readable here (enable it on the managed database to see slow queries).</p>
        )}
      </Section>
      <div className="ak-grid-2" style={{ alignItems: 'start' }}>
        {staffCan(s.roles, 'system.banner') ? (
          <Section title="Status banner">
            <div className="ak-panel">
              <p className="ak-small">Current: {banner?.text ? `“${banner.text}” (${banner.tone}) → ${describeAudience(banner.audience)}` : 'none'}</p>
              <ActForm
                action="banner.set"
                submit="Publish banner"
                fields={[
                  { name: 'text', label: 'Text (empty clears)', defaultValue: banner?.text ?? '' },
                  { name: 'tone', label: 'Tone', type: 'select', options: ['info', 'warn', 'risk'] },
                  { name: 'audience', label: 'Show to', type: 'select', options: [{ value: 'all', label: 'All tenants' }, { value: 'plans', label: 'Plans (list below)' }, { value: 'integration', label: 'Workspaces with a connector' }, { value: 'workspaces', label: 'Listed workspaces' }] },
                  { name: 'plans', label: 'Plans (e.g. LAUNCH, GROWTH, FREE)' },
                  { name: 'provider', label: 'Connector', type: 'select', options: ['', 'shopify', 'meta', 'tiktok'] },
                  { name: 'workspaceIds', label: 'Workspace ids (comma separated)', type: 'textarea' },
                ]}
              />
            </div>
          </Section>
        ) : null}
        <Section title="Backups & restore drills">
          <div className="ak-panel">
            <ActForm action="ops.backup_check" submit="Record backup check" fields={[{ name: 'lastBackupAt', label: 'Last successful backup (from the provider console)', type: 'datetime-local', required: true }, { name: 'result', label: 'Result', type: 'select', options: ['ok', 'missing', 'failed'] }, { name: 'notes', label: 'Notes' }]} />
          </div>
          <div className="ak-panel" style={{ marginTop: 12 }}>
            <ActForm action="ops.restore_drill" submit="Record restore drill" fields={[{ name: 'result', label: 'Result', type: 'select', options: ['passed', 'failed'] }, { name: 'notes', label: 'Notes (RPO/RTO observed)', type: 'textarea' }]} />
          </div>
        </Section>
      </div>
      <Section title="Migrations"><Table head={['Migration', 'Applied']} rows={d0.migrations.map((m) => [<Mono key="n">{String(Object.values(m)[0])}</Mono>, dt(Object.values(m)[1])])} /></Section>
    </Page>
  );
}
