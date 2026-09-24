import Link from 'next/link';
import { notFound } from 'next/navigation';
import { withAdmin } from '@arkiv/db';
import { activeBreakGlass, assertBreakGlass, audit, BREAK_GLASS_REASON_KINDS, BREAK_GLASS_REASON_LABEL, CANCELLABLE_BEFORE_DISPATCH, RISK_PLAYBOOKS, shouldMaskPii, staffCan, tenantHealth, type BreakGlassReasonKind } from '@arkiv/core';
import { newId, PLANS, RefundReason, type PlanCode, type RiskIndicator } from '@arkiv/shared';
import { ActButton, ActForm, type F } from '@/components/act';
import { ago, d, dt, money, Mono, Page, Section, Table, Tabs, tm } from '@/components/ui';
import { estimateProjectRetry } from '@/lib/estimates';
import { emailKey } from '@/lib/email-key';
import { piiView, type PiiView } from '@/lib/mask';
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
export default async function Tenant({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string; project?: string }> }) {
  const s = await requireStaff('tenant.read');
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const sp = await searchParams;
  const tab = sp.tab ?? 'overview';
  const focusProject = sp.project && /^[0-9a-f-]{36}$/i.test(sp.project) ? sp.project : null;
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
  // SUPPORT reads tenants with PII masked unless a break-glass session is open (plan 05 §0.2).
  const pii = piiView(shouldMaskPii(s.roles, !!bg));

  return (
    <Page
      title={w.name as string}
      sub={<><Mono>{w.slug as string} · {id}</Mono> · {String(w.state).toLowerCase()} · {(w.plan_code as string)?.toLowerCase() ?? 'no plan'} · created {d(w.created_at)}{w.is_vip ? ' · ★ VIP' : ''}{w.is_test ? ' · test account' : ''}</>}
      actions={
        bg ? (
          <span className="ak-row"><span className="ak-chip ak-chip--warn">Break-glass {bg.write ? 'write' : 'read'} until {tm(bg.expiresAt)}</span><ActButton small action="tenant.breakglass_end" payload={{ workspaceId: id }}>End</ActButton></span>
        ) : null
      }
    >
      <Tabs label="Tenant sections" base={base} tabs={TABS} current={tab} />
      {tab === 'overview' ? <Overview id={id} w={w} canFlag={staffCan(s.roles, 'tenant.flags')} /> : null}
      {pii.mask ? <p className="ak-small ak-muted">Emails, IP addresses and devices are masked for your role. Start break-glass to see them (the customer is told).</p> : null}
      {tab === 'members' ? <Members id={id} canManage={staffCan(s.roles, 'tenant.state')} pii={pii} /> : null}
      {tab === 'skus' ? <Skus id={id} staff={s} bg={bg} canBg={staffCan(s.roles, 'breakglass.read')} canWrite={staffCan(s.roles, 'breakglass.write')} /> : null}
      {tab === 'projects' ? <Projects id={id} canManage={staffCan(s.roles, 'jobs.manage')} focus={focusProject} /> : null}
      {tab === 'ledger' ? <Ledger id={id} canAdjust={staffCan(s.roles, 'ledger.adjust')} /> : null}
      {tab === 'billing' ? <Billing id={id} canRefund={staffCan(s.roles, 'billing.refund')} pii={pii} /> : null}
      {tab === 'integrations' ? <Integrations id={id} canManage={staffCan(s.roles, 'integrations.manage')} /> : null}
      {tab === 'emails' ? <Emails id={id} pii={pii} canUnsuppress={staffCan(s.roles, 'email.manage')} /> : null}
      {tab === 'risk' ? <Risk id={id} canSuppress={staffCan(s.roles, 'tenant.flags')} /> : null}
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
    notes: await tx`select n.body, n.sentiment, n.created_at, s.name from tenant_notes n left join staff_users s on s.id = n.staff_id where n.workspace_id = ${id} order by n.created_at desc`,
    health: await tenantHealth(tx, id),
  }));
  const { health, quotas, risk } = d0.health;
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
        <Section title="Health" right={<span className={`ak-chip ${health.band === 'healthy' ? 'ak-chip--ok' : health.band === 'watch' ? 'ak-chip--warn' : 'ak-chip--risk'}`}>{health.score}/100 · {health.band}</span>}>
          <p className="ak-small" style={{ marginTop: 0 }}>{health.factors.length ? health.factors.map((f) => `${f.label} (${f.points})`).join(' · ') : 'No negative signals.'} · churn-risk band: {risk.band}</p>
          <Table head={['Quota', 'Used', 'Limit', '']} rows={quotas.map((q) => {
            const over = q.limit > 0 && q.used > q.limit;
            return [q.label, String(q.used), q.limit ? String(q.limit) : '—', over ? <span key="o" className="ak-chip ak-chip--risk">over limit</span> : q.limit && q.used / q.limit >= 0.8 ? <span key="n" className="ak-chip ak-chip--warn">near limit</span> : ''];
          })} />
        </Section>
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
          <ActForm action="tenant.note" extra={{ workspaceId: id }} submit="Add note" fields={[
            { name: 'body', label: 'Note (staff only)', type: 'textarea', required: true },
            { name: 'sentiment', label: 'Customer sentiment (support conversations)', type: 'select', options: [{ value: '', label: '—' }, { value: 'positive', label: 'positive' }, { value: 'neutral', label: 'neutral' }, { value: 'negative', label: 'negative (raises a churn-risk flag)' }] },
          ]} />
          {d0.notes.map((n, i) => <div key={i} className="ak-index-row"><span>{n.body as string}</span><span className="ak-index">{n.sentiment ? `${n.sentiment as string} · ` : ''}{(n.name as string) ?? 'staff'} · {ago(n.created_at)}</span></div>)}
        </div>
      </div>
    </div>
  );
}

async function Members({ id, canManage, pii }: { id: string; canManage: boolean; pii: PiiView }) {
  const d0 = await withAdmin(async (tx) => ({
    members: await tx`select u.id, u.email, u.name, m.role, u.locked_at, (select max(last_seen_at) from sessions where user_id = u.id) as last_seen,
                             (select count(*) from passkeys where user_id = u.id)::int as passkeys, (select string_agg(provider, ',') from user_identities where user_id = u.id) as idents
                      from memberships m join users u on u.id = m.user_id where m.workspace_id = ${id} order by m.created_at`,
    invites: await tx`select id, email, role, expires_at, revoked_at, accepted_at from invites where workspace_id = ${id} order by created_at desc limit 20`,
  }));
  return (
    <>
      <Table head={['Member', 'Role', 'Sign-in', 'Last seen', '']} rows={d0.members.map((m) => [
        <Link key="u" href={`/users/${m.id}`}>{pii.email(m.email)}{m.locked_at ? ' (locked)' : ''}</Link>,
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
          pii.email(i.email),
          String(i.role).toLowerCase(),
          i.accepted_at ? 'accepted' : i.revoked_at ? 'revoked' : new Date(i.expires_at as string) < new Date() ? 'expired' : `pending · expires ${d(i.expires_at)}`,
          !i.accepted_at && !i.revoked_at ? <ActButton key="r" small action="tenant.invite_revoke" payload={{ workspaceId: id, inviteId: i.id }}>Revoke</ActButton> : null,
        ])} />
      </Section>
    </>
  );
}

async function Skus({ id, staff, bg, canBg, canWrite }: { id: string; staff: Awaited<ReturnType<typeof requireStaff>>; bg: { write: boolean } | null; canBg: boolean; canWrite: boolean }) {
  const meta = await withAdmin((tx) => tx`select s.id, s.catalogue_no, s.status, s.maturity, s.created_at,
      (select count(*) from product_facts f where f.sku_id = s.id and f.status <> 'SUPERSEDED')::int as facts,
      (select string_agg(status || ':' || n, ' ') from (select status, count(*) as n from claims c where c.sku_id = s.id group by status) x) as claims,
      (select count(*) from assets a where a.sku_id = s.id)::int as assets, (select count(*) from experiments e where e.sku_id = s.id)::int as experiments
    from skus s where s.workspace_id = ${id} order by s.catalogue_no`);
  let content: { skus: Record<string, unknown>[]; scenes: Record<string, unknown>[] } | null = null;
  if (bg) {
    content = await withAdmin(async (tx) => {
      await assertBreakGlass(tx, staff, id, 'view SKU names, claims and storyboard lines');
      return {
        skus: (await tx`select s.id, s.catalogue_no, s.name, s.source_url, (select json_agg(json_build_object('w', preferred_wording, 's', status)) from claims c where c.sku_id = s.id) as claims from skus s where s.workspace_id = ${id} order by s.catalogue_no`) as unknown as Record<string, unknown>[],
        // The latest editable storyboard per SKU (approved storyboards are locked for production).
        scenes: (await tx`select sc.id, sc.position, sc.spoken_line, sc.overlay_text, sc.locked, s.catalogue_no from scenes sc
                          join storyboards sb on sb.id = sc.storyboard_id and sb.workspace_id = sc.workspace_id
                          join projects p on p.id = sb.project_id and p.workspace_id = sb.workspace_id join skus s on s.id = p.sku_id
                          where sc.workspace_id = ${id} and sb.status = 'ready'
                            and sb.created_at = (select max(created_at) from storyboards x where x.project_id = sb.project_id and x.workspace_id = ${id})
                          order by s.catalogue_no, sc.position limit 60`) as unknown as Record<string, unknown>[],
      };
    });
  }
  const no = (n: unknown) => String(n).padStart(3, '0');
  return (
    <>
      <Table head={['No.', 'Status', 'Maturity', 'Facts', 'Claims by status', 'Assets', 'Experiments', 'Created']} rows={meta.map((m) => [no(m.catalogue_no), m.status as string, String(m.maturity).toLowerCase(), m.facts as number, <Mono key="c">{(m.claims as string) ?? '—'}</Mono>, m.assets as number, m.experiments as number, d(m.created_at)])} />
      <Section title="Content (break-glass)">
        {content ? (
          <>
            <Table head={['SKU', 'Name', 'Source', 'Claims']} rows={content.skus.map((c) => [<Mono key="i">{no(c.catalogue_no)}</Mono>, c.name as string, (c.source_url as string) ?? '—', ((c.claims as { w: string; s: string }[]) ?? []).map((x) => `“${x.w}” (${x.s})`).join('; ') || '—'])} />
            {bg?.write ? (
              <>
                <h3 className="ak-label">Act on behalf · every change is recorded as Arkiv support in the customer’s history</h3>
                <div className="ak-panel" style={{ maxWidth: 640 }}>
                  <p className="ak-small" style={{ marginTop: 0 }}>Correct a product fact (a new decided value; earlier values are kept).</p>
                  <ActForm action="tenant.fact_decide" extra={{ workspaceId: id }} submit="🔐 Save fact" fields={[
                    { name: 'skuId', label: 'SKU', type: 'select', options: content.skus.map((c) => ({ value: c.id as string, label: `${no(c.catalogue_no)} · ${c.name as string}` })) },
                    { name: 'key', label: 'Fact key', required: true, placeholder: 'e.g. size_ml, name, texture' },
                    { name: 'value', label: 'Value', required: true },
                    { name: 'reason', label: 'Reason (ticket #, what the customer asked)', required: true },
                  ]} />
                </div>
                <Table head={['SKU', 'Scene', 'Spoken line', 'Overlay', 'Edit']} rows={content.scenes.map((c) => [no(c.catalogue_no), c.position as number, (c.spoken_line as string) ?? '—', (c.overlay_text as string) ?? '—', c.locked ? 'locked by the customer' : (
                  <ActForm key="e" inline action="tenant.scene_edit" extra={{ workspaceId: id, sceneId: c.id }} submit="🔐 Save" fields={[
                    { name: 'spokenLine', label: 'Spoken line', defaultValue: (c.spoken_line as string) ?? '' },
                    { name: 'overlayText', label: 'Overlay', defaultValue: (c.overlay_text as string) ?? '' },
                    { name: 'reason', label: 'Reason', required: true },
                  ]} />
                )])} empty="No storyboard awaiting approval." />
              </>
            ) : null}
          </>
        ) : canBg ? (
          <div className="ak-panel" style={{ maxWidth: 560 }}>
            <p className="ak-small">Tenant content requires break-glass. Access lasts 60 minutes, is read-only by default, and is shown to the customer in their access log.</p>
            <ActForm action="tenant.breakglass" extra={{ workspaceId: id }} submit="Start break-glass" fields={[
              { name: 'reasonKind', label: 'Why', type: 'select', options: BREAK_GLASS_REASON_KINDS.map((k) => ({ value: k, label: BREAK_GLASS_REASON_LABEL[k] })) },
              { name: 'ticket', label: 'Ticket / incident # (required for those)' },
              { name: 'reason', label: 'What you need to look at, and why', type: 'textarea', required: true, placeholder: 'e.g. Customer reports the wrong product colour in their storyboard' },
              ...(canWrite ? [{ name: 'write', label: 'Write access (act on behalf) 🔐', type: 'checkbox' as const }, { name: 'writeReason', label: 'Second reason (required for write)' }] : []),
            ]} />
          </div>
        ) : <p className="ak-small ak-muted">Your role can’t access tenant content.</p>}
      </Section>
    </>
  );
}

/** Production states in which a project is waiting on us, with the minutes after which it counts as stuck. */
const STUCK_AFTER_MIN: Record<string, number> = { RENDERING: 20, QA_RUNNING: 10, COMPOSING: 10, PLATFORM_VARIANTS: 10, FINAL_QA: 10, RENDER_RESERVED: 10, STORYBOARD_APPROVED: 10 };
const RETRYABLE = ['PROVIDER_FAILED', 'NEEDS_USER_ACTION'];

async function Projects({ id, canManage, focus }: { id: string; canManage: boolean; focus: string | null }) {
  const d0 = await withAdmin(async (tx) => ({
    projects: await tx`select p.id, p.kind, p.state, p.failure_reason, p.updated_at, p.created_at, p.experiment_id, s.catalogue_no,
                              (select count(*) from provider_jobs j where j.workspace_id = p.workspace_id and j.project_id = p.id)::int as jobs,
                              (select coalesce(sum(actual_micros), 0) from provider_jobs j where j.workspace_id = p.workspace_id and j.project_id = p.id)::bigint as cost,
                              (select status from cost_authorizations a where a.workspace_id = p.workspace_id and a.project_id = p.id order by a.created_at desc limit 1) as reservation
                       from projects p join skus s on s.id = p.sku_id where p.workspace_id = ${id} order by p.created_at desc limit 50`,
    experiments: await tx`select e.id, e.state, e.mode, e.portfolio_slot, e.primary_variable, e.created_at, e.updated_at, s.catalogue_no,
                                 (select count(*) from variants v where v.workspace_id = e.workspace_id and v.experiment_id = e.id)::int as variants,
                                 (select count(*) from projects p where p.workspace_id = e.workspace_id and p.experiment_id = e.id)::int as projects
                          from experiments e join skus s on s.id = e.sku_id where e.workspace_id = ${id} order by e.created_at desc limit 50`,
    jobs: await tx`select id, provider, task, model, arm, status, error, latency_ms, actual_micros, created_at, project_id from provider_jobs where workspace_id = ${id} order by created_at desc limit 50`,
    held: await tx`select queue, reason, held_at, released_at, payload->>'template' as template from held_jobs where workspace_id = ${id} order by held_at desc limit 50`,
  }));
  const retryEstimates = new Map<string, number | null>();
  if (canManage) for (const p of d0.projects.filter((x) => RETRYABLE.includes(x.state as string))) retryEstimates.set(p.id as string, await estimateProjectRetry(id, p.id as string));
  const shown = focus && d0.projects.some((p) => p.id === focus) ? focus : null;
  return (
    <>
      <Table head={['Project', 'SKU', 'Kind', 'State', 'Updated', 'Reservation', 'Provider jobs', 'Cost', '']} rows={d0.projects.map((p) => {
        const limit = STUCK_AFTER_MIN[p.state as string];
        const stuck = limit !== undefined && Date.now() - new Date(p.updated_at as string).getTime() > limit * 60_000;
        const est = retryEstimates.get(p.id as string);
        return [
          <Link key="i" href={`/tenants/${id}?tab=projects&project=${p.id}`}><Mono>{String(p.id).slice(0, 8)}</Mono></Link>,
          String(p.catalogue_no).padStart(3, '0'),
          p.kind as string,
          <span key="s" style={{ color: stuck ? 'var(--risk)' : undefined }}>{String(p.state).toLowerCase()}{stuck ? ' (stuck)' : ''}{p.failure_reason ? ` — ${p.failure_reason}` : ''}</span>,
          ago(p.updated_at),
          (p.reservation as string) ?? '—',
          p.jobs as number,
          money(p.cost),
          canManage ? (
            <span key="a" className="ak-row">
              {RETRYABLE.includes(p.state as string) ? (
                <ActButton small action="tenant.project_retry" payload={{ workspaceId: id, projectId: p.id }} confirm={`Retry this production? A fresh Cost Governor authorisation re-reserves the customer’s entitlement${est != null ? ` (estimate ${money(est)} at current rates)` : ''}; the customer is not charged again.`} reason="Retry reason (ticket / incident)">
                  Retry{est != null ? ` (est. ${money(est)})` : ''}
                </ActButton>
              ) : stuck && p.state !== 'STORYBOARD_APPROVED' ? (
                <ActButton small action="tenant.project_retry" payload={{ workspaceId: id, projectId: p.id }} confirm="Resume this stalled production? It continues from where it stopped under the reservation it already holds; nothing is reserved or charged again." reason="Resume reason (ticket / incident)">
                  Resume
                </ActButton>
              ) : null}
              {(CANCELLABLE_BEFORE_DISPATCH as readonly string[]).includes(p.state as string) ? (
                <ActButton small danger action="tenant.project_cancel" payload={{ workspaceId: id, projectId: p.id }} confirm="Cancel before dispatch? The project ends cancelled and any reservation returns to the customer’s balance." reason="Cancel reason">
                  Cancel
                </ActButton>
              ) : null}
            </span>
          ) : null,
        ];
      })} />
      {shown ? <Timeline id={id} projectId={shown} /> : <p className="ak-small ak-muted" style={{ marginTop: 8 }}>Open a project to see its job timeline.</p>}
      <Section title="Experiments">
        <Table head={['Experiment', 'SKU', 'State', 'Mode', 'Slot', 'Variable', 'Variants', 'Projects', 'Updated']} rows={d0.experiments.map((e) => [<Mono key="i">{String(e.id).slice(0, 8)}</Mono>, String(e.catalogue_no).padStart(3, '0'), String(e.state).toLowerCase(), String(e.mode).toLowerCase(), (e.portfolio_slot as string)?.toLowerCase() ?? '—', <Mono key="v">{e.primary_variable as string}</Mono>, e.variants as number, e.projects as number, ago(e.updated_at)])} empty="No experiments." />
      </Section>
      <Section title="Provider jobs">
        <Table head={['When', 'Provider', 'Task', 'Model', 'Arm', 'Status', 'Latency', 'Cost', 'Error']} rows={d0.jobs.map((j) => [dt(j.created_at), j.provider as string, j.task as string, <Mono key="m">{j.model as string}</Mono>, (j.arm as string) ?? '—', j.status as string, j.latency_ms ? `${j.latency_ms}ms` : '—', money(j.actual_micros ?? 0, 4), <span key="e" className="ak-small">{(j.error as string)?.slice(0, 120) ?? ''}</span>])} />
      </Section>
      <Section title="Jobs held while the workspace was on hold">
        <Table head={['Held', 'Queue', 'Reason', 'Released']} rows={d0.held.map((h) => [dt(h.held_at), <Mono key="q">{`${h.queue as string}${h.template ? ` · ${h.template}` : ''}`}</Mono>, h.reason as string, h.released_at ? dt(h.released_at) : 'waiting'])} empty="Nothing held." />
      </Section>
    </>
  );
}

/** Job timeline for one project: state changes and QA events, provider calls, and ledger rows, in order. */
async function Timeline({ id, projectId }: { id: string; projectId: string }) {
  const rows = await withAdmin((tx) => tx`
    select * from (
      select e.at, 'event' as source, e.type as what, e.actor as who,
             coalesce(e.payload->>'to', e.payload->>'attempt', '') as detail
      from events e
      where e.workspace_id = ${id} and (e.subject_id = ${projectId} or e.subject_id in (
        select sc.id from scenes sc join projects p on p.storyboard_id = sc.storyboard_id and p.workspace_id = sc.workspace_id
        where p.id = ${projectId} and p.workspace_id = ${id}))
      union all
      select j.created_at, 'provider', j.task || ' · ' || j.provider || '/' || j.model || coalesce(' · ' || j.arm, ''), j.status,
             concat_ws(' · ', case when j.latency_ms is not null then j.latency_ms || 'ms' end, case when j.actual_micros is not null then '$' || round(j.actual_micros / 1e6, 4) end, left(j.error, 120))
      from provider_jobs j where j.workspace_id = ${id} and j.project_id = ${projectId}
      union all
      select l.created_at, 'ledger', l.type || ' ' || l.amount || ' ' || l.unit, l.actor, coalesce(left(l.reason, 120), '')
      from ledger_entries l where l.workspace_id = ${id} and l.project_id = ${projectId}
    ) t order by at limit 400`);
  return (
    <Section title={`Job timeline · ${projectId.slice(0, 8)}`} right={<Link className="ak-small" href={`/tenants/${id}?tab=projects`}>Close</Link>}>
      <Table head={['When', 'Source', 'What', 'Actor / status', 'Detail']} rows={rows.map((r) => [dt(r.at), r.source as string, <Mono key="w">{r.what as string}</Mono>, <Mono key="a">{String(r.who).split(':')[0]}</Mono>, <span key="d" className="ak-small">{(r.detail as string) ?? ''}</span>])} empty="No activity recorded." />
    </Section>
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

async function Billing({ id, canRefund, pii }: { id: string; canRefund: boolean; pii: PiiView }) {
  const d0 = await withAdmin(async (tx) => ({
    cust: (await tx`select customer_id from stripe_customers where workspace_id = ${id}`)[0],
    subs: await tx`select * from subscriptions where workspace_id = ${id} order by created_at desc`,
    purchases: await tx`select * from purchases where workspace_id = ${id} order by created_at desc limit 50`,
    events: await tx`select id, type, status, received_at, error from stripe_events where workspace_id = ${id} or payload->'data'->'object'->>'customer' = (select customer_id from stripe_customers where workspace_id = ${id}) order by received_at desc limit 50`,
    consents: await tx`select kind, text_version, text_snapshot, created_at, ip from consent_records where workspace_id = ${id} order by created_at desc limit 10`,
    invoices: await tx`select e.id, e.received_at, (e.payload->'data'->'object'->>'amount_paid')::bigint as cents,
                              coalesce(e.payload->'data'->'object'->>'payment_intent', e.payload->'data'->'object'->'payments'->'data'->0->'payment'->>'payment_intent') as pi
                       from stripe_events e where e.workspace_id = ${id} and e.type = 'invoice.paid' order by e.received_at desc limit 24`,
    refunds: await tx`select r.*, a.name as approver from refunds r left join staff_users a on a.id = r.approved_by where r.workspace_id = ${id} order by r.created_at desc limit 50`,
  }));
  const refundedByPi = new Map<string, number>();
  for (const r of d0.refunds) if (r.status === 'succeeded') refundedByPi.set(r.payment_intent_id as string, (refundedByPi.get(r.payment_intent_id as string) ?? 0) + Number(r.amount_micros));
  const refundFields = (maxMicros: number): F[] => [
    { name: 'amount', label: 'Amount $', type: 'number', defaultValue: maxMicros / 1e6, required: true },
    { name: 'reasonCode', label: 'Reason code', type: 'select', options: [...RefundReason] },
    { name: 'customerNote', label: 'Note to the customer (emailed)', type: 'textarea' },
    { name: 'reason', label: 'Internal reason (audit)', required: true },
  ];
  return (
    <>
      <p className="ak-small">Stripe customer: <Mono>{(d0.cust?.customer_id as string) ?? '—'}</Mono> {d0.cust ? <ActButton small action="billing.portal" payload={{ workspaceId: id }}>Open in Stripe</ActButton> : null}</p>
      <p className="ak-small ak-muted">Refunds over $200 need a second FINANCE approver. Each refund writes CREDIT_REFUNDED; a full refund of an unused credit withdraws it.</p>
      <Section title="Subscriptions">
        <Table head={['Plan', 'Status', 'Period', 'Cancel at end', 'Pending', 'Stripe id']} rows={d0.subs.map((s) => [s.plan_code as string, s.status as string, `${d(s.current_period_start)} → ${d(s.current_period_end)}`, s.cancel_at_period_end ? 'yes' : 'no', (s.pending_plan_code as string) ?? '—', <Mono key="i">{s.stripe_subscription_id as string}</Mono>])} />
      </Section>
      <Section title="Subscription payments">
        <Table head={['Paid', 'Invoice event', 'Amount', 'Refunded', '']} rows={d0.invoices.map((v) => {
          const paid = Number(v.cents ?? 0) * 10_000;
          const left = paid - (refundedByPi.get(v.pi as string) ?? 0);
          return [dt(v.received_at), <Mono key="e">{v.id as string}</Mono>, money(paid), money(paid - left), canRefund && v.pi && left > 0 ? <ActForm key="r" inline action="billing.refund" extra={{ workspaceId: id, invoiceEventId: v.id, requestId: newId() }} submit="🔐 Refund" fields={refundFields(left)} /> : null];
        })} empty="No subscription payments on record." />
      </Section>
      <Section title="One-time purchases">
        <Table head={['When', 'Kind', 'Amount', 'Refunded', 'Status', 'Payment', '']} rows={d0.purchases.map((p) => {
          const left = Number(p.amount_micros) - Number(p.refunded_micros ?? 0);
          return [dt(p.created_at), p.kind as string, money(p.amount_micros), money(p.refunded_micros ?? 0), p.status as string, <Mono key="pi">{(p.stripe_payment_intent_id as string) ?? '—'}</Mono>, canRefund && ['paid', 'refunded'].includes(p.status as string) && left > 0 && p.stripe_payment_intent_id ? (
            <ActForm key="r" inline action="billing.refund" extra={{ workspaceId: id, purchaseId: p.id, requestId: newId() }} submit="🔐 Refund" fields={refundFields(left)} />
          ) : null];
        })} />
      </Section>
      <Section title="Refunds">
        <Table head={['When', 'Amount', 'Reason code', 'Customer note', 'Status', 'Stripe refund', 'Approved by']} rows={d0.refunds.map((r) => [dt(r.created_at), money(r.amount_micros), r.reason_code as string, <span key="n" className="ak-small">{(r.customer_note as string) ?? ''}</span>, `${r.status as string}${r.error ? ` — ${String(r.error).slice(0, 80)}` : ''}`, <Mono key="s">{(r.stripe_refund_id as string) ?? '—'}</Mono>, (r.approver as string) ?? 'Stripe'])} empty="No refunds." />
      </Section>
      <Section title="Auto-renew consent records">
        <Table head={['When', 'Version', 'Text shown', 'IP']} rows={d0.consents.map((c) => [dt(c.created_at), <Mono key="v">{c.text_version as string}</Mono>, <span key="t" className="ak-small">{c.text_snapshot as string}</span>, <Mono key="ip">{pii.ip(c.ip)}</Mono>])} />
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

async function Emails({ id, pii, canUnsuppress }: { id: string; pii: PiiView; canUnsuppress: boolean }) {
  const rows = await withAdmin((tx) => tx`select l.to_email, l.template, l.stream, l.status, l.created_at, (select reason from email_suppressions s where s.email = l.to_email) as suppressed
    from email_log l where l.workspace_id = ${id} or l.to_email in (select u.email from memberships m join users u on u.id = m.user_id where m.workspace_id = ${id}) order by l.created_at desc limit 100`);
  // The unsuppress button carries a hash of the address, never the address itself (masked views stay masked).
  return <Table head={['When', 'To', 'Template', 'Stream', 'Status', '']} rows={rows.map((r) => [dt(r.created_at), pii.email(r.to_email), r.template as string, r.stream as string, r.status as string, r.suppressed && canUnsuppress ? <ActButton key="u" small action="email.unsuppress" payload={{ emailKey: emailKey(r.to_email as string) }} reason>Unsuppress ({r.suppressed as string})</ActButton> : r.suppressed ? `suppressed (${r.suppressed as string})` : null])} />;
}

async function Risk({ id, canSuppress }: { id: string; canSuppress: boolean }) {
  const d0 = await withAdmin(async (tx) => ({
    flags: await tx`select * from risk_flags where workspace_id = ${id} order by raised_at desc`,
    abuse: await tx`select kind, key, detail, at from abuse_signals where workspace_id = ${id} order by at desc limit 50`,
    disputes: await tx`select type, received_at from stripe_events where workspace_id = ${id} and type like 'charge.dispute%' order by received_at desc`,
  }));
  const status = (f: Record<string, unknown>) => {
    if (f.suppressed_reason) {
      const until = f.suppressed_until ? new Date(f.suppressed_until as string) : null;
      return until && until > new Date() ? `suppressed until ${d(until)}: ${f.suppressed_reason}` : `suppression ended${until ? ` ${d(until)}` : ''}: ${f.suppressed_reason}`;
    }
    return f.resolved_at ? `resolved ${d(f.resolved_at)}` : 'open';
  };
  return (
    <>
      <Table head={['Indicator', 'Evidence', 'Raised', 'Status', 'Playbook', '']} rows={d0.flags.map((f) => [
        RISK_PLAYBOOKS[f.indicator as RiskIndicator]?.label ?? (f.indicator as string),
        <Mono key="e">{JSON.stringify(f.evidence).slice(0, 140)}</Mono>,
        dt(f.raised_at),
        status(f),
        <span key="p" className="ak-small">{RISK_PLAYBOOKS[f.indicator as RiskIndicator]?.intervention ?? '—'}</span>,
        canSuppress && !f.resolved_at ? <ActForm key="s" inline action="tenant.risk_suppress" extra={{ workspaceId: id, flagId: f.id }} submit="Suppress" fields={[{ name: 'days', label: 'Days', type: 'number', defaultValue: 30, required: true }, { name: 'reason', label: 'Reason', required: true }]} /> : null,
      ])} empty="No churn-risk indicators." />
      <Section title="Abuse signals"><Table head={['When', 'Kind', 'Key', 'Detail']} rows={d0.abuse.map((a) => [dt(a.at), a.kind as string, <Mono key="k">{a.key as string}</Mono>, <Mono key="d">{JSON.stringify(a.detail).slice(0, 120)}</Mono>])} /></Section>
      <Section title="Disputes"><Table head={['When', 'Event']} rows={d0.disputes.map((x) => [dt(x.received_at), x.type as string])} /></Section>
    </>
  );
}

async function Access({ id }: { id: string }) {
  const rows = await withAdmin((tx) => tx`select staff_name, reason_kind, reason, ticket, write_access, started_at, expires_at, ended_at from break_glass_sessions where workspace_id = ${id} order by started_at desc`);
  return <Table head={['Started', 'Staff', 'Why', 'Reference', 'Reason', 'Access', 'Ended']} rows={rows.map((r) => [dt(r.started_at), r.staff_name as string, r.reason_kind ? BREAK_GLASS_REASON_LABEL[r.reason_kind as BreakGlassReasonKind] : '—', (r.ticket as string) ?? '—', r.reason as string, r.write_access ? 'write (act on behalf)' : 'read', r.ended_at ? dt(r.ended_at) : new Date(r.expires_at as string) > new Date() ? 'active' : `expired ${dt(r.expires_at)}`])} empty="No staff access." />;
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
              <ActButton danger action="tenant.hold" payload={{ workspaceId: id, hold: 'SUSPENDED' }} reason confirm="Suspend? Queued jobs pause; in-flight jobs finish and are stored but not delivered until lifted.">🔐 Suspend</ActButton>
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
              <ActButton action="tenant.cancel_purge" payload={{ workspaceId: id }} reason confirm={`Cancel the purge and restore the workspace to ${String(w.state_before_purge ?? 'CANCELLED').toLowerCase()}?`}>Cancel purge</ActButton>
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
