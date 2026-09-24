import { withAdmin, type Tx } from '@arkiv/db';
import { DomainError, newId, type Actor, type PlanCode, type ProjectState, type RiskIndicator, type StaffRole, type WorkspaceState } from '@arkiv/shared';
import type { TenantContext } from './context';
import { settle } from './cost-governor';
import { emit } from './events';
import { classifySubscriptionEvents, mrrTotals, subscriptionEvents } from './finance';
import { adjust, type LedgerUnit } from './ledger';
import { restoreFromScheduledPurge, RISK_PLAYBOOKS } from './lifecycle';
import { enqueue, queuePolicy, Queues } from './outbox';
import { retryProduction } from './production';
import { transition } from './projects';
import { estimate as priceEstimate, loadRates, retireSupersededRates, type CostLine, type Estimate } from './rates';
import { planQuota, setting } from './settings';
import { randomToken, sha256, transitionWorkspace } from './workspaces';

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
  // Coupons and plan changes on a tenant's subscription (plan 05 §2.2 Billing).
  'billing.manage': ['SUPER_ADMIN', 'FINANCE'],
  'ledger.read': ['SUPER_ADMIN', 'FINANCE', 'OPS'],
  'ledger.adjust': ['SUPER_ADMIN', 'FINANCE'],
  // Provider invoice import and COGS reconciliation (plan 05 §8).
  'cogs.reconcile': ['SUPER_ADMIN', 'FINANCE'],
  'rates.propose': ['SUPER_ADMIN', 'FINANCE', 'OPS'],
  'rates.publish': ['SUPER_ADMIN', 'FINANCE'],
  'providers.read': ['SUPER_ADMIN', 'ENGINEERING', 'OPS'],
  'providers.circuit': ['SUPER_ADMIN', 'ENGINEERING', 'OPS'],
  // Provider registry settings (plan 05 §10): status, region, concurrency, timeout, retry policy.
  'providers.manage': ['SUPER_ADMIN', 'ENGINEERING', 'OPS'],
  'routes.manage': ['SUPER_ADMIN', 'ENGINEERING'],
  'evals.run': ['SUPER_ADMIN', 'ENGINEERING'],
  // Add cases to golden datasets (plan 05 §11, §13): engineering, and the reviewers whose disagreements feed them.
  'golden.add': ['SUPER_ADMIN', 'ENGINEERING', 'COMPLIANCE', 'OPS'],
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
  // Ad spend import for CAC (plan 05 §4): GROWTH runs acquisition, FINANCE owns the numbers.
  'adspend.manage': ['SUPER_ADMIN', 'GROWTH', 'FINANCE'],
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
  // Resolve a Pulse platform alert (every operating role; ANALYST is read-only).
  'alerts.manage': ['SUPER_ADMIN', 'OPS', 'SUPPORT', 'FINANCE', 'COMPLIANCE', 'GROWTH', 'ENGINEERING'],
  // Your own sign-in factors (passkeys): every staff member.
  'account.self': ['SUPER_ADMIN', 'OPS', 'SUPPORT', 'FINANCE', 'COMPLIANCE', 'GROWTH', 'ENGINEERING', 'ANALYST'],
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

/**
 * §0.4 "Every admin page view of tenant data … writes to admin_audit_log": one row per render of a console page
 * that lists tenant rows, with the filters that shaped it.
 */
export async function auditView(tx: Tx, s: Staff, module: string, filters: Record<string, unknown> = {}, workspaceId: string | null = null) {
  const used = Object.fromEntries(Object.entries(filters).filter(([, v]) => v !== undefined && v !== null && v !== '' && v !== false));
  await audit(tx, s, `view.${module}`, { type: 'module', id: module }, { workspaceId, after: Object.keys(used).length ? used : undefined });
}

/**
 * §0.2 SUPPORT: "Tenant read (masked PII)". Emails, IPs and devices are masked for a viewer whose only roles are
 * SUPPORT (or ANALYST), unless they hold an active break-glass session on that tenant.
 */
const PII_MASKED_ROLES: readonly StaffRole[] = ['SUPPORT', 'ANALYST'];
export const shouldMaskPii = (roles: readonly StaffRole[], breakGlass = false) => !breakGlass && roles.every((r) => PII_MASKED_ROLES.includes(r));

/**
 * Staff actor context for domain functions that emit tenant events. `onBehalf` marks a break-glass write
 * (plan 05 §0.3): the actor is recorded as `staff:<id>>workspace:<id>`, i.e. actor=staff, on_behalf_of=workspace.
 */
export const staffCtx = (s: Pick<Staff, 'staffId'>, workspaceId: string, opts: { onBehalf?: boolean } = {}): { workspaceId: string; actor: Actor } => ({
  workspaceId,
  actor: opts.onBehalf ? { kind: 'staff', id: s.staffId, onBehalfOf: `workspace:${workspaceId}` } : { kind: 'staff', id: s.staffId },
});

// ───────────── Break-glass (plan 05 §0.3) ─────────────

export const BREAK_GLASS_MINUTES = 60;

/** §0.3 step 1: "Choose a reason (support ticket #, incident #, compliance review) and write free text." */
export const BREAK_GLASS_REASON_KINDS = ['ticket', 'incident', 'compliance_review'] as const;
export type BreakGlassReasonKind = (typeof BREAK_GLASS_REASON_KINDS)[number];
export const BREAK_GLASS_REASON_LABEL: Record<BreakGlassReasonKind, string> = { ticket: 'Support ticket', incident: 'Incident', compliance_review: 'Compliance review' };

export async function startBreakGlass(
  s: Staff,
  workspaceId: string,
  input: { reasonKind: BreakGlassReasonKind; reason: string; ticket?: string | null; write?: boolean; writeReason?: string | null },
) {
  assertStaff(s, input.write ? 'breakglass.write' : 'breakglass.read');
  if (!BREAK_GLASS_REASON_KINDS.includes(input.reasonKind)) throw new DomainError('INVALID', 'Choose why you need access: support ticket, incident or compliance review.');
  const ref = input.ticket?.trim() || null;
  if (input.reasonKind !== 'compliance_review' && !ref) throw new DomainError('INVALID', `Add the ${input.reasonKind === 'ticket' ? 'support ticket' : 'incident'} number.`);
  if (input.reason.trim().length < 8) throw new DomainError('INVALID', 'Describe why you need access (at least a sentence).');
  if (input.write && (input.writeReason ?? '').trim().length < 8) throw new DomainError('INVALID', 'Write access needs a second, specific reason.');
  return withAdmin(async (tx) => {
    const [w] = await tx`select id from workspaces where id = ${workspaceId}`;
    if (!w) throw new DomainError('NOT_FOUND', 'Workspace not found');
    await tx`update break_glass_sessions set ended_at = now() where workspace_id = ${workspaceId} and staff_id = ${s.staffId} and ended_at is null`;
    const reason = input.write ? `${input.reason} — write: ${input.writeReason}` : input.reason;
    const [bg] = await tx`insert into break_glass_sessions (workspace_id, staff_id, staff_name, reason_kind, reason, ticket, write_access, expires_at)
                          values (${workspaceId}, ${s.staffId}, ${s.name}, ${input.reasonKind}, ${reason}, ${ref}, ${!!input.write},
                                  now() + make_interval(mins => ${BREAK_GLASS_MINUTES})) returning id, expires_at`;
    await audit(tx, s, input.write ? 'breakglass.start_write' : 'breakglass.start', { type: 'workspace', id: workspaceId }, { workspaceId, reason, after: { reasonKind: input.reasonKind, reference: ref, write: !!input.write } });
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

/**
 * Break-glass "act on behalf" (§0.3 step 2): needs SUPER_ADMIN or OPS and an active write session (audited as
 * content.write), and returns a tenant context whose writes carry actor=staff:<id>, on_behalf_of=workspace:<id>.
 */
export async function actOnBehalf(tx: Tx, s: Staff, workspaceId: string, what: string): Promise<TenantContext> {
  assertStaff(s, 'breakglass.write');
  await assertBreakGlass(tx, s, workspaceId, what, true);
  const ctx = await staffTenantCtx(tx, s, workspaceId);
  return { ...ctx, actor: staffCtx(s, workspaceId, { onBehalf: true }).actor };
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
    await emit(tx, staffCtx(approver, ws), 'CLAIM_UNBLOCKED', { type: 'claim', id: p.claimId as string }, { from: 'BLOCKED', to: 'MERCHANT_REVIEW_REQUIRED', reason: String(p.reason ?? '') });
    await audit(tx, approver, 'claim.unblocked', { type: 'claim', id: p.claimId as string }, { workspaceId: ws, reason: p.reason as string, before: { status: 'BLOCKED' }, after: { status: 'MERCHANT_REVIEW_REQUIRED' } });
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

/** How long the current Owner has to answer a staff ownership-transfer request. */
export const OWNERSHIP_TRANSFER_HOURS = 72;

/**
 * Members tab 🔐 transfer ownership (plan 05 §2.2: "with written reason + customer email confirmation"). Staff
 * file the request with a written reason; nothing changes until a current Owner confirms from the link emailed to
 * them (decideOwnershipTransfer). A new request replaces a pending one. Returns the one-time token (for the email
 * only; the database keeps its hash) and who to email.
 */
export async function requestOwnershipTransfer(s: Staff, workspaceId: string, userId: string, reason: string) {
  assertStaff(s, 'tenant.state');
  if (reason.trim().length < 4) throw new DomainError('INVALID', 'A reason is required.');
  return withAdmin(async (tx) => {
    const [w] = await tx`select slug, name, state from workspaces where id = ${workspaceId} for update`;
    if (!w || w.state === 'PURGED') throw new DomainError('NOT_FOUND', 'Workspace not found');
    const [m] = await tx`select m.role, u.email, u.name from memberships m join users u on u.id = m.user_id where m.workspace_id = ${workspaceId} and m.user_id = ${userId}`;
    if (!m) throw new DomainError('NOT_FOUND', 'That user is not a member');
    if (m.role === 'OWNER') throw new DomainError('CONFLICT', 'That member already owns this workspace.');
    const owners = await tx`select u.email from memberships m join users u on u.id = m.user_id where m.workspace_id = ${workspaceId} and m.role = 'OWNER' and u.deleted_at is null`;
    if (!owners.length) throw new DomainError('CONFLICT', 'This workspace has no owner who could confirm the transfer.');
    const replaced = await tx`update ownership_transfers set status = 'cancelled', decided_at = now() where workspace_id = ${workspaceId} and status = 'pending' returning id`;
    const token = randomToken();
    const [t] = await tx`insert into ownership_transfers (workspace_id, to_user_id, requested_by, staff_name, reason, token_hash, expires_at)
                         values (${workspaceId}, ${userId}, ${s.staffId}, ${s.name}, ${reason.trim()}, ${sha256(token)}, now() + make_interval(hours => ${OWNERSHIP_TRANSFER_HOURS}))
                         returning id, expires_at`;
    await audit(tx, s, 'tenant.transfer_owner_requested', { type: 'workspace', id: workspaceId }, { workspaceId, reason, before: { newOwnerRole: m.role, replaced: replaced.map((r) => r.id) }, after: { transferId: t!.id, toUserId: userId, expiresAt: t!.expires_at } });
    return {
      transferId: t!.id as string,
      token,
      expiresAt: t!.expires_at as string,
      slug: w.slug as string,
      workspaceName: w.name as string,
      newOwner: { email: m.email as string, name: (m.name as string) ?? null },
      notify: owners.map((o) => o.email as string),
    };
  });
}

/** Withdraw a pending ownership-transfer request (its emailed link stops working). */
export async function cancelOwnershipTransfer(s: Staff, workspaceId: string, transferId: string, reason: string) {
  assertStaff(s, 'tenant.state');
  if (reason.trim().length < 4) throw new DomainError('INVALID', 'A reason is required.');
  return withAdmin(async (tx) => {
    const [t] = await tx`update ownership_transfers set status = 'cancelled', decided_at = now()
                         where id = ${transferId} and workspace_id = ${workspaceId} and status = 'pending' returning to_user_id`;
    if (!t) throw new DomainError('CONFLICT', 'That request is no longer pending.');
    await audit(tx, s, 'tenant.transfer_owner_cancelled', { type: 'workspace', id: workspaceId }, { workspaceId, reason, before: { transferId, status: 'pending' }, after: { status: 'cancelled' } });
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

/** A playbook can't be restarted for the same flag within this window (no double sends). */
export const INTERVENTION_COOLDOWN_HOURS = 24;

/**
 * Risk tab / retention board "Start intervention playbook" (plan 05 §2.2, §17): the flag's playbook email goes to
 * the workspace's owners and admins through the outbox, its in-app notice is posted to the workspace, and the start
 * is recorded on the flag ({ playbook, at, by, emailed, notice }). Never a discount. Playbooks without a templated
 * message (support sentiment) record the start so the follow-up is tracked.
 */
export async function startIntervention(s: Staff, workspaceId: string, flagId: string, opts: { email?: boolean; notice?: boolean; note?: string | null } = {}) {
  assertStaff(s, 'tenant.flags');
  return withAdmin(async (tx) => {
    const [f] = await tx`select r.indicator, r.resolved_at, r.interventions, w.state from risk_flags r join workspaces w on w.id = r.workspace_id
                         where r.id = ${flagId} and r.workspace_id = ${workspaceId} for update of r`;
    if (!f) throw new DomainError('NOT_FOUND', 'Risk flag not found');
    if (f.resolved_at) throw new DomainError('CONFLICT', 'This indicator is resolved or suppressed; there is nothing to act on.');
    if (['SUSPENDED', 'LOCKED', 'PURGE_SCHEDULED', 'PURGED'].includes(f.state as string)) throw new DomainError('CONFLICT', `The workspace is ${String(f.state).toLowerCase()}; playbooks are paused.`);
    const pb = RISK_PLAYBOOKS[f.indicator as RiskIndicator];
    if (!pb) throw new DomainError('INVALID', `No playbook for ${f.indicator as string}`);
    const past = (f.interventions as { at: string }[]) ?? [];
    const last = past.map((p) => new Date(p.at).getTime()).sort((a, b) => b - a)[0];
    if (last && Date.now() - last < INTERVENTION_COOLDOWN_HOURS * 3600_000) throw new DomainError('CONFLICT', `This playbook was started ${Math.round((Date.now() - last) / 60_000)} minutes ago.`);
    const emailed = !!pb.email && opts.email !== false;
    const notice = !!pb.notice && opts.notice !== false;
    if (emailed) await enqueue(tx, workspaceId, Queues.sendEmail, { template: 'intervention', indicator: f.indicator, flagId, run: past.length + 1 }, { singletonKey: `intervention:${flagId}:${past.length + 1}` });
    if (notice) {
      const source = `risk:${f.indicator as string}`;
      await tx`update workspace_notices set dismissed_at = now() where workspace_id = ${workspaceId} and source = ${source} and dismissed_at is null`;
      await tx`insert into workspace_notices (workspace_id, kind, source, title, body, link_path, link_label, created_by)
               values (${workspaceId}, 'intervention', ${source}, ${pb.notice!.headline}, ${pb.notice!.body}, ${pb.notice!.path}, ${pb.notice!.cta}, ${`staff:${s.staffId}`})`;
    }
    const entry = { playbook: f.indicator as string, at: new Date().toISOString(), by: s.email, emailed, notice, note: opts.note?.trim() || null };
    await tx`update risk_flags set interventions = interventions || ${tx.json([entry])} where id = ${flagId} and workspace_id = ${workspaceId}`;
    await audit(tx, s, 'intervention.start', { type: 'risk_flag', id: flagId }, { workspaceId, reason: opts.note ?? null, after: entry });
    const what = [emailed ? 'email queued to owners and admins' : null, notice ? 'in-app notice posted' : null].filter(Boolean).join(' and ');
    return { ...entry, message: what ? `Playbook started: ${what}.` : 'Playbook started and recorded; follow up personally.' };
  });
}

// ───────────── Experiments & jobs tab (plan 05 §2.2, §12) ─────────────

/** Production states that have not yet dispatched a billable provider call (§39 cancel semantics). */
export const CANCELLABLE_BEFORE_DISPATCH: readonly ProjectState[] = ['STORYBOARD_APPROVED', 'RENDER_RESERVED'];

/** A tenant context for a staff action run inside the customer's own domain functions (actor = staff). */
export async function staffTenantCtx(tx: Tx, s: Staff, workspaceId: string): Promise<TenantContext> {
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

export type OpsCommandKind = 'job.retry' | 'job.bulk_retry' | 'job.cancel' | 'dlq.requeue' | 'eval.run' | 'integration.verify_webhooks' | 'stripe.reconcile';

export interface RetryEstimate {
  /** What the retried work would cost at today's published rates. */
  micros: number;
  /** What it was estimated at when it was first authorized. */
  previousMicros: number;
  /** A rate table the work is priced on changed since then (plan 05 §12 "re-estimates cost first"). */
  rateChanged: boolean;
  authorizationId: string;
  rateVersions: Record<string, number>;
}

/**
 * A fresh Cost Governor estimate for re-running a spending job: the lines its last authorization (for the job's
 * project, or its SKU's analysis) was priced on, re-priced at the rates in effect now. Null when the job never
 * reached an authorization — the handler then authorizes from scratch, within its class ceiling. Admin role; the
 * workspace comes from the job and scopes every read.
 */
export async function jobRetryEstimate(tx: Tx, data: { workspaceId?: unknown; projectId?: unknown; skuId?: unknown }): Promise<RetryEstimate | null> {
  const ws = typeof data.workspaceId === 'string' ? data.workspaceId : null;
  const projectId = typeof data.projectId === 'string' ? data.projectId : null;
  const skuId = typeof data.skuId === 'string' ? data.skuId : null;
  if (!ws || (!projectId && !skuId)) return null;
  const [a] = await tx`select id, estimate from cost_authorizations
                       where workspace_id = ${ws} and (project_id = ${projectId} or (${skuId}::text is not null and estimate->>'skuId' = ${skuId}))
                       order by created_at desc limit 1`;
  const prev = a?.estimate as (Estimate & { lines?: { line: CostLine }[] }) | undefined;
  const lines = prev?.lines?.map((l) => l.line).filter(Boolean) ?? [];
  if (!a || !lines.length) return null;
  let fresh: Estimate;
  try {
    fresh = priceEstimate(await loadRates(tx), lines);
  } catch {
    throw new DomainError('CONFLICT', 'This job’s work can’t be priced at current rates (a rate table is missing). Publish the rate before retrying.');
  }
  const rateChanged = Object.entries(fresh.rateVersions).some(([k, v]) => prev?.rateVersions?.[k] !== v);
  return { micros: fresh.totalMicros, previousMicros: Number(prev?.totalMicros ?? 0), rateChanged, authorizationId: a.id as string, rateVersions: fresh.rateVersions };
}

/** A pg-boss job's payload, when the console can see the queue tables (the worker grants read access). */
async function jobData(tx: Tx, queue: string, jobId: string): Promise<Record<string, unknown> | null> {
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) return null;
  try {
    const [j] = await tx.savepoint((sp) => sp`select data from pgboss.job where name = ${queue} and id = ${jobId}::uuid`);
    return (j?.data as Record<string, unknown> | undefined) ?? null;
  } catch {
    return null;
  }
}

const usd = (micros: number) => `$${(micros / 1e6).toFixed(2)}`;

function opsPermission(kind: OpsCommandKind): Permission {
  switch (kind) {
    case 'stripe.reconcile':
      return 'billing.unmatched';
    case 'eval.run':
      return 'evals.run';
    case 'integration.verify_webhooks':
      return 'integrations.manage';
    case 'job.retry':
      return 'jobs.retry_nospend';
    case 'job.bulk_retry':
      return 'jobs.manage';
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
    if (kind === 'job.retry' || kind === 'job.bulk_retry') {
      const queue = String(payload.queue ?? '');
      const policy = queuePolicy(queue);
      if (!policy) throw new DomainError('INVALID', `Unknown queue ${queue}`);
      if (!policy.idempotent) throw new DomainError('CONFLICT', `${queue} jobs aren’t safe to re-run (the handler isn’t idempotent). Act on the tenant instead.`);
      if (kind === 'job.bulk_retry' && policy.spends) throw new DomainError('CONFLICT', `${queue} jobs spend on providers: retry them one at a time, with a fresh estimate each.`);
      if (kind === 'job.retry') {
        // The job's own payload names its workspace; the console's hint is used only when the job isn't visible.
        const job = (await jobData(tx, queue, String(payload.jobId ?? ''))) ?? {};
        const data = { ...job, workspaceId: job.workspaceId ?? payload.workspaceId };
        if (data.workspaceId) payload = { ...payload, workspaceId: data.workspaceId };
        if (payload.workspaceId) {
          const [w] = await tx`select state from workspaces where id = ${payload.workspaceId as string}`;
          if (w?.state === 'SUSPENDED') throw new DomainError('CONFLICT', 'Workspace is suspended; retries are blocked.');
        }
        if (policy.spends) {
          // §12: a retry that can spend runs only with a fresh Cost Governor estimate the operator has seen.
          const est = await jobRetryEstimate(tx, data);
          if (est) {
            if (Number(payload.confirmEstimateMicros) !== est.micros) {
              throw new DomainError('CONFLICT', `This retry may spend about ${usd(est.micros)} at current rates${est.rateChanged ? ` (rates changed since it was estimated at ${usd(est.previousMicros)})` : ''}. Confirm that estimate to retry.`, { estimate: est });
            }
          } else if (payload.confirmSpend !== true) {
            throw new DomainError('CONFLICT', 'This retry may spend: the handler asks the Cost Governor for a fresh authorization at current rates. Confirm to retry.', { estimate: null });
          }
          payload = { ...payload, estimate: est };
        }
      }
    }
    const [c] = await tx`insert into ops_commands (kind, payload, requested_by, reason) values (${kind}, ${tx.json(payload as never)}, ${s.staffId}, ${reason}) returning id`;
    await audit(tx, s, `ops.${kind}`, { type: 'ops_command', id: c!.id as string }, { workspaceId: (payload.workspaceId as string) ?? null, reason, after: payload });
    return c!.id as string;
  });
}

// ───────────── Tenant metrics for the console (plan 05 §1, §2.1, §2.2, §13) ─────────────

/** Churn-risk weights per open §10 indicator; the score is their sum, capped at 100. */
export const RISK_WEIGHTS: Record<RiskIndicator, number> = {
  paid_no_export: 25,
  negative_support_sentiment: 25,
  ad_account_disconnected: 20,
  repeated_qa_rejects: 20,
  idle_7d: 15,
  low_utilisation: 15,
  ignored_recommendations: 10,
  high_utilisation_friction: 10,
  no_performance_linked_test: 10,
  stockout: 5,
};
export type RiskBand = 'low' | 'medium' | 'high';
/** Lower bounds of each band (the tenant list filters on them in SQL too). */
export const RISK_BAND_MIN = { medium: 15, high: 40 } as const;
export const riskBand = (score: number): RiskBand => (score >= RISK_BAND_MIN.high ? 'high' : score >= RISK_BAND_MIN.medium ? 'medium' : 'low');

export function churnRisk(indicators: readonly string[]): { score: number; band: RiskBand } {
  const score = Math.min(100, [...new Set(indicators)].reduce((a, i) => a + (RISK_WEIGHTS[i as RiskIndicator] ?? 10), 0));
  return { score, band: riskBand(score) };
}

/** Production states with work in flight (a render slot in use). */
export const ACTIVE_PRODUCTION_STATES: readonly ProjectState[] = ['STORYBOARD_APPROVED', 'RENDER_RESERVED', 'RENDERING', 'QA_RUNNING', 'COMPOSING', 'PLATFORM_VARIANTS', 'FINAL_QA'];

export interface HealthInputs {
  riskScore: number;
  daysSinceActive: number | null;
  paying: boolean;
  exports30d: number;
  failedJobs7d: number;
  quotasOver: number;
}
export type HealthBand = 'healthy' | 'watch' | 'at risk';

/**
 * Tenant health (§2.2 Overview), 0–100: starts at 100 and loses points for churn risk, inactivity, a paying
 * tenant with no exports, recent failed productions and quotas exceeded. Each factor is listed for the reader.
 */
export function healthScore(h: HealthInputs): { score: number; band: HealthBand; factors: { label: string; points: number }[] } {
  const factors: { label: string; points: number }[] = [];
  if (h.riskScore) factors.push({ label: `churn risk ${h.riskScore}`, points: -Math.round(h.riskScore / 2) });
  if (h.daysSinceActive === null || h.daysSinceActive > 14) factors.push({ label: h.daysSinceActive === null ? 'no member has signed in' : `inactive ${h.daysSinceActive} days`, points: -25 });
  else if (h.daysSinceActive > 7) factors.push({ label: `inactive ${h.daysSinceActive} days`, points: -15 });
  if (h.paying && h.exports30d === 0) factors.push({ label: 'paying, no export in 30 days', points: -15 });
  if (h.failedJobs7d) factors.push({ label: `${h.failedJobs7d} failed production${h.failedJobs7d === 1 ? '' : 's'} (7d)`, points: -Math.min(20, 5 * h.failedJobs7d) });
  if (h.quotasOver) factors.push({ label: `${h.quotasOver} quota${h.quotasOver === 1 ? '' : 's'} exceeded`, points: -10 * h.quotasOver });
  const score = Math.max(0, Math.min(100, 100 + factors.reduce((a, f) => a + f.points, 0)));
  return { score, band: score >= 70 ? 'healthy' : score >= 40 ? 'watch' : 'at risk', factors };
}

/** Overview tab: plan quotas (settings-aware, 2-multi-tenancy §4) against usage, and the health score. */
export async function tenantHealth(tx: Tx, workspaceId: string) {
  const [w] = await tx`select plan_code, state from workspaces where id = ${workspaceId}`;
  if (!w) throw new DomainError('NOT_FOUND', 'Workspace not found');
  const quota = await planQuota(tx, (w.plan_code as PlanCode | null) ?? null);
  const [u] = await tx`select
      (select count(*) from brands where workspace_id = ${workspaceId})::int as brands,
      (select count(*) from memberships where workspace_id = ${workspaceId})::int as members,
      (select coalesce(sum(bytes), 0) from assets where workspace_id = ${workspaceId} and deleted_at is null)::bigint as bytes,
      (select count(*) from projects where workspace_id = ${workspaceId} and state in ${tx(ACTIVE_PRODUCTION_STATES as ProjectState[])})::int as rendering,
      (select to_char(current_period_start, 'YYYY-MM-DD') from subscriptions where workspace_id = ${workspaceId} and status in ('active','trialing','past_due') order by created_at desc limit 1) as period,
      (select coalesce(array_agg(distinct indicator), '{}') from risk_flags where workspace_id = ${workspaceId} and resolved_at is null) as risks,
      (select extract(day from now() - max(s.last_seen_at))::int from sessions s join memberships m on m.user_id = s.user_id where m.workspace_id = ${workspaceId}) as idle_days,
      (select count(*) from events where workspace_id = ${workspaceId} and type = 'ASSET_EXPORTED' and at > now() - interval '30 days')::int as exports30,
      (select count(*) from projects where workspace_id = ${workspaceId} and state = 'PROVIDER_FAILED' and updated_at > now() - interval '7 days')::int as failed7`;
  const [p] = u!.period
    ? await tx`select coalesce(sum(amount) filter (where type = 'CREDIT_GRANTED'), 0)::int as granted,
                      (coalesce(sum(-amount) filter (where type = 'CREDIT_RESERVED'), 0) - coalesce(sum(amount) filter (where type in ('CREDIT_RELEASED','CREDIT_REFUNDED')), 0))::int as used
               from ledger_entries where workspace_id = ${workspaceId} and unit = 'creative_test' and period_key = ${u!.period as string}`
    : [{ granted: 0, used: 0 }];
  const quotas = [
    { key: 'brands', label: 'Brands', used: Number(u!.brands), limit: quota.brands },
    { key: 'members', label: 'Members', used: Number(u!.members), limit: quota.members },
    { key: 'storageGb', label: 'Storage (GB)', used: Math.round((Number(u!.bytes) / 1e9) * 100) / 100, limit: quota.storageGb },
    { key: 'renderConcurrency', label: 'Productions in flight', used: Number(u!.rendering), limit: quota.renderConcurrency },
    { key: 'creativeTests', label: 'Creative Tests this period', used: Number(p!.used), limit: w.plan_code ? Math.max(Number(p!.granted), quota.creativeTestsPerMonth) : 0 },
  ];
  const risk = churnRisk((u!.risks as string[]) ?? []);
  const health = healthScore({
    riskScore: risk.score,
    daysSinceActive: u!.idle_days === null ? null : Number(u!.idle_days),
    paying: ['ACTIVE_PAID', 'PAST_DUE'].includes(w.state as string),
    exports30d: Number(u!.exports30),
    failedJobs7d: Number(u!.failed7),
    quotasOver: quotas.filter((q) => q.limit > 0 && q.used > q.limit).length,
  });
  return { quotas, risk, health };
}

/**
 * §1 / §7 MRR movement over the last `days`, from the SUBSCRIPTION_* events the Stripe webhooks write, priced at each
 * plan's price: new (and reactivated), expansion, contraction and churned MRR, and the net. A scheduled downgrade or
 * cancellation moves no MRR until it takes effect (finance.ts classifies). Test workspaces are excluded unless asked.
 */
export async function mrrMovement(tx: Tx, days: number, opts: { includeTest?: boolean } = {}) {
  const c = classifySubscriptionEvents(await subscriptionEvents(tx, opts));
  return mrrTotals(c, new Date(Date.now() - days * 86400_000));
}

export interface ReconciliationException {
  issue: string;
  workspaceId: string | null;
  ref: string;
  at: string | null;
}

/**
 * §7 reconciliation report: Stripe payments ↔ ledger grants ↔ workspace entitlements. Each mismatch is an
 * exception (paid but no entitlement, entitlement without payment, …). One definition for the Billing page and
 * a tenant's Ledger tab (`workspaceId`, §2.2 "reconciliation status"). Runs as the staff role, whose policies see
 * every tenant, so the workspace filter is explicit in every branch.
 */
export async function reconciliationExceptions(tx: Tx, opts: { workspaceId?: string | null; includeTest?: boolean } = {}): Promise<ReconciliationException[]> {
  const ws = opts.workspaceId ?? null;
  const scope = (col: string) => (ws ? tx`and ${tx(col)} = ${ws}` : opts.includeTest ? tx`` : tx`and (${tx(col)} is null or ${tx(col)} not in (select id from workspaces where is_test))`);
  const rows = await tx`
    select * from (
      select 'Paid purchase without project progress' as issue, p.workspace_id, p.id::text as ref, p.paid_at as at
        from purchases p join projects pr on pr.id = p.project_id and pr.workspace_id = p.workspace_id
        where p.status = 'paid' and pr.state = 'STORYBOARD_READY' and p.paid_at < now() - interval '15 minutes' ${scope('p.workspace_id')}
      union all
      select 'Paid purchase without entitlement grant', p.workspace_id, p.id::text, p.paid_at from purchases p
        where p.status = 'paid' and p.paid_at < now() - interval '15 minutes' ${scope('p.workspace_id')}
          and not exists (select 1 from ledger_entries l where l.workspace_id = p.workspace_id and l.type = 'CREDIT_GRANTED'
                            and l.unit = p.kind and l.reference = p.stripe_checkout_session_id)
      union all
      select 'Entitlement granted without a payment', l.workspace_id, l.id::text, l.created_at from ledger_entries l
        where l.type = 'CREDIT_GRANTED' and l.unit in ('taste', 'standalone') and l.idempotency_key like 'pay:%' ${scope('l.workspace_id')}
          and not exists (select 1 from purchases p where p.workspace_id = l.workspace_id and p.stripe_checkout_session_id = l.reference and p.status in ('paid', 'refunded'))
      union all
      select 'Period grant without a subscription', l.workspace_id, l.id::text, l.created_at from ledger_entries l
        where l.type = 'CREDIT_GRANTED' and l.unit = 'creative_test' and l.idempotency_key like 'grant:%' ${scope('l.workspace_id')}
          and not exists (select 1 from subscriptions s where s.workspace_id = l.workspace_id and l.idempotency_key like 'grant:' || s.stripe_subscription_id || ':%')
      union all
      select 'Active subscription without period grant', s.workspace_id, s.id::text, s.current_period_start from subscriptions s
        where s.status = 'active' ${scope('s.workspace_id')}
          and not exists (select 1 from ledger_entries l where l.workspace_id = s.workspace_id and l.type = 'CREDIT_GRANTED' and l.unit = 'creative_test'
                            and l.period_key = to_char(s.current_period_start, 'YYYY-MM-DD'))
      union all
      -- One-off buyers are ACTIVE_PAID without a plan (restoreFromScheduledPurge keeps them paid), so only a
      -- workspace with neither a live subscription nor a paid purchase is an exception.
      select 'Workspace ACTIVE_PAID without subscription or payment', w.id, w.slug, w.updated_at from workspaces w
        where w.state = 'ACTIVE_PAID' ${scope('w.id')}
          and not exists (select 1 from subscriptions s where s.workspace_id = w.id and s.status in ('active','trialing','past_due'))
          and not exists (select 1 from purchases p where p.workspace_id = w.id and p.status = 'paid')
      union all
      -- A failed event may not have been routed yet (workspace_id is set on success), so a tenant's view also
      -- matches its Stripe customer.
      select 'Stripe event failed processing', coalesce(e.workspace_id, ${ws}::uuid), e.id, e.received_at from stripe_events e where e.status = 'failed'
        ${ws ? tx`and (e.workspace_id = ${ws} or (e.workspace_id is null and e.payload->'data'->'object'->>'customer' in (select customer_id from stripe_customers where workspace_id = ${ws})))` : scope('e.workspace_id')}
    ) x order by at desc nulls last limit 500`;
  return rows.map((r) => ({ issue: r.issue as string, workspaceId: (r.workspace_id as string) ?? null, ref: r.ref as string, at: (r.at as string) ?? null }));
}

/**
 * §13 QA review queue: outputs that failed QA twice (technique switched), hard fidelity fails, and a 2% sample
 * of passed outputs for calibration — minus what a reviewer already judged. One definition for the QA page and
 * the Pulse open-queues tile.
 */
export function qaQueueSql(tx: Tx, opts: { includeTest?: boolean } = {}) {
  const failedTwice = tx`exists (select 1 from events e join scenes sc on sc.id = e.subject_id and sc.workspace_id = e.workspace_id
                           join storyboards sb on sb.id = sc.storyboard_id and sb.workspace_id = sc.workspace_id
                           where e.workspace_id = p.workspace_id and sb.project_id = p.id and e.type = 'QA_FAILED' and (e.payload->>'attempt')::int >= 2)`;
  const hard = tx`exists (select 1 from jsonb_array_elements(case when jsonb_typeof(p.qa_report->'checks') = 'array' then p.qa_report->'checks' else '[]'::jsonb end) c
                          where c->>'check' = 'product_fidelity' and coalesce((c->>'hard')::boolean, false) and not coalesce((c->>'pass')::boolean, true))`;
  // The production switched a scene's technique after repeated QA failure (or an unfundable repair).
  const switched = tx`exists (select 1 from jsonb_array_elements(case when jsonb_typeof(p.qa_report->'checks') = 'array' then p.qa_report->'checks' else '[]'::jsonb end) c
                              where c->'data' ? 'techniqueSwitch')`;
  const sample = tx`(p.state = 'COMPLETE' and abs(hashtext(p.id::text)) % 50 = 0)`;
  return tx`
    select p.id, p.workspace_id, p.state, p.qa_report, p.updated_at,
           -- A switch explains the earlier hard fails in the same report, so it is named first.
           case when ${failedTwice} and ${switched} then 'failed QA twice (technique switched)'
                when ${switched} then 'technique switched'
                when ${hard} then 'hard fidelity fail'
                when ${failedTwice} then 'failed QA twice'
                else 'calibration sample' end as why
    from projects p
    where not exists (select 1 from qa_reviews r where r.project_id = p.id)
      and (${!!opts.includeTest} or p.workspace_id not in (select id from workspaces where is_test))
      and (${hard} or ${failedTwice} or ${switched} or ${sample})`;
}
