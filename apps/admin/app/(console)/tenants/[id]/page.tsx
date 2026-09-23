import Link from 'next/link';
import { notFound } from 'next/navigation';
import { withAdmin } from '@arkiv/db';
import { activeBreakGlass, assertBreakGlass, audit, staffCan } from '@arkiv/core';
import { PLANS, type PlanCode } from '@arkiv/shared';
import { ActButton, ActForm } from '@/components/act';
import { ago, d, dt, money, Mono, Page, Section, Table, Tabs } from '@/components/ui';
import { requireStaff } from '@/lib/staff';

export const metadata = { title: 'Tenant' };

const TABS: [string, string][] = [
  ['overview', 'Overview'],
  ['members', 'Members'],
  ['skus', 'Brands & SKUs'],
  ['projects', 'Experiments & jobs'],
  ['ledger', 'Ledger'],
  ['billing', 'Billing'],
  ['integrations', 'Integrations'],
  ['emails', 'Emails'],
  ['risk', 'Risk'],
  ['access', 'Access log'],
  ['danger', 'Danger zone'],
];

/** Plan 05 §2.2. Metadata tabs are role-gated; content (the SKU tree) requires an active break-glass session. */
export default async function Tenant({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string }> }) {
  const s = await requireStaff('tenant.read');
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const tab = (await searchParams).tab ?? 'overview';
  const base = `/tenants/${id}`;
  const data = await withAdmin(async (tx) => {
    const [w] = await tx`select * from workspaces where id = ${id}`;
    if (!w) return null;
    await audit(tx, s, 'tenant.view', { type: 'workspace', id }, { workspaceId: id, reason: tab });
    const bg = await activeBreakGlass(tx, s, id);
    return { w, bg };
  });
  if (!data) notFound();
  const { w, bg } = data;

  return (
    <Page
      title={w.name as string}
      sub={<><Mono>{w.slug as string} · {id}</Mono> · {String(w.state).toLowerCase()} · {(w.plan_code as string)?.toLowerCase() ?? 'no plan'} · created {d(w.created_at)}{w.is_vip ? ' · ★ VIP' : ''}{w.is_test ? ' · test account' : ''}</>}
      actions={
        bg ? (
          <span className="ak-row"><span className="ak-chip ak-chip--warn">Break-glass {bg.write ? 'write' : 'read'} until {new Date(bg.expiresAt).toLocaleTimeString()}</span><ActButton small action="tenant.breakglass_end" payload={{ workspaceId: id }}>End</ActButton></span>
        ) : null
      }
    >
      <Tabs base={base} tabs={TABS} current={tab} />
      {tab === 'overview' ? <Overview id={id} w={w} canFlag={staffCan(s.roles, 'tenant.flags')} /> : null}
      {tab === 'members' ? <Members id={id} canManage={staffCan(s.roles, 'tenant.state')} /> : null}
      {tab === 'skus' ? <Skus id={id} staff={s} hasBg={!!bg} canBg={staffCan(s.roles, 'breakglass.read')} canWrite={staffCan(s.roles, 'breakglass.write')} /> : null}
      {tab === 'projects' ? <Projects id={id} canRetry={staffCan(s.roles, 'jobs.manage')} /> : null}
      {tab === 'ledger' ? <Ledger id={id} canAdjust={staffCan(s.roles, 'ledger.adjust')} /> : null}
      {tab === 'billing' ? <Billing id={id} canRefund={staffCan(s.roles, 'billing.refund')} /> : null}
      {tab === 'integrations' ? <Integrations id={id} canManage={staffCan(s.roles, 'integrations.manage')} /> : null}
      {tab === 'emails' ? <Emails id={id} /> : null}
      {tab === 'risk' ? <Risk id={id} /> : null}
      {tab === 'access' ? <Access id={id} /> : null}
      {tab === 'danger' ? <Danger id={id} w={w} canState={staffCan(s.roles, 'tenant.state')} canPurge={staffCan(s.roles, 'tenant.purge')} /> : null}
    </Page>
  );
}

async function Overview({ id, w, canFlag }: { id: string; w: Record<string, unknown>; canFlag: boolean }) {
  const d0 = await withAdmin(async (tx) => ({
    timeline: await tx`select payload, at, actor from events where workspace_id = ${id} and type = 'WORKSPACE_STATE_CHANGED' order by at desc limit 20`,
    ledger: await tx`select unit, coalesce(sum(amount) filter (where type in ('CREDIT_GRANTED','CREDIT_RESERVED','CREDIT_RELEASED','CREDIT_REFUNDED','CREDIT_EXPIRED','CREDIT_ADJUSTED')), 0)::bigint as bal from ledger_entries where workspace_id = ${id} group by unit`,
    counts: (await tx`select (select count(*) from skus where workspace_id = ${id})::int as skus, (select count(*) from experiments where workspace_id = ${id})::int as experiments,
                             (select count(*) from projects where workspace_id = ${id})::int as projects, (select count(*) from memberships where workspace_id = ${id})::int as members,
                             (select coalesce(sum(bytes), 0) from assets where workspace_id = ${id} and deleted_at is null)::bigint as bytes`)[0]!,
    notes: await tx`select n.body, n.created_at, s.name from tenant_notes n left join staff_users s on s.id = n.staff_id where n.workspace_id = ${id} order by n.created_at desc`,
  }));
  const bal = Object.fromEntries(d0.ledger.map((l) => [l.unit as string, Number(l.bal)]));
  const plan = w.plan_code ? PLANS[w.plan_code as PlanCode] : null;
  return (
    <div className="ak-grid-2" style={{ alignItems: 'start' }}>
      <div>
        <Table head={['', '']} rows={[
          ['State', `${String(w.state).toLowerCase()}${w.state_reason ? ` — ${w.state_reason}` : ''}`],
          ['Plan', plan ? `${plan.name} · ${money(plan.priceMicros, 0)}/mo · ${plan.creativeTestsPerMonth} tests` : '—'],
          ['Entitlements', `creative tests ${bal.creative_test ?? 0} · taste ${bal.taste ?? 0} · standalone ${bal.standalone ?? 0}`],
          ['Usage', `${d0.counts.skus} SKUs · ${d0.counts.experiments} experiments · ${d0.counts.projects} projects · ${d0.counts.members} members · ${(Number(d0.counts.bytes) / 1e9).toFixed(2)} GB`],
          ['Timezone', String(w.timezone)],
          ['Tags', ((w.tags as string[]) ?? []).join(', ') || '—'],
        ]} />
        <Section title="State timeline">
          <Table head={['When', 'Change', 'By']} rows={d0.timeline.map((t) => [dt(t.at), `${(t.payload as { from: string }).from} → ${(t.payload as { to: string }).to} · ${(t.payload as { reason?: string }).reason ?? ''}`, <Mono key="a">{String(t.actor).split(':')[0]}</Mono>])} empty="No state changes." />
        </Section>
      </div>
      <div className="ak-stack">
        {canFlag ? (
          <div className="ak-panel">
            <p className="ak-label">Flags</p>
            <ActForm action="tenant.flags" extra={{ workspaceId: id }} submit="Save flags" fields={[
              { name: 'isVip', label: 'VIP', type: 'checkbox', defaultValue: w.is_vip as boolean },
              { name: 'isTest', label: 'Test account (excluded from metrics)', type: 'checkbox', defaultValue: w.is_test as boolean },
              { name: 'tags', label: 'Tags (comma separated)', defaultValue: ((w.tags as string[]) ?? []).join(', ') },
            ]} />
          </div>
        ) : null}
        <div className="ak-panel">
          <p className="ak-label">Notes</p>
          <ActForm action="tenant.note" extra={{ workspaceId: id }} submit="Add note" fields={[{ name: 'body', label: 'Note (staff only)', type: 'textarea', required: true }]} />
          {d0.notes.map((n, i) => <div key={i} className="ak-index-row"><span>{n.body as string}</span><span className="ak-index">{(n.name as string) ?? 'staff'} · {ago(n.created_at)}</span></div>)}
        </div>
      </div>
    </div>
  );
}

async function Members({ id, canManage }: { id: string; canManage: boolean }) {
  const d0 = await withAdmin(async (tx) => ({
    members: await tx`select u.id, u.email, u.name, m.role, u.locked_at, (select max(last_seen_at) from sessions where user_id = u.id) as last_seen,
                             (select count(*) from passkeys where user_id = u.id)::int as passkeys, (select string_agg(provider, ',') from user_identities where user_id = u.id) as idents
                      from memberships m join users u on u.id = m.user_id where m.workspace_id = ${id} order by m.created_at`,
    invites: await tx`select id, email, role, expires_at, revoked_at, accepted_at from invites where workspace_id = ${id} order by created_at desc limit 20`,
  }));
  return (
    <>
      <Table head={['Member', 'Role', 'Sign-in', 'Last seen', '']} rows={d0.members.map((m) => [
        <Link key="u" href={`/users/${m.id}`}>{m.email as string}{m.locked_at ? ' (locked)' : ''}</Link>,
        String(m.role).toLowerCase(),
        `${m.idents ?? 'email'}${Number(m.passkeys) ? ` + ${m.passkeys} passkey` : ''}`,
        ago(m.last_seen),
        <span key="a" className="ak-row">
          <ActButton small action="user.force_logout" payload={{ userId: m.id }} reason>Force logout</ActButton>
          {canManage && m.role !== 'OWNER' ? <ActButton small action="tenant.transfer_owner" payload={{ workspaceId: id, userId: m.id }} reason="Written reason + confirmation from the current owner (ticket #)">🔐 Make owner</ActButton> : null}
        </span>,
      ])} />
      <Section title="Invites">
        <Table head={['Email', 'Role', 'Status', '']} rows={d0.invites.map((i) => [
          i.email as string,
          String(i.role).toLowerCase(),
          i.accepted_at ? 'accepted' : i.revoked_at ? 'revoked' : new Date(i.expires_at as string) < new Date() ? 'expired' : `pending · expires ${d(i.expires_at)}`,
          !i.accepted_at && !i.revoked_at ? <ActButton key="r" small action="tenant.invite_revoke" payload={{ workspaceId: id, inviteId: i.id }}>Revoke</ActButton> : null,
        ])} />
      </Section>
    </>
  );
}

async function Skus({ id, staff, hasBg, canBg, canWrite }: { id: string; staff: Awaited<ReturnType<typeof requireStaff>>; hasBg: boolean; canBg: boolean; canWrite: boolean }) {
  const meta = await withAdmin((tx) => tx`select s.id, s.catalogue_no, s.status, s.maturity, s.created_at,
      (select count(*) from product_facts f where f.sku_id = s.id and f.status <> 'SUPERSEDED')::int as facts,
      (select string_agg(status || ':' || n, ' ') from (select status, count(*) as n from claims c where c.sku_id = s.id group by status) x) as claims,
      (select count(*) from assets a where a.sku_id = s.id)::int as assets, (select count(*) from experiments e where e.sku_id = s.id)::int as experiments
    from skus s where s.workspace_id = ${id} order by s.catalogue_no`);
  let content: Record<string, unknown>[] | null = null;
  if (hasBg) {
    content = await withAdmin(async (tx) => {
      await assertBreakGlass(tx, staff, id, 'view SKU names and claims');
      return (await tx`select s.id, s.name, s.source_url, (select json_agg(json_build_object('w', preferred_wording, 's', status)) from claims c where c.sku_id = s.id) as claims from skus s where s.workspace_id = ${id} order by s.catalogue_no`) as unknown as Record<string, unknown>[];
    });
  }
  return (
    <>
      <Table head={['No.', 'Status', 'Maturity', 'Facts', 'Claims by status', 'Assets', 'Experiments', 'Created']} rows={meta.map((m) => [String(m.catalogue_no).padStart(3, '0'), m.status as string, String(m.maturity).toLowerCase(), m.facts as number, <Mono key="c">{(m.claims as string) ?? '—'}</Mono>, m.assets as number, m.experiments as number, d(m.created_at)])} />
      <Section title="Content (break-glass)">
        {content ? (
          <Table head={['SKU', 'Name', 'Source', 'Claims']} rows={content.map((c) => [<Mono key="i">{String(c.id).slice(0, 8)}</Mono>, c.name as string, (c.source_url as string) ?? '—', ((c.claims as { w: string; s: string }[]) ?? []).map((x) => `“${x.w}” (${x.s})`).join('; ') || '—'])} />
        ) : canBg ? (
          <div className="ak-panel" style={{ maxWidth: 560 }}>
            <p className="ak-small">Tenant content requires break-glass. Access lasts 60 minutes, is read-only by default, and is shown to the customer in their access log.</p>
            <ActForm action="tenant.breakglass" extra={{ workspaceId: id }} submit="Start break-glass" fields={[
              { name: 'reason', label: 'Reason', type: 'textarea', required: true, placeholder: 'e.g. Ticket #812 — customer reports wrong product color in storyboard' },
              { name: 'ticket', label: 'Ticket / incident #' },
              ...(canWrite ? [{ name: 'write', label: 'Write access (act on behalf) 🔐', type: 'checkbox' as const }, { name: 'writeReason', label: 'Second reason (required for write)' }] : []),
            ]} />
          </div>
        ) : <p className="ak-small ak-muted">Your role can’t access tenant content.</p>}
      </Section>
    </>
  );
}

async function Projects({ id, canRetry }: { id: string; canRetry: boolean }) {
  const d0 = await withAdmin(async (tx) => ({
    projects: await tx`select p.id, p.kind, p.state, p.failure_reason, p.updated_at, p.created_at, (select count(*) from provider_jobs j where j.project_id = p.id)::int as jobs,
                              (select coalesce(sum(actual_micros), 0) from provider_jobs j where j.project_id = p.id)::bigint as cost
                       from projects p where p.workspace_id = ${id} order by p.created_at desc limit 50`,
    jobs: await tx`select id, provider, task, model, status, error, latency_ms, actual_micros, created_at, project_id from provider_jobs where workspace_id = ${id} order by created_at desc limit 50`,
  }));
  const stuckAfter: Record<string, number> = { RENDERING: 20, QA_RUNNING: 10, COMPOSING: 10, RENDER_RESERVED: 10, STORYBOARD_APPROVED: 10 };
  return (
    <>
      <Table head={['Project', 'Kind', 'State', 'Updated', 'Provider jobs', 'Cost', '']} rows={d0.projects.map((p) => {
        const stuck = stuckAfter[p.state as string] && Date.now() - new Date(p.updated_at as string).getTime() > stuckAfter[p.state as string]! * 60_000;
        return [<Mono key="i">{String(p.id).slice(0, 8)}</Mono>, p.kind as string, <span key="s" style={{ color: stuck ? 'var(--risk)' : undefined }}>{String(p.state).toLowerCase()}{stuck ? ' (stuck)' : ''}{p.failure_reason ? ` — ${p.failure_reason}` : ''}</span>, ago(p.updated_at), p.jobs as number, money(p.cost), canRetry && ['PROVIDER_FAILED'].includes(p.state as string) ? <ActButton key="r" small action="job.retry" payload={{ queue: 'produce-project', jobId: p.id, workspaceId: id }} reason="Retry reason (no new spend unless re-authorised)">Retry</ActButton> : null];
      })} />
      <Section title="Provider jobs">
        <Table head={['When', 'Provider', 'Task', 'Model', 'Status', 'Latency', 'Cost', 'Error']} rows={d0.jobs.map((j) => [dt(j.created_at), j.provider as string, j.task as string, <Mono key="m">{j.model as string}</Mono>, j.status as string, j.latency_ms ? `${j.latency_ms}ms` : '—', money(j.actual_micros ?? 0, 4), <span key="e" className="ak-small">{(j.error as string)?.slice(0, 120) ?? ''}</span>])} />
      </Section>
    </>
  );
}

async function Ledger({ id, canAdjust }: { id: string; canAdjust: boolean }) {
  const rows = await withAdmin((tx) => tx`select id, type, unit, amount, period_key, reason, actor, created_at,
      sum(case when type in ('CREDIT_GRANTED','CREDIT_RESERVED','CREDIT_RELEASED','CREDIT_REFUNDED','CREDIT_EXPIRED','CREDIT_ADJUSTED') then amount else 0 end)
        over (partition by unit order by id) as running
    from ledger_entries where workspace_id = ${id} order by id desc limit 300`);
  return (
    <div className="ak-grid-2" style={{ alignItems: 'start', gridTemplateColumns: '2fr 1fr' }}>
      <Table head={['#', 'When', 'Type', 'Unit', 'Amount', 'Balance', 'Reason', 'Actor']} rows={rows.map((r) => [r.id as number, dt(r.created_at), <Mono key="t">{r.type as string}</Mono>, r.unit as string, <Mono key="a">{r.unit === 'usd_micros' ? money(r.amount, 4) : String(r.amount)}</Mono>, r.unit === 'usd_micros' ? '—' : String(r.running), <span key="r" className="ak-small">{(r.reason as string) ?? ''}</span>, <Mono key="ac">{String(r.actor).split(':')[0]}</Mono>])} empty="No ledger entries." />
      {canAdjust ? (
        <div className="ak-panel">
          <p className="ak-label">🔐 Ledger adjustment</p>
          <p className="ak-small ak-muted">Never edits history — writes a CREDIT_ADJUSTED row. More than 5 Creative Tests (or 1 of other units) needs a second FINANCE approver.</p>
          <ActForm action="tenant.ledger_adjust" extra={{ workspaceId: id }} submit="Adjust" fields={[
            { name: 'unit', label: 'Unit', type: 'select', options: ['creative_test', 'taste', 'standalone'] },
            { name: 'amount', label: 'Amount (+ grant / − revoke)', type: 'number', required: true },
            { name: 'reason', label: 'Reason', type: 'textarea', required: true },
          ]} />
        </div>
      ) : null}
    </div>
  );
}

async function Billing({ id, canRefund }: { id: string; canRefund: boolean }) {
  const d0 = await withAdmin(async (tx) => ({
    cust: (await tx`select customer_id from stripe_customers where workspace_id = ${id}`)[0],
    subs: await tx`select * from subscriptions where workspace_id = ${id} order by created_at desc`,
    purchases: await tx`select * from purchases where workspace_id = ${id} order by created_at desc limit 50`,
    events: await tx`select id, type, status, received_at, error from stripe_events where workspace_id = ${id} or payload->'data'->'object'->>'customer' = (select customer_id from stripe_customers where workspace_id = ${id}) order by received_at desc limit 50`,
    consents: await tx`select kind, text_version, text_snapshot, created_at, ip from consent_records where workspace_id = ${id} order by created_at desc limit 10`,
  }));
  return (
    <>
      <p className="ak-small">Stripe customer: <Mono>{(d0.cust?.customer_id as string) ?? '—'}</Mono> {d0.cust ? <ActButton small action="billing.portal" payload={{ workspaceId: id }}>Open in Stripe</ActButton> : null}</p>
      <Section title="Subscriptions">
        <Table head={['Plan', 'Status', 'Period', 'Cancel at end', 'Pending', 'Stripe id']} rows={d0.subs.map((s) => [s.plan_code as string, s.status as string, `${d(s.current_period_start)} → ${d(s.current_period_end)}`, s.cancel_at_period_end ? 'yes' : 'no', (s.pending_plan_code as string) ?? '—', <Mono key="i">{s.stripe_subscription_id as string}</Mono>])} />
      </Section>
      <Section title="One-time purchases">
        <Table head={['When', 'Kind', 'Amount', 'Status', 'Payment', '']} rows={d0.purchases.map((p) => [dt(p.created_at), p.kind as string, money(p.amount_micros), p.status as string, <Mono key="pi">{(p.stripe_payment_intent_id as string) ?? '—'}</Mono>, canRefund && p.status === 'paid' ? (
          <ActForm key="r" inline action="billing.refund" extra={{ workspaceId: id, purchaseId: p.id }} submit="🔐 Refund" fields={[{ name: 'amount', label: 'Amount $', type: 'number', defaultValue: Number(p.amount_micros) / 1e6, required: true }, { name: 'reason', label: 'Reason code + note', required: true }]} />
        ) : null])} />
      </Section>
      <Section title="Auto-renew consent records">
        <Table head={['When', 'Version', 'Text shown', 'IP']} rows={d0.consents.map((c) => [dt(c.created_at), <Mono key="v">{c.text_version as string}</Mono>, <span key="t" className="ak-small">{c.text_snapshot as string}</span>, <Mono key="ip">{String(c.ip ?? '')}</Mono>])} />
      </Section>
      <Section title="Stripe events">
        <Table head={['Received', 'Type', 'Status', 'Id']} rows={d0.events.map((e) => [dt(e.received_at), e.type as string, e.status as string, <Mono key="i">{e.id as string}</Mono>])} />
      </Section>
    </>
  );
}

async function Integrations({ id, canManage }: { id: string; canManage: boolean }) {
  const rows = await withAdmin((tx) => tx`select id, provider, external_account_id, display_name, status, scopes, last_success_at, last_complete_date, cursor, error, token_expires_at from integrations where workspace_id = ${id} order by provider`);
  return (
    <Table head={['Provider', 'Account', 'Status', 'Scopes', 'Last success', 'Complete to', 'Token expiry', 'Last error', '']} rows={rows.map((r) => [
      r.provider as string, <Mono key="a">{r.external_account_id as string}</Mono>, r.status as string, (r.scopes as string[]).join(','), ago(r.last_success_at), d(r.last_complete_date), d(r.token_expires_at),
      <span key="e" className="ak-small">{(r.error as { message?: string } | null)?.message ?? ''}</span>,
      canManage && r.status !== 'disconnected' ? <span key="x" className="ak-row"><ActButton small action="tenant.integration_sync" payload={{ workspaceId: id, integrationId: r.id }}>Re-sync</ActButton><ActButton small action="tenant.integration_status" payload={{ workspaceId: id, integrationId: r.id, status: r.status === 'paused' ? 'active' : 'paused' }} reason>{r.status === 'paused' ? 'Resume' : 'Pause'}</ActButton></span> : null,
    ])} />
  );
}

async function Emails({ id }: { id: string }) {
  const rows = await withAdmin((tx) => tx`select l.to_email, l.template, l.stream, l.status, l.created_at, (select reason from email_suppressions s where s.email = l.to_email) as suppressed
    from email_log l where l.workspace_id = ${id} or l.to_email in (select u.email from memberships m join users u on u.id = m.user_id where m.workspace_id = ${id}) order by l.created_at desc limit 100`);
  return <Table head={['When', 'To', 'Template', 'Stream', 'Status', '']} rows={rows.map((r) => [dt(r.created_at), r.to_email as string, r.template as string, r.stream as string, r.status as string, r.suppressed ? <ActButton key="u" small action="email.unsuppress" payload={{ email: r.to_email }} reason>Unsuppress ({r.suppressed as string})</ActButton> : null])} />;
}

async function Risk({ id }: { id: string }) {
  const d0 = await withAdmin(async (tx) => ({
    flags: await tx`select * from risk_flags where workspace_id = ${id} order by raised_at desc`,
    abuse: await tx`select kind, key, detail, at from abuse_signals where workspace_id = ${id} order by at desc limit 50`,
    disputes: await tx`select type, received_at from stripe_events where workspace_id = ${id} and type like 'charge.dispute%' order by received_at desc`,
  }));
  return (
    <>
      <Table head={['Indicator', 'Evidence', 'Raised', 'Status', '']} rows={d0.flags.map((f) => [f.indicator as string, <Mono key="e">{JSON.stringify(f.evidence).slice(0, 140)}</Mono>, dt(f.raised_at), f.resolved_at ? (f.suppressed_reason ? `suppressed: ${f.suppressed_reason}` : 'resolved') : 'open', !f.resolved_at ? <ActButton key="s" small action="tenant.risk_suppress" payload={{ workspaceId: id, flagId: f.id }} reason>Suppress</ActButton> : null])} empty="No churn-risk indicators." />
      <Section title="Abuse signals"><Table head={['When', 'Kind', 'Key', 'Detail']} rows={d0.abuse.map((a) => [dt(a.at), a.kind as string, <Mono key="k">{a.key as string}</Mono>, <Mono key="d">{JSON.stringify(a.detail).slice(0, 120)}</Mono>])} /></Section>
      <Section title="Disputes"><Table head={['When', 'Event']} rows={d0.disputes.map((x) => [dt(x.received_at), x.type as string])} /></Section>
    </>
  );
}

async function Access({ id }: { id: string }) {
  const rows = await withAdmin((tx) => tx`select staff_name, reason, ticket, write_access, started_at, expires_at, ended_at from break_glass_sessions where workspace_id = ${id} order by started_at desc`);
  return <Table head={['Started', 'Staff', 'Reason', 'Ticket', 'Access', 'Ended']} rows={rows.map((r) => [dt(r.started_at), r.staff_name as string, r.reason as string, (r.ticket as string) ?? '—', r.write_access ? 'write' : 'read', r.ended_at ? dt(r.ended_at) : new Date(r.expires_at as string) > new Date() ? 'active' : `expired ${dt(r.expires_at)}`])} empty="No staff access." />;
}

function Danger({ id, w, canState, canPurge }: { id: string; w: Record<string, unknown>; canState: boolean; canPurge: boolean }) {
  const held = w.state === 'SUSPENDED' || w.state === 'LOCKED';
  return (
    <div className="ak-stack" style={{ maxWidth: 640 }}>
      {canState ? (
        <div className="ak-panel ak-row" style={{ flexWrap: 'wrap' }}>
          {held ? (
            <ActButton action="tenant.hold" payload={{ workspaceId: id, hold: 'LIFT' }} reason confirm={`Restore to ${String(w.state_before_hold).toLowerCase()}?`}>🔐 Lift {String(w.state).toLowerCase()}</ActButton>
          ) : (
            <>
              <ActButton danger action="tenant.hold" payload={{ workspaceId: id, hold: 'SUSPENDED' }} reason confirm="Suspend? In-flight jobs finish but aren't delivered until lifted.">🔐 Suspend</ActButton>
              <ActButton danger action="tenant.hold" payload={{ workspaceId: id, hold: 'LOCKED' }} reason confirm="Lock? Members lose access immediately.">🔐 Lock</ActButton>
            </>
          )}
          <ActButton action="tenant.export" payload={{ workspaceId: id }} reason="Legal request reference">🔐 Export workspace data</ActButton>
        </div>
      ) : null}
      {canPurge ? (
        <div className="ak-panel ak-row" style={{ flexWrap: 'wrap' }}>
          {w.state === 'PURGE_SCHEDULED' ? (
            <>
              <span className="ak-small">Purge scheduled {dt(w.purge_at)}</span>
              <ActButton action="tenant.cancel_purge" payload={{ workspaceId: id }} reason>Cancel purge</ActButton>
            </>
          ) : (
            <ActButton danger action="tenant.schedule_purge" payload={{ workspaceId: id }} reason confirm="Schedule purge in 7 days?">🔐 Schedule purge (7 days)</ActButton>
          )}
          <ActButton danger action="tenant.purge_now" payload={{ workspaceId: id }} reason confirm="Purge before the scheduled date? Needs a second approver.">🔐 Purge now (four-eyes)</ActButton>
        </div>
      ) : null}
    </div>
  );
}
