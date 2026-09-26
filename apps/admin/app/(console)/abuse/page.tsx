import Link from 'next/link';
import { withAdmin } from '@arkiv/db';
import { PROVISIONAL } from '@arkiv/shared';
import { ABUSE_SIGNAL_KINDS, auditView, PROBE_SPIKE_PER_HOUR, staffCan } from '@arkiv/core';
import { ActButton, ActForm } from '@/components/act';
import { ago, dt, money, Mono, Page, Section, Table } from '@/components/ui';
import { requireStaff } from '@/lib/staff';

export const metadata = { title: 'Abuse & rights' };

/** An `ip:a.b.c` key as the /24 it names (IPv4 only), for the block action. */
const ipRange = (key: string) => (/^ip:\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(key) ? `${key.slice(3)}.0/24` : null);

/** Plan 05 §15: rights attestations and takedown cases, abuse signals, and time-boxed enforcement. */
export default async function Abuse() {
  const s = await requireStaff('abuse.manage');
  const canSuspend = staffCan(s.roles, 'tenant.state');
  const d0 = await withAdmin(async (tx) => ({
    audited: await auditView(tx, s, 'abuse'),
    signals: await tx`select kind, key, count(*)::int as n, max(at) as last, max(workspace_id::text) as ws, count(distinct workspace_id)::int as workspaces
                      from abuse_signals where at > now() - interval '7 days' group by 1, 2 order by n desc limit 100`,
    // §48: denied lookups of objects outside the caller's account, per user or network — spikes are someone guessing ids.
    probes: await tx`select key, count(*)::int as n, count(distinct detail->>'targetHash')::int as targets, max((detail->>'thisHour')::int) as peak,
                            string_agg(distinct detail->>'target', ', ') as kinds, max(at) as last
                     from abuse_signals where kind = 'cross_tenant_probe' and at > now() - interval '24 hours'
                     group by key having max((detail->>'thisHour')::int) >= ${PROBE_SPIKE_PER_HOUR} order by peak desc limit 50`,
    farms: await tx`select substring(host(created_ip) from '^\\d+\\.\\d+\\.\\d+') as net, count(*)::int as n from magic_links where created_at > now() - interval '24 hours' and created_ip is not null group by 1 having count(*) > 10 order by 2 desc`,
    cogsOutliers: await tx`select l.workspace_id, w.name, w.state, sum(l.amount)::bigint as spend from ledger_entries l join workspaces w on w.id = l.workspace_id
                           where l.type = 'PROVIDER_COST_RECORDED' and w.state in ('PROVISIONAL','ACTIVE_FREE') and l.created_at > now() - interval '7 days' group by 1, 2, 3 having sum(l.amount) > 1000000 order by spend desc`,
    allow: await tx`select a.*, s.name from abuse_allowlist a join staff_users s on s.id = a.created_by where a.until > now() order by a.until`,
    overrides: await tx`select o.*, s.name from abuse_overrides o left join staff_users s on s.id = o.created_by where o.until > now() order by o.until`,
    blocks: await tx`select b.id, b.cidr::text as cidr, b.reason, b.until, b.created_at, s.name from ip_blocks b left join staff_users s on s.id = b.created_by
                     where b.lifted_at is null and b.until > now() order by b.until`,
    cases: await tx`select * from rights_cases order by (status in ('open','frozen')) desc, created_at desc limit 50`,
    // Rights attestations per merchant-supplied asset (metadata only): who holds the rights, for what, until when.
    attestations: await tx`select a.id, a.workspace_id, w.name, a.kind, a.source, a.rights_owner, a.rights_scope, a.rights_includes_people, a.rights_includes_minors,
                                  a.rights_attested_at, a.rights_expires_at, a.rights_frozen_at
                           from assets a join workspaces w on w.id = a.workspace_id
                           where a.deleted_at is null and (a.kind in ('creator_footage', 'historical_creative') or (a.source in ('upload', 'import') and a.rights_attested_at is not null))
                           order by (a.rights_frozen_at is not null or a.rights_expires_at <= now()) desc, a.rights_expires_at nulls last, a.created_at desc limit 100`,
    expiring: await tx`select a.id, a.workspace_id, w.name, a.kind, a.rights_expires_at from assets a join workspaces w on w.id = a.workspace_id where a.deleted_at is null and a.rights_expires_at between now() and now() + interval '30 days' order by a.rights_expires_at`,
  }));
  const kindLabel = (k: string) => ABUSE_SIGNAL_KINDS[k as keyof typeof ABUSE_SIGNAL_KINDS] ?? k.replace(/_/g, ' ');
  const rightsState = (a: Record<string, unknown>) =>
    a.rights_frozen_at ? 'frozen (takedown)' : a.rights_expires_at && new Date(a.rights_expires_at as string) <= new Date() ? 'expired: unavailable for production' : a.rights_attested_at ? 'attested' : 'not attested';
  return (
    <Page title="Abuse, rights & trust-safety">
      <Section title="Signals (7d)">
        <Table
          head={['Kind', 'Key', 'Count', 'Workspaces', 'Last', 'Workspace', 'Actions']}
          rows={d0.signals.map((x) => {
            const key = x.key as string;
            const range = ipRange(key);
            return [
              <span key="k" className="ak-small">{kindLabel(x.kind as string)}</span>,
              <Mono key="m">{key}</Mono>,
              x.n as number,
              x.workspaces as number,
              ago(x.last),
              x.ws ? <Link key="w" href={`/tenants/${x.ws}?tab=risk`}>{String(x.ws).slice(0, 8)}</Link> : '—',
              <span key="a" className="ak-stack" style={{ ['--stack' as string]: '4px' }}>
                <ActButton small action="abuse.allowlist" payload={{ key, days: 30 }} reason="Why is this legitimate (e.g. agency evaluating SKUs)?">Allowlist 30d</ActButton>
                <ActButton small action="abuse.challenge" payload={{ key, days: 7 }} reason="Why force the challenge?">Challenge 7d</ActButton>
                <ActButton small action="abuse.tighten" payload={{ key, factor: 0.25, days: 7 }} reason="Why tighten this key’s rate limits (to 25%)?">Tighten 7d</ActButton>
                {range ? <ActButton small danger action="abuse.block_ip" payload={{ cidr: range, hours: 24 }} reason={`Why block ${range} for 24 hours?`}>🔐 Block /24 24h</ActButton> : null}
                {canSuspend && x.ws ? <ActButton small danger action="tenant.hold" payload={{ workspaceId: x.ws, hold: 'SUSPENDED' }} reason="Why suspend this workspace?">🔐 Suspend</ActButton> : null}
              </span>,
            ];
          })}
          empty="No abuse signals."
        />
      </Section>
      <Section title={`Denied object-ID probes (24h, ≥${PROBE_SPIKE_PER_HOUR}/hour)`}>
        <Table
          head={['Who', 'Denials', 'Distinct ids', 'Peak / hour', 'Objects', 'Last']}
          rows={d0.probes.map((x) => [<Mono key="k">{x.key as string}</Mono>, x.n as number, x.targets as number, x.peak as number, (x.kinds as string) ?? '—', ago(x.last)])}
          empty="No spikes. Single denials (stale links, logged-out tabs) are in the signals above."
        />
      </Section>
      <div className="ak-grid-2" style={{ alignItems: 'start' }}>
        <Section title="Sign-in bursts by /24 (24h)"><Table head={['Network', 'Links', '']} rows={d0.farms.map((f) => [<Mono key="n">{`${f.net}.0/24`}</Mono>, f.n as number, <ActButton key="b" small danger action="abuse.block_ip" payload={{ cidr: `${f.net}.0/24`, hours: 24 }} reason="Why block this range for 24 hours?">🔐 Block 24h</ActButton>])} empty="No bursts." /></Section>
        <Section title="Free-preview COGS outliers (7d)"><Table head={['Workspace', 'State', 'Spend']} rows={d0.cogsOutliers.map((c) => [<Link key="w" href={`/tenants/${c.workspace_id}`}>{c.name as string}</Link>, c.state as string, money(c.spend)])} empty="Within caps." /></Section>
      </div>
      <Section title="Enforcement">
        <p className="ak-small ak-muted">Forced challenge and tightened limits apply to the preview, upload and sign-in endpoints for the key; a forced challenge can’t be passed while Turnstile isn’t configured. Blocks refuse the range on those endpoints until they expire.</p>
        <div className="ak-grid-2" style={{ alignItems: 'start' }}>
          <Table head={['Key', 'Challenge', 'Limits', 'Reason', 'Until', 'By', '']} rows={d0.overrides.map((o) => [<Mono key="k">{o.key as string}</Mono>, o.force_challenge ? 'forced' : '—', o.rate_limit_factor != null ? `${Math.round(Number(o.rate_limit_factor) * 100)}%` : '—', o.reason as string, dt(o.until), (o.name as string) ?? '—', <ActButton key="r" small action="abuse.override_remove" payload={{ key: o.key }} reason>Remove</ActButton>])} empty="No keys under enforcement." />
          <Table head={['Range', 'Reason', 'Until', 'By', '']} rows={d0.blocks.map((b) => [<Mono key="c">{b.cidr as string}</Mono>, b.reason as string, dt(b.until), (b.name as string) ?? '—', <ActButton key="l" small action="abuse.unblock_ip" payload={{ id: b.id }} reason>Lift</ActButton>])} empty="No IP ranges blocked." />
        </div>
        <div className="ak-grid-2" style={{ alignItems: 'start', marginTop: 12 }}>
          <div className="ak-panel">
            <ActForm action="abuse.tighten" submit="Tighten limits" fields={[{ name: 'key', label: 'Key (IP, email domain or workspace id)', required: true }, { name: 'factor', label: 'Share of normal limits (0.05–0.9)', type: 'number', defaultValue: 0.25, required: true }, { name: 'days', label: 'Days (max 30)', type: 'number', defaultValue: 7, required: true }, { name: 'reason', label: 'Reason', required: true }]} />
          </div>
          <div className="ak-panel">
            <ActForm action="abuse.block_ip" submit="🔐 Block range" fields={[{ name: 'cidr', label: 'IP or range (IPv4 /16 or narrower)', required: true, placeholder: '203.0.113.0/24' }, { name: 'hours', label: 'Hours (max 720)', type: 'number', defaultValue: 24, required: true }, { name: 'reason', label: 'Reason', required: true }]} />
          </div>
        </div>
      </Section>
      <Section title="Allowlist">
        <p className="ak-small ak-muted">Allowlisted keys lift the free-preview multi-SKU limit (to a bounded {PROVISIONAL.ALLOWLISTED_MAX_SKUS} SKUs), the per-network preview rate limit, and the farm / COGS detectors. Keys: <Mono>ip:1.2.3</Mono> (a /24), <Mono>domain:agency.com</Mono>, <Mono>ws:&lt;workspace id&gt;</Mono> — an IP, email or workspace id is normalised.</p>
        <Table head={['Key', 'Reason', 'Until', 'By', '']} rows={d0.allow.map((a) => [<Mono key="k">{a.key as string}</Mono>, a.reason as string, dt(a.until), a.name as string, <ActButton key="r" small action="abuse.allowlist_remove" payload={{ key: a.key }} reason>Remove</ActButton>])} empty="Empty." />
        <div className="ak-panel" style={{ maxWidth: 560, marginTop: 12 }}>
          <ActForm action="abuse.allowlist" submit="Allowlist" fields={[{ name: 'key', label: 'Key (IP, email domain or workspace id)', required: true }, { name: 'days', label: 'Days (max 30)', type: 'number', defaultValue: 30, required: true }, { name: 'reason', label: 'Why is this legitimate?', type: 'textarea', required: true }]} />
        </div>
      </Section>
      <Section title="Rights & takedown cases">
        <p className="ak-small ak-muted">Complaints arrive from the public form (/rights), by email to the rights address, from merchant attestations, or opened here. Freezing makes the asset unavailable for new production until the case is resolved as kept.</p>
        <Table head={['Opened', 'Via', 'Complainant', 'Detail', 'Workspace', 'Asset', 'Status', '']} rows={d0.cases.map((c) => [dt(c.created_at), c.origin as string, <span key="c">{c.complainant as string}{c.complainant_email ? <><br /><Mono>{c.complainant_email as string}</Mono></> : null}</span>, <span key="d" className="ak-small">{c.detail as string}</span>, c.workspace_id ? <Link key="w" href={`/tenants/${c.workspace_id}`}>{String(c.workspace_id).slice(0, 8)}</Link> : '—', c.asset_id ? <Mono key="a">{String(c.asset_id).slice(0, 8)}</Mono> : '—', c.status as string,
          ['open', 'frozen'].includes(c.status as string) ? <ActForm key="u" inline action="rights.update" extra={{ id: c.id }} submit="Update" fields={[{ name: 'status', label: 'Status', type: 'select', options: ['frozen', 'resolved_kept', 'resolved_removed'] }, { name: 'resolution', label: 'Resolution' }]} /> : ((c.resolution as string) ?? '')])} empty="No cases." />
        <div className="ak-panel" style={{ maxWidth: 560, marginTop: 12 }}>
          <ActForm action="rights.create" submit="Open case" fields={[{ name: 'complainant', label: 'Complainant', required: true }, { name: 'detail', label: 'Detail', type: 'textarea', required: true }, { name: 'workspaceId', label: 'Workspace id' }, { name: 'assetId', label: 'Asset id' }]} />
        </div>
      </Section>
      <Section title="Rights attestations (creator & uploaded media)">
        <Table head={['Asset', 'Workspace', 'Kind', 'Rights holder', 'Scope', 'People / minors', 'Attested', 'Expires', 'State']} rows={d0.attestations.map((a) => [<Mono key="a">{String(a.id).slice(0, 8)}</Mono>, <Link key="w" href={`/tenants/${a.workspace_id}`}>{a.name as string}</Link>, String(a.kind).replace(/_/g, ' '), (a.rights_owner as string) ?? '—', (a.rights_scope as string)?.replace(/_/g, ' ') ?? '—', `${a.rights_includes_people ? 'people' : a.rights_includes_people === false ? 'no people' : '—'} / ${a.rights_includes_minors ? 'minors' : a.rights_includes_minors === false ? 'no minors' : '—'}`, dt(a.rights_attested_at), dt(a.rights_expires_at), rightsState(a)])} empty="No creator or uploaded media." />
      </Section>
      <Section title="Creator rights expiring (30d)"><Table head={['Asset', 'Workspace', 'Kind', 'Expires']} rows={d0.expiring.map((a) => [<Mono key="a">{String(a.id).slice(0, 8)}</Mono>, a.name as string, a.kind as string, dt(a.rights_expires_at)])} empty="Nothing expiring." /></Section>
    </Page>
  );
}
