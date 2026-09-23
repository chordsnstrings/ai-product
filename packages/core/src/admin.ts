import { withAdmin, type Tx } from '@arkiv/db';
import { DomainError, newId, type ProjectState, type StaffRole, type WorkspaceState } from '@arkiv/shared';
import type { TenantContext } from './context';
import { settle } from './cost-governor';
import { adjust, type LedgerUnit } from './ledger';
import { restoreFromScheduledPurge } from './lifecycle';
import { Queues } from './outbox';
import { retryProduction } from './production';
import { transition } from './projects';
import { retireSupersededRates } from './rates';
import { setting } from './settings';
import { transitionWorkspace } from './workspaces';

/**
 * Admin domain (plan 05): permissions by staff role, append-only audit, break-glass for tenant content,
 * four-eyes approvals with an executor registry, and tenant-level staff actions. The admin app is a thin
 * shell over these functions so the rules are testable without a browser.
 */

export interface Staff {
  staffId: string;
  email: string;
  name: string;
  roles: StaffRole[];
  ip?: string | null;
  userAgent?: string | null;
}

// ───────────── Permissions (plan 05 §0.2) ─────────────

const P = {
  'pulse.read': ['SUPER_ADMIN', 'OPS', 'SUPPORT', 'FINANCE', 'COMPLIANCE', 'GROWTH', 'ENGINEERING', 'ANALYST'],
  'analytics.read': ['SUPER_ADMIN', 'OPS', 'FINANCE', 'GROWTH', 'ANALYST', 'ENGINEERING'],
  'tenant.read': ['SUPER_ADMIN', 'OPS', 'SUPPORT', 'FINANCE', 'COMPLIANCE'],
  'tenant.note': ['SUPER_ADMIN', 'OPS', 'SUPPORT', 'FINANCE', 'COMPLIANCE'],
  'tenant.flags': ['SUPER_ADMIN', 'OPS', 'SUPPORT'],
  'tenant.state': ['SUPER_ADMIN', 'OPS'],
  'tenant.purge': ['SUPER_ADMIN', 'OPS'],
  'breakglass.read': ['SUPER_ADMIN', 'OPS', 'SUPPORT', 'COMPLIANCE'],
  'breakglass.write': ['SUPER_ADMIN', 'OPS'],
  'users.read': ['SUPER_ADMIN', 'OPS', 'SUPPORT'],
  'users.lock': ['SUPER_ADMIN', 'OPS'],
  'billing.read': ['SUPER_ADMIN', 'FINANCE'],
  'billing.refund': ['SUPER_ADMIN', 'FINANCE'],
  'billing.unmatched': ['SUPER_ADMIN', 'FINANCE'],
  'ledger.read': ['SUPER_ADMIN', 'FINANCE', 'OPS'],
  'ledger.adjust': ['SUPER_ADMIN', 'FINANCE'],
  'rates.propose': ['SUPER_ADMIN', 'FINANCE', 'OPS'],
  'rates.publish': ['SUPER_ADMIN', 'FINANCE'],
  'providers.read': ['SUPER_ADMIN', 'ENGINEERING', 'OPS'],
  'providers.circuit': ['SUPER_ADMIN', 'ENGINEERING', 'OPS'],
  'routes.manage': ['SUPER_ADMIN', 'ENGINEERING'],
  'evals.run': ['SUPER_ADMIN', 'ENGINEERING'],
  'jobs.read': ['SUPER_ADMIN', 'OPS', 'SUPPORT', 'ENGINEERING'],
  // SUPPORT may only re-run failed jobs that make no provider spend (§0.2). Cancelling, dead-letter redrive
  // and any retry that can spend stay with OPS.
  'jobs.retry_nospend': ['SUPER_ADMIN', 'OPS', 'SUPPORT'],
  'jobs.manage': ['SUPER_ADMIN', 'OPS'],
  'qa.review': ['SUPER_ADMIN', 'OPS', 'COMPLIANCE'],
  'claims.review': ['SUPER_ADMIN', 'COMPLIANCE'],
  'abuse.manage': ['SUPER_ADMIN', 'COMPLIANCE', 'OPS'],
  'integrations.read': ['SUPER_ADMIN', 'OPS', 'SUPPORT'],
  'integrations.manage': ['SUPER_ADMIN', 'OPS'],
  'retention.read': ['SUPER_ADMIN', 'OPS', 'SUPPORT'],
  'growth.manage': ['SUPER_ADMIN', 'GROWTH'],
  'offers.manage': ['SUPER_ADMIN', 'GROWTH', 'FINANCE'],
  'email.read': ['SUPER_ADMIN', 'GROWTH', 'ENGINEERING', 'SUPPORT'],
  'email.manage': ['SUPER_ADMIN', 'GROWTH', 'SUPPORT'],
  'taxonomy.manage': ['SUPER_ADMIN', 'ENGINEERING', 'COMPLIANCE'],
  'flags.manage': ['SUPER_ADMIN', 'ENGINEERING'],
  'killswitch': ['SUPER_ADMIN', 'ENGINEERING', 'OPS'],
  'privacy.manage': ['SUPER_ADMIN', 'COMPLIANCE'],
  'system.read': ['SUPER_ADMIN', 'ENGINEERING', 'OPS'],
  'system.banner': ['SUPER_ADMIN', 'ENGINEERING', 'OPS'],
  'audit.read': ['SUPER_ADMIN'],
  'staff.manage': ['SUPER_ADMIN'],
  'approvals.read': ['SUPER_ADMIN', 'OPS', 'SUPPORT', 'FINANCE', 'COMPLIANCE', 'GROWTH', 'ENGINEERING'],
} as const satisfies Record<string, readonly StaffRole[]>;
export type Permission = keyof typeof P;
export const PERMISSIONS = P;

export const staffCan = (roles: readonly StaffRole[], perm: Permission) => roles.some((r) => (P[perm] as readonly string[]).includes(r));
export function assertStaff(s: Pick<Staff, 'roles'>, perm: Permission) {
  if (!staffCan(s.roles, perm)) throw new DomainError('FORBIDDEN', 'Your role doesn’t allow this.', { permission: perm });
}

// ───────────── Audit (plan 05 §0.4) ─────────────

export async function audit(
  tx: Tx,
  s: Staff,
  action: string,
  target: { type: string; id: string | null },
  extra: { workspaceId?: string | null; reason?: string | null; before?: unknown; after?: unknown } = {},
) {
  await tx`insert into admin_audit_log (staff_id, staff_roles, action, target_type, target_id, workspace_id, reason, before, after, ip, user_agent)
           values (${s.staffId}, ${s.roles}, ${action}, ${target.type}, ${target.id}, ${extra.workspaceId ?? null}, ${extra.reason ?? null},
                   ${extra.before === undefined ? null : tx.json(extra.before as never)}, ${extra.after === undefined ? null : tx.json(extra.after as never)},
                   ${s.ip ?? null}, ${s.userAgent ?? null})`;
}

/** Staff actor context for domain functions that emit tenant events. */
export const staffCtx = (s: Staff, workspaceId: string) => ({ workspaceId, actor: { kind: 'staff' as const, id: s.staffId } });

// ───────────── Break-glass (plan 05 §0.3) ─────────────

export const BREAK_GLASS_MINUTES = 60;

export async function startBreakGlass(s: Staff, workspaceId: string, input: { reason: string; ticket?: string | null; write?: boolean; writeReason?: string | null }) {
  assertStaff(s, input.write ? 'breakglass.write' : 'breakglass.read');
  if (input.reason.trim().length < 8) throw new DomainError('INVALID', 'Describe why you need access (at least a sentence).');
  if (input.write && (input.writeReason ?? '').trim().length < 8) throw new DomainError('INVALID', 'Write access needs a second, specific reason.');
  return withAdmin(async (tx) => {
    const [w] = await tx`select id from workspaces where id = ${workspaceId}`;
    if (!w) throw new DomainError('NOT_FOUND', 'Workspace not found');
    await tx`update break_glass_sessions set ended_at = now() where workspace_id = ${workspaceId} and staff_id = ${s.staffId} and ended_at is null`;
    const reason = input.write ? `${input.reason} — write: ${input.writeReason}` : input.reason;
    const [bg] = await tx`insert into break_glass_sessions (workspace_id, staff_id, staff_name, reason, ticket, write_access, expires_at)
                          values (${workspaceId}, ${s.staffId}, ${s.name}, ${reason}, ${input.ticket ?? null}, ${!!input.write},
                                  now() + make_interval(mins => ${BREAK_GLASS_MINUTES})) returning id, expires_at`;
    await audit(tx, s, input.write ? 'breakglass.start_write' : 'breakglass.start', { type: 'workspace', id: workspaceId }, { workspaceId, reason });
    return { id: bg!.id as string, expiresAt: bg!.expires_at as string };
  });
}

export async function endBreakGlass(s: Staff, workspaceId: string) {
  await withAdmin(async (tx) => {
    await tx`update break_glass_sessions set ended_at = now() where workspace_id = ${workspaceId} and staff_id = ${s.staffId} and ended_at is null`;
    await audit(tx, s, 'breakglass.end', { type: 'workspace', id: workspaceId }, { workspaceId });
  });
}

export async function activeBreakGlass(tx: Tx, s: Pick<Staff, 'staffId'>, workspaceId: string) {
  const [bg] = await tx`select id, write_access, expires_at from break_glass_sessions
                        where workspace_id = ${workspaceId} and staff_id = ${s.staffId} and ended_at is null and expires_at > now()
                        order by started_at desc limit 1`;
  return bg ? { id: bg.id as string, write: bg.write_access as boolean, expiresAt: bg.expires_at as string } : null;
}

/** Gate for reading/acting on tenant content. Every content view is audited with the break-glass id. */
export async function assertBreakGlass(tx: Tx, s: Staff, workspaceId: string, what: string, write = false) {
  const bg = await activeBreakGlass(tx, s, workspaceId);
  if (!bg) throw new DomainError('FORBIDDEN', 'Tenant content needs break-glass access.', { breakGlass: true });
  if (write && !bg.write) throw new DomainError('FORBIDDEN', 'This needs write access (act on behalf).', { breakGlass: true, write: true });
  await audit(tx, s, write ? 'content.write' : 'content.view', { type: 'workspace', id: workspaceId }, { workspaceId, reason: `${what} (break-glass ${bg.id})` });
  return bg;
}

// ───────────── Four-eyes approvals (plan 05 §0.5) ─────────────

export type ApprovalAction =
  | 'ledger.adjust'
  | 'billing.refund'
  | 'rates.publish'
  | 'route.promote'
  | 'workspace.purge_now'
  | 'staff.roles'
  | 'claim.unblock'
  | 'stripe.assign';

type Executor = (payload: Record<string, unknown>, ctx: { requester: Staff; approver: Staff }) => Promise<unknown>;
const executors = new Map<ApprovalAction, Executor>();
/** Actions that live in other packages (e.g. Stripe refunds) register their executor at app start. */
export function registerExecutor(action: ApprovalAction, fn: Executor) {
  executors.set(action, fn);
}

/** Thresholds where a single staff member may act alone. Above them, a second person approves. */
export function needsApproval(action: ApprovalAction, payload: Record<string, unknown>): boolean {
  switch (action) {
    case 'ledger.adjust':
      return payload.unit === 'creative_test' ? Math.abs(Number(payload.amount)) > 5 : Math.abs(Number(payload.amount)) > 1;
    case 'billing.refund':
      return Number(payload.amountMicros) > 200_000_000;
    case 'route.promote':
      return Number(payload.rolloutPct) >= 100;
    default:
      return true; // rates.publish, early purge, staff roles, claim unblock, stripe assignment: always
  }
}

const APPROVER_ROLE: Record<ApprovalAction, StaffRole> = {
  'ledger.adjust': 'FINANCE',
  'billing.refund': 'FINANCE',
  'rates.publish': 'FINANCE',
  'route.promote': 'ENGINEERING',
  'workspace.purge_now': 'OPS',
  'staff.roles': 'SUPER_ADMIN',
  'claim.unblock': 'COMPLIANCE',
  'stripe.assign': 'FINANCE',
};

/** Run now if under threshold, otherwise file an approval request. */
export async function requestOrExecute(s: Staff, action: ApprovalAction, payload: Record<string, unknown>, reason: string) {
  if (reason.trim().length < 4) throw new DomainError('INVALID', 'A reason is required.');
  if (!needsApproval(action, payload)) {
    const exec = executors.get(action);
    if (!exec) throw new DomainError('UNAVAILABLE', `No executor for ${action}`);
    const result = await exec({ ...payload, reason }, { requester: s, approver: s });
    await withAdmin((tx) => audit(tx, s, `${action}.executed`, { type: 'approval', id: null }, { workspaceId: (payload.workspaceId as string) ?? null, reason, after: { payload, result } }));
    return { status: 'executed' as const, result };
  }
  const id = await withAdmin(async (tx) => {
    const [a] = await tx`insert into approvals (action, payload, required_role, requested_by, reason)
                         values (${action}, ${tx.json(payload as never)}, ${APPROVER_ROLE[action]}, ${s.staffId}, ${reason}) returning id`;
    await audit(tx, s, `${action}.requested`, { type: 'approval', id: a!.id as string }, { workspaceId: (payload.workspaceId as string) ?? null, reason, after: payload });
    return a!.id as string;
  });
  return { status: 'pending' as const, approvalId: id };
}

/**
 * Decide an approval. The requester can never approve their own request (a lone SUPER_ADMIN included);
 * the approver must hold the required role, or be SUPER_ADMIN.
 */
export async function decideApproval(s: Staff, approvalId: string, approve: boolean, note?: string) {
  const a = await withAdmin(async (tx) => {
    const [row] = await tx`select * from approvals where id = ${approvalId} for update`;
    if (!row) throw new DomainError('NOT_FOUND', 'Approval not found');
    if (row.status !== 'pending') throw new DomainError('CONFLICT', `Already ${row.status}`);
    if (row.requested_by === s.staffId) throw new DomainError('FORBIDDEN', 'You can’t approve your own request.');
    if (!s.roles.includes(row.required_role as StaffRole) && !s.roles.includes('SUPER_ADMIN'))
      throw new DomainError('FORBIDDEN', `Needs ${row.required_role} or SUPER_ADMIN to approve.`);
    await tx`update approvals set status = ${approve ? 'approved' : 'rejected'}, decided_by = ${s.staffId}, decided_at = now() where id = ${approvalId}`;
    await audit(tx, s, `approval.${approve ? 'approved' : 'rejected'}`, { type: 'approval', id: approvalId }, { reason: note ?? null, after: { action: row.action } });
    const [req] = await tx`select id, email, name, roles from staff_users where id = ${row.requested_by}`;
    return { row, requester: { staffId: req!.id as string, email: req!.email as string, name: req!.name as string, roles: req!.roles as StaffRole[] } };
  });
  if (!approve) return { status: 'rejected' as const };
  const exec = executors.get(a.row.action as ApprovalAction);
  try {
    if (!exec) throw new Error(`No executor for ${a.row.action}`);
    const result = await exec({ ...(a.row.payload as Record<string, unknown>), reason: a.row.reason }, { requester: a.requester, approver: s });
    await withAdmin((tx) => tx`update approvals set status = 'executed', result = ${tx.json((result ?? {}) as never)} where id = ${approvalId}`);
    return { status: 'executed' as const, result };
  } catch (e) {
    await withAdmin((tx) => tx`update approvals set status = 'failed', result = ${tx.json({ error: (e as Error).message })} where id = ${approvalId}`);
    throw e;
  }
}

// ───────────── Built-in executors ─────────────

registerExecutor('ledger.adjust', async (p, { requester, approver }) =>
  withAdmin(async (tx) => {
    const ws = p.workspaceId as string;
    const entry = await adjust(tx, staffCtx(requester, ws), p.unit as LedgerUnit, Number(p.amount), `${p.reason as string} (by ${requester.email}${approver.staffId !== requester.staffId ? `, approved by ${approver.email}` : ''})`, `admin-adjust:${p.nonce as string}`);
    await audit(tx, approver, 'ledger.adjusted', { type: 'workspace', id: ws }, { workspaceId: ws, reason: p.reason as string, after: { unit: p.unit, amount: p.amount } });
    return entry;
  }),
);

registerExecutor('rates.publish', async (p, { approver }) =>
  withAdmin(async (tx) => {
    const [r] = await tx`select * from provider_rate_tables where id = ${p.rateTableId as string} for update`;
    if (!r || r.status !== 'draft') throw new DomainError('CONFLICT', 'Only drafts can be published');
    // The current version stays published until the new one takes effect (plan 05 §9 "effective at a time"):
    // the Cost Governor always prices with the latest published version in effect, and superseded versions are
    // retired once their successor is live (here for immediate publishes, and by the hourly sweep).
    const [pub] = await tx`update provider_rate_tables set status = 'published', approved_by = ${approver.staffId}, effective_from = greatest(effective_from, now())
                           where id = ${r.id} returning effective_from`;
    const retired = await retireSupersededRates(tx);
    await audit(tx, approver, 'rates.published', { type: 'rate_table', id: r.id as string }, { after: { provider: r.provider, model: r.model, version: r.version, effectiveFrom: pub!.effective_from, retired } });
    return { provider: r.provider, model: r.model, version: r.version, effectiveFrom: pub!.effective_from };
  }),
);

registerExecutor('route.promote', async (p, { approver }) =>
  withAdmin(async (tx) => {
    const [before] = await tx`select * from model_routes where task = ${p.task as string}`;
    if (!before) throw new DomainError('NOT_FOUND', 'Route not found');
    // Promotion to 100% makes the candidate the stable route; the canary arm ends.
    await tx`update model_routes set rollout_pct = ${Number(p.rolloutPct)},
               model = coalesce(${(p.model as string) ?? null}, model), prompt_version = coalesce(${(p.promptVersion as string) ?? null}, prompt_version),
               canary = null, updated_at = now() where task = ${p.task as string}`;
    await audit(tx, approver, 'route.promoted', { type: 'route', id: p.task as string }, { before, after: p });
    return { task: p.task, rolloutPct: p.rolloutPct };
  }),
);

registerExecutor('workspace.purge_now', async (p, { approver }) =>
  withAdmin(async (tx) => {
    const ws = p.workspaceId as string;
    const [w] = await tx`select state from workspaces where id = ${ws}`;
    if (w?.state !== 'PURGE_SCHEDULED') await transitionWorkspace(tx, staffCtx(approver, ws), 'PURGE_SCHEDULED', `staff early purge: ${p.reason as string}`);
    await tx`update workspaces set purge_at = now() where id = ${ws}`;
    await audit(tx, approver, 'workspace.purge_now', { type: 'workspace', id: ws }, { workspaceId: ws, reason: p.reason as string });
    return { purgeAt: 'now (next sweep)' };
  }),
);

registerExecutor('staff.roles', async (p, { approver }) =>
  withAdmin(async (tx) => {
    const [before] = await tx`select roles from staff_users where id = ${p.staffId as string}`;
    await tx`update staff_users set roles = ${p.roles as string[]}, roles_confirmed_at = now() where id = ${p.staffId as string}`;
    await tx`update staff_sessions set revoked_at = now() where staff_id = ${p.staffId as string} and revoked_at is null`; // rotate on privilege change
    await audit(tx, approver, 'staff.roles_changed', { type: 'staff', id: p.staffId as string }, { before, after: { roles: p.roles } });
    return { roles: p.roles };
  }),
);

registerExecutor('claim.unblock', async (p, { approver }) =>
  withAdmin(async (tx) => {
    const ws = p.workspaceId as string;
    const [c] = await tx`update claims set status = 'MERCHANT_REVIEW_REQUIRED', block_reason = null, reviewed_at = now()
                         where id = ${p.claimId as string} and workspace_id = ${ws} and status = 'BLOCKED' returning id`;
    if (!c) throw new DomainError('CONFLICT', 'Claim is not blocked');
    await tx`insert into events (workspace_id, type, actor, subject_type, subject_id, payload)
             values (${ws}, 'CLAIM_RESTRICTED', ${`staff:${approver.staffId}`}, 'claim', ${p.claimId as string}, ${tx.json({ unblocked: true, reason: String(p.reason ?? "") })})`;
    await audit(tx, approver, 'claim.unblocked', { type: 'claim', id: p.claimId as string }, { workspaceId: ws, reason: p.reason as string });
    return { claimId: p.claimId };
  }),
);

// ───────────── Tenant actions (plan 05 §2.2) ─────────────

export async function setTenantHold(s: Staff, workspaceId: string, hold: 'SUSPENDED' | 'LOCKED' | 'LIFT', reason: string) {
  assertStaff(s, 'tenant.state');
  if (reason.trim().length < 4) throw new DomainError('INVALID', 'A reason is required.');
  return withAdmin(async (tx) => {
    const [w] = await tx`select state, state_before_hold from workspaces where id = ${workspaceId} for update`;
    if (!w) throw new DomainError('NOT_FOUND', 'Workspace not found');
    let to: WorkspaceState;
    if (hold === 'LIFT') {
      if (w.state !== 'SUSPENDED' && w.state !== 'LOCKED') throw new DomainError('CONFLICT', 'Workspace is not on hold');
      to = w.state_before_hold as WorkspaceState;
    } else to = hold;
    await transitionWorkspace(tx, staffCtx(s, workspaceId), to, `staff: ${reason}`);
    await audit(tx, s, `tenant.${hold.toLowerCase()}`, { type: 'workspace', id: workspaceId }, { workspaceId, reason, before: { state: w.state }, after: { state: to } });
    return to;
  });
}

export async function setTenantFlags(s: Staff, workspaceId: string, patch: { isVip?: boolean; isTest?: boolean; tags?: string[] }) {
  assertStaff(s, 'tenant.flags');
  return withAdmin(async (tx) => {
    const [before] = await tx`select is_vip, is_test, tags from workspaces where id = ${workspaceId} for update`;
    if (!before) throw new DomainError('NOT_FOUND', 'Workspace not found');
    await tx`update workspaces set is_vip = ${patch.isVip ?? before.is_vip}, is_test = ${patch.isTest ?? before.is_test},
               tags = ${patch.tags ?? (before.tags as string[])} where id = ${workspaceId}`;
    await audit(tx, s, 'tenant.flags', { type: 'workspace', id: workspaceId }, { workspaceId, before, after: patch });
  });
}

export type NoteSentiment = 'positive' | 'neutral' | 'negative';

/** Staff notes; a sentiment marks the support conversation it records (feeds the §17 support-sentiment indicator). */
export async function addTenantNote(s: Staff, workspaceId: string, body: string, sentiment: NoteSentiment | null = null) {
  assertStaff(s, 'tenant.note');
  if (!body.trim()) throw new DomainError('INVALID', 'Note is empty');
  await withAdmin(async (tx) => {
    await tx`insert into tenant_notes (workspace_id, staff_id, body, sentiment) values (${workspaceId}, ${s.staffId}, ${body.trim().slice(0, 4000)}, ${sentiment})`;
    await audit(tx, s, 'tenant.note', { type: 'workspace', id: workspaceId }, { workspaceId, after: sentiment ? { sentiment } : undefined });
  });
}

/** Danger zone: schedule a purge after the grace period. The prior state is kept so a cancel can restore it. */
export async function scheduleTenantPurge(s: Staff, workspaceId: string, reason: string) {
  assertStaff(s, 'tenant.purge');
  if (reason.trim().length < 4) throw new DomainError('INVALID', 'A reason is required.');
  return withAdmin(async (tx) => {
    const [w] = await tx`select state from workspaces where id = ${workspaceId} for update`;
    if (!w) throw new DomainError('NOT_FOUND', 'Workspace not found');
    await transitionWorkspace(tx, staffCtx(s, workspaceId), 'PURGE_SCHEDULED', `staff: ${reason}`);
    await tx`update workspaces set purge_at = now() + make_interval(days => ${await setting(tx, 'retention.purge_grace_days')}) where id = ${workspaceId}`;
    await audit(tx, s, 'tenant.schedule_purge', { type: 'workspace', id: workspaceId }, { workspaceId, reason, before: { state: w.state }, after: { state: 'PURGE_SCHEDULED' } });
  });
}

/**
 * Danger zone: cancel a scheduled purge. The workspace returns to the state it had when the purge was
 * scheduled (a paying tenant stays paying while its subscription is live); shares restoreFromScheduledPurge
 * with the Owner's own cancel.
 */
export async function cancelTenantPurge(s: Staff, workspaceId: string, reason: string): Promise<WorkspaceState> {
  assertStaff(s, 'tenant.purge');
  if (reason.trim().length < 4) throw new DomainError('INVALID', 'A reason is required.');
  return withAdmin(async (tx) => {
    const [w] = await tx`select state from workspaces where id = ${workspaceId} for update`;
    if (!w) throw new DomainError('NOT_FOUND', 'Workspace not found');
    if (w.state !== 'PURGE_SCHEDULED') throw new DomainError('CONFLICT', 'No purge is scheduled for this workspace.');
    const to = await restoreFromScheduledPurge(tx, staffCtx(s, workspaceId), `staff cancelled purge: ${reason}`);
    await audit(tx, s, 'tenant.cancel_purge', { type: 'workspace', id: workspaceId }, { workspaceId, reason, before: { state: 'PURGE_SCHEDULED' }, after: { state: to } });
    return to;
  });
}

/** Risk tab: suppress a churn indicator for a while; the daily recomputation won't re-raise it until then. */
export async function suppressRiskFlag(s: Staff, workspaceId: string, flagId: string, reason: string, days = 30) {
  assertStaff(s, 'tenant.flags');
  if (reason.trim().length < 4) throw new DomainError('INVALID', 'A reason is required.');
  if (!Number.isInteger(days) || days < 1 || days > 180) throw new DomainError('INVALID', 'Suppress for 1–180 days.');
  return withAdmin(async (tx) => {
    const [f] = await tx`update risk_flags set suppressed_reason = ${reason}, suppressed_until = now() + make_interval(days => ${days}), resolved_at = coalesce(resolved_at, now())
                         where id = ${flagId} and workspace_id = ${workspaceId} returning indicator, suppressed_until`;
    if (!f) throw new DomainError('NOT_FOUND', 'Risk flag not found');
    await audit(tx, s, 'risk.suppress', { type: 'risk_flag', id: flagId }, { workspaceId, reason, after: { indicator: f.indicator, suppressedUntil: f.suppressed_until } });
    return { indicator: f.indicator as string, suppressedUntil: f.suppressed_until as string };
  });
}

// ───────────── Experiments & jobs tab (plan 05 §2.2, §12) ─────────────

/** Production states that have not yet dispatched a billable provider call (§39 cancel semantics). */
export const CANCELLABLE_BEFORE_DISPATCH: readonly ProjectState[] = ['STORYBOARD_APPROVED', 'RENDER_RESERVED'];

async function staffTenantCtx(tx: Tx, s: Staff, workspaceId: string): Promise<TenantContext> {
  const [w] = await tx`select state, plan_code from workspaces where id = ${workspaceId}`;
  if (!w) throw new DomainError('NOT_FOUND', 'Workspace not found');
  return { workspaceId, workspaceState: w.state as WorkspaceState, role: 'OWNER', actor: { kind: 'staff', id: s.staffId }, requestId: newId(), planCode: (w.plan_code as string) ?? null };
}

/**
 * Retry a failed production step. The failed attempt returned its entitlement, so the retry re-reserves it
 * through a fresh Cost Governor authorization (re-estimated at current rates): no charge beyond what the
 * customer already bought, but it can spend provider money, so it needs jobs.manage.
 */
export async function retryProjectProduction(s: Staff, workspaceId: string, projectId: string, reason: string) {
  assertStaff(s, 'jobs.manage');
  if (reason.trim().length < 4) throw new DomainError('INVALID', 'A reason is required.');
  return withAdmin(async (tx) => {
    const ctx = await staffTenantCtx(tx, s, workspaceId);
    if (ctx.workspaceState === 'SUSPENDED') throw new DomainError('CONFLICT', 'Workspace is suspended; retries are blocked.');
    const [p] = await tx`select state from projects where id = ${projectId} and workspace_id = ${workspaceId}`;
    if (!p) throw new DomainError('NOT_FOUND', 'Project not found');
    // A failed run re-reserves through the Cost Governor; a stalled one (worker lost mid-run) resumes from its
    // durable state under the reservation it already holds.
    const r = await retryProduction(tx, ctx, projectId);
    await audit(tx, s, 'project.retry', { type: 'project', id: projectId }, { workspaceId, reason, before: { state: p.state }, after: r.resumed ? { state: p.state, resumed: true } : { state: 'STORYBOARD_APPROVED' } });
    return { message: r.resumed ? 'Resume queued: the run continues from where it stopped, with no new reservation.' : 'Retry queued. The worker re-authorises cost before any provider call.' };
  });
}

/**
 * Cancel a production before anything was dispatched to a provider: the project ends CANCELLED and an
 * active reservation is released back to the customer's balance. Once a provider call exists the job must
 * finish and settle on its own (§39: cancel semantics depend on dispatch state).
 */
export async function cancelProjectBeforeDispatch(s: Staff, workspaceId: string, projectId: string, reason: string) {
  assertStaff(s, 'jobs.manage');
  if (reason.trim().length < 4) throw new DomainError('INVALID', 'A reason is required.');
  return withAdmin(async (tx) => {
    const ctx = await staffTenantCtx(tx, s, workspaceId);
    const [p] = await tx`select state from projects where id = ${projectId} and workspace_id = ${workspaceId} for update`;
    if (!p) throw new DomainError('NOT_FOUND', 'Project not found');
    if (!CANCELLABLE_BEFORE_DISPATCH.includes(p.state as ProjectState))
      throw new DomainError('CONFLICT', `Only productions that haven’t reached a provider can be cancelled (this one is ${String(p.state).toLowerCase()}).`);
    // Lock the reservations first: a worker's provider dispatch debits the same row, so it either committed
    // before us (and its provider job is visible below) or it will find the reservation released.
    // Only the production reservation (keyed produce:<project>) — storyboard authorizations have their own lifecycle.
    const auths = await tx`select id from cost_authorizations where workspace_id = ${workspaceId} and project_id = ${projectId}
                           and idempotency_key = ${'produce:' + projectId} and status = 'active' for update`;
    if (auths.length) {
      const [dispatched] = await tx`select 1 from provider_jobs where workspace_id = ${workspaceId} and authorization_id in ${tx(auths.map((a) => a.id as string))} limit 1`;
      if (dispatched) throw new DomainError('CONFLICT', 'A provider call was already dispatched; the job has to finish and settle.');
    }
    const r = await transition(tx, ctx, projectId, 'CANCELLED', { from: [...CANCELLABLE_BEFORE_DISPATCH], reason: `staff: ${reason}` });
    if (!r.changed) throw new DomainError('CONFLICT', 'The production moved on; refresh and try again.');
    let released = 0;
    for (const a of auths) if (await settle(tx, ctx, a.id as string, 'released')) released++;
    await tx`update progress_steps set status = 'skipped', detail = 'Cancelled by Arkiv support', completed_at = now()
             where workspace_id = ${workspaceId} and subject_id = ${projectId} and status in ('pending','active')`;
    await audit(tx, s, 'project.cancel', { type: 'project', id: projectId }, { workspaceId, reason, before: { state: p.state }, after: { state: 'CANCELLED', reservationsReleased: released } });
    return { released, message: released ? 'Cancelled; the reserved entitlement is back on the customer’s balance.' : 'Cancelled before any reservation was made.' };
  });
}

/**
 * Queues whose handlers never call a billable provider, so re-running them can't create spend (§0.2, §12).
 * Everything else (analysis, storyboards, production, hook variants, genome, themes, recommendations) goes
 * through the Cost Governor and may only be retried by roles holding jobs.manage.
 */
export const NO_SPEND_QUEUES: ReadonlySet<string> = new Set([Queues.sendEmail, Queues.syncIntegration, Queues.computeResults, Queues.processUpload, Queues.exportWorkspace]);

export type OpsCommandKind = 'job.retry' | 'job.cancel' | 'dlq.requeue' | 'eval.run' | 'integration.verify_webhooks';

function opsPermission(kind: OpsCommandKind): Permission {
  switch (kind) {
    case 'eval.run':
      return 'evals.run';
    case 'integration.verify_webhooks':
      return 'integrations.manage';
    case 'job.retry':
      return 'jobs.retry_nospend';
    default:
      return 'jobs.manage'; // cancel, dead-letter redrive
  }
}

/** Can this staff member retry a job on this queue? (UI hint; requestOpsCommand enforces.) */
export const canRetryQueue = (roles: readonly StaffRole[], queue: string) => staffCan(roles, 'jobs.manage') || (staffCan(roles, 'jobs.retry_nospend') && NO_SPEND_QUEUES.has(queue));

/** Queue a job operation for the worker (which owns pg-boss). */
export async function requestOpsCommand(s: Staff, kind: OpsCommandKind, payload: Record<string, unknown>, reason: string) {
  assertStaff(s, opsPermission(kind));
  if (kind === 'job.retry' && !canRetryQueue(s.roles, String(payload.queue ?? ''))) {
    throw new DomainError('FORBIDDEN', 'Your role can only retry jobs that make no provider spend.', { permission: 'jobs.manage', queue: payload.queue ?? null });
  }
  if (reason.trim().length < 4) throw new DomainError('INVALID', 'A reason is required.');
  return withAdmin(async (tx) => {
    if (payload.workspaceId) {
      const [w] = await tx`select state from workspaces where id = ${payload.workspaceId as string}`;
      if (w?.state === 'SUSPENDED' && kind === 'job.retry') throw new DomainError('CONFLICT', 'Workspace is suspended; retries are blocked.');
    }
    const [c] = await tx`insert into ops_commands (kind, payload, requested_by, reason) values (${kind}, ${tx.json(payload as never)}, ${s.staffId}, ${reason}) returning id`;
    await audit(tx, s, `ops.${kind}`, { type: 'ops_command', id: c!.id as string }, { workspaceId: (payload.workspaceId as string) ?? null, reason, after: payload });
    return c!.id as string;
  });
}
