import { withAdmin } from '@arkiv/db';
import { staffCan } from '@arkiv/core';
import { ActForm } from '@/components/act';
import { ago, dt, Grid, Kpi, Mono, Page, Section, Table } from '@/components/ui';
import { requireStaff } from '@/lib/staff';

export const metadata = { title: 'System health' };

/** Plan 05 §22. */
export default async function SystemHealth() {
  const s = await requireStaff('system.read');
  const d0 = await withAdmin(async (tx) => {
    const [db] = await tx`select current_setting('server_version') as version, (select count(*) from pg_stat_activity)::int as connections, pg_database_size(current_database())::bigint as size`;
    const settings = await tx`select key, value, updated_at from platform_settings where key in ('status.banner', 'ops.restore_drill')`;
    const [outbox] = await tx`select count(*)::int as n from outbox where dispatched_at is null`;
    const [lastOps] = await tx`select max(executed_at) as last from ops_commands`;
    const [lastSweep] = await tx`select max(created_at) as last from ledger_entries where actor like 'system:%'`;
    const migrations = await tx.savepoint((sp) => sp`select name, applied_at from schema_migrations order by 1 desc limit 10`).catch(() => []);
    return { db, settings, outbox, lastOps, lastSweep, migrations };
  });
  const banner = d0.settings.find((x) => x.key === 'status.banner')?.value as { text: string; tone: string } | null;
  const drill = d0.settings.find((x) => x.key === 'ops.restore_drill')?.value as { at: string; result: string; notes?: string; by?: string } | null;
  const drillStale = !drill || Date.now() - new Date(drill.at).getTime() > 90 * 86400_000;
  return (
    <Page title="System health">
      <Grid>
        <Kpi label="Postgres" value={String(d0.db!.version)} sub={`${d0.db!.connections} connections · ${(Number(d0.db!.size) / 1e9).toFixed(2)} GB`} />
        <Kpi label="Outbox backlog" value={d0.outbox!.n} alert={Number(d0.outbox!.n) > 100} sub="committed, not dispatched" />
        <Kpi label="Worker last system write" value={ago(d0.lastSweep!.last)} sub={`ops command ${ago(d0.lastOps!.last)} ago`} />
        <Kpi label="Restore drill" value={drill ? drill.result : 'never'} alert={drillStale || drill?.result === 'failed'} sub={drill ? `${dt(drill.at)} by ${drill.by ?? '—'}` : 'Required before paid launch (§39)'} />
      </Grid>
      <div className="ak-grid-2" style={{ alignItems: 'start' }}>
        {staffCan(s.roles, 'system.banner') ? (
          <Section title="Status banner (shown to all tenants)">
            <div className="ak-panel">
              <p className="ak-small">Current: {banner?.text ? `“${banner.text}” (${banner.tone})` : 'none'}</p>
              <ActForm action="banner.set" submit="Publish banner" fields={[{ name: 'text', label: 'Text (empty clears)', defaultValue: banner?.text ?? '' }, { name: 'tone', label: 'Tone', type: 'select', options: ['info', 'warn', 'risk'] }]} />
            </div>
          </Section>
        ) : null}
        <Section title="Record a restore drill">
          <div className="ak-panel"><ActForm action="ops.restore_drill" submit="Record" fields={[{ name: 'result', label: 'Result', type: 'select', options: ['passed', 'failed'] }, { name: 'notes', label: 'Notes (RPO/RTO observed)', type: 'textarea' }]} /></div>
        </Section>
      </div>
      <Section title="Migrations"><Table head={['Migration', 'Applied']} rows={d0.migrations.map((m) => [<Mono key="n">{String(Object.values(m)[0])}</Mono>, dt(Object.values(m)[1])])} /></Section>
      <p className="ak-small ak-muted">Logs, traces and metrics: DigitalOcean Monitoring + OpenTelemetry exporter (vendor to confirm). Backups: DO Managed Postgres daily + PITR.</p>
    </Page>
  );
}
