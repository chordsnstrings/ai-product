import { withAdmin, type Tx } from '@arkiv/db';
import { DomainError, type StaffRole, type WorkspaceState } from '@arkiv/shared';
import { adjust, type LedgerUnit } from './ledger';
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
  'jobs.manage': ['SUPER_ADMIN', 'OPS', 'SUPPORT'],
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
    await tx`update provider_rate_tables set status = 'retired' where provider = ${r.provider} and model = ${r.model} and status = 'published'`;
    await tx`update provider_rate_tables set status = 'published', approved_by = ${approver.staffId}, effective_from = greatest(effective_from, now()) where id = ${r.id}`;
    await audit(tx, approver, 'rates.published', { type: 'rate_table', id: r.id as string }, { after: { provider: r.provider, model: r.model, version: r.version } });
    return { provider: r.provider, model: r.model, version: r.version };
  }),
);

registerExecutor('route.promote', async (p, { approver }) =>
  withAdmin(async (tx) => {
    const [before] = await tx`select * from model_routes where task = ${p.task as string}`;
    if (!before) throw new DomainError('NOT_FOUND', 'Route not found');
    await tx`update model_routes set rollout_pct = ${Number(p.rolloutPct)},
               model = coalesce(${(p.model as string) ?? null}, model), prompt_version = coalesce(${(p.promptVersion as string) ?? null}, prompt_version),
               updated_at = now() where task = ${p.task as string}`;
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

export async function addTenantNote(s: Staff, workspaceId: string, body: string) {
  assertStaff(s, 'tenant.note');
  if (!body.trim()) throw new DomainError('INVALID', 'Note is empty');
  await withAdmin(async (tx) => {
    await tx`insert into tenant_notes (workspace_id, staff_id, body) values (${workspaceId}, ${s.staffId}, ${body.trim().slice(0, 4000)})`;
    await audit(tx, s, 'tenant.note', { type: 'workspace', id: workspaceId }, { workspaceId });
  });
}

/** Queue a job operation for the worker (which owns pg-boss). */
export async function requestOpsCommand(s: Staff, kind: 'job.retry' | 'job.cancel' | 'dlq.requeue' | 'eval.run' | 'integration.verify_webhooks', payload: Record<string, unknown>, reason: string) {
  assertStaff(s, kind === 'eval.run' ? 'evals.run' : kind === 'integration.verify_webhooks' ? 'integrations.manage' : 'jobs.manage');
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
