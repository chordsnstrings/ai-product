import { createHash, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { globalTx, withTenant, type Tx } from '@arkiv/db';
import {
  DomainError,
  FREE_LIMITS,
  PLANS,
  PROVISIONAL,
  conflict,
  forbidden,
  invalid,
  newId,
  notFound,
  type PlanCode,
  type Role,
  type WorkspaceState,
} from '@arkiv/shared';
import { noteProvisionalCreated, type ClientFingerprint } from './abuse';
import { assertCan } from './authz';
import type { TenantContext } from './context';
import { emit } from './events';
import { JOB_HOLD_STATES, releaseHeldJobs } from './holds';
import { enqueue, Queues } from './outbox';
import { planQuota } from './settings';
import { storage } from './storage';

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');

/** Allowed lifecycle transitions (plan 02 §2). Holds (SUSPENDED/LOCKED) are reversible by staff. */
const TRANSITIONS: Record<WorkspaceState, WorkspaceState[]> = {
  PROVISIONAL: ['ACTIVE_FREE', 'PURGE_SCHEDULED', 'PURGED'],
  ACTIVE_FREE: ['ACTIVE_PAID', 'CANCELLED', 'PURGE_SCHEDULED', 'SUSPENDED', 'LOCKED'],
  ACTIVE_PAID: ['PAST_DUE', 'CANCELLED', 'ACTIVE_FREE', 'SUSPENDED', 'LOCKED', 'PURGE_SCHEDULED'],
  PAST_DUE: ['ACTIVE_PAID', 'CANCELLED', 'SUSPENDED', 'LOCKED'],
  CANCELLED: ['ACTIVE_PAID', 'ACTIVE_FREE', 'PURGE_SCHEDULED', 'SUSPENDED', 'LOCKED'],
  PURGE_SCHEDULED: ['CANCELLED', 'ACTIVE_FREE', 'ACTIVE_PAID', 'PURGED'],
  PURGED: [],
  SUSPENDED: [],
  LOCKED: [],
};

export async function transitionWorkspace(
  tx: Tx,
  ctx: Pick<TenantContext, 'workspaceId' | 'actor'>,
  to: WorkspaceState,
  reason: string,
): Promise<WorkspaceState> {
  const [w] = await tx`select state, state_before_hold, state_before_purge from workspaces where id = ${ctx.workspaceId} for update`;
  if (!w) throw notFound('Workspace not found');
  const from = w.state as WorkspaceState;
  if (from === to) return from;
  const liftingHold = (from === 'SUSPENDED' || from === 'LOCKED') && to === (w.state_before_hold as WorkspaceState);
  // Cancelling a scheduled purge returns the workspace to where it was (e.g. a paying tenant stays paying).
  const cancellingPurge = from === 'PURGE_SCHEDULED' && !!w.state_before_purge && to === (w.state_before_purge as WorkspaceState);
  if (!liftingHold && !cancellingPurge && !TRANSITIONS[from].includes(to)) throw conflict(`Cannot move workspace from ${from} to ${to}`);
  const holding = to === 'SUSPENDED' || to === 'LOCKED';
  await tx`
    update workspaces set state = ${to}, state_reason = ${reason},
      state_before_hold = ${holding ? from : null},
      state_before_purge = ${to === 'PURGE_SCHEDULED' ? from : null},
      -- Leaving a scheduled purge any other way than the purge itself (a payment, a restore) cancels it.
      purge_at = case when ${from} = 'PURGE_SCHEDULED' and ${to} <> 'PURGED' then null else purge_at end,
      cancelled_at = case when ${to} = 'CANCELLED' then now() else cancelled_at end
    where id = ${ctx.workspaceId}`;
  await emit(tx, ctx, 'WORKSPACE_STATE_CHANGED', { type: 'workspace', id: ctx.workspaceId }, { from, to, reason });
  // Jobs parked while the workspace was held run again once the hold ends (plan 05 §2.3).
  if (JOB_HOLD_STATES.has(from) && !JOB_HOLD_STATES.has(to) && to !== 'PURGED') await releaseHeldJobs(tx, ctx.workspaceId);
  return to;
}

/** States a workspace sits in "on top of" another one it returns to: a staff hold or a scheduled deletion. */
const HOLD_STATES: ReadonlySet<WorkspaceState> = new Set(['SUSPENDED', 'LOCKED']);

/**
 * A billing-driven lifecycle change (a payment failed, a plan ended, a payment recovered, a plan started), applied
 * only from the states in `from` (plan 02 §2). A staff hold (SUSPENDED/LOCKED) is never lifted by billing: the
 * hold stays, and the state the workspace returns to when it is lifted follows billing instead, so lifting a hold
 * never restores a paid state whose plan has ended (x-sublife-13). A scheduled deletion likewise keeps its purge
 * and records the state a cancelled deletion returns to — unless `from` lists PURGE_SCHEDULED itself (a new plan
 * starting takes the workspace out of a scheduled deletion). Evented either way. Returns the resulting state.
 */
export async function billingStateChange(
  tx: Tx,
  ctx: Pick<TenantContext, 'workspaceId' | 'actor'>,
  to: WorkspaceState,
  from: readonly WorkspaceState[],
  reason: string,
): Promise<WorkspaceState> {
  const [w] = await tx`select state, state_before_hold, state_before_purge from workspaces where id = ${ctx.workspaceId} for update`;
  if (!w) throw notFound('Workspace not found');
  const cur = w.state as WorkspaceState;
  const underneath = HOLD_STATES.has(cur) ? 'state_before_hold' : cur === 'PURGE_SCHEDULED' && !from.includes(cur) ? 'state_before_purge' : null;
  if (underneath) {
    const prev = w[underneath] as WorkspaceState | null;
    if (!prev || prev === to || !from.includes(prev)) return cur;
    if (underneath === 'state_before_hold') await tx`update workspaces set state_before_hold = ${to} where id = ${ctx.workspaceId}`;
    else await tx`update workspaces set state_before_purge = ${to} where id = ${ctx.workspaceId}`;
    await emit(tx, ctx, 'WORKSPACE_STATE_CHANGED', { type: 'workspace', id: ctx.workspaceId }, { from: cur, to: cur, reason, underlying: { from: prev, to } });
    return cur;
  }
  if (!from.includes(cur)) return cur;
  return transitionWorkspace(tx, ctx, to, reason);
}

function slugify(s: string) {
  return (
    s
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'brand'
  );
}

export async function uniqueSlug(base: string): Promise<string> {
  const root = slugify(base);
  return globalTx(async (tx) => {
    for (let i = 0; i < 20; i++) {
      const candidate = i === 0 ? root : `${root}-${randomBytes(2).toString('hex')}`;
      const [r] = await tx`select slug_taken(${candidate}) as taken`;
      if (!r!.taken) return candidate;
    }
    return `${root}-${randomBytes(4).toString('hex')}`;
  });
}

/** Anonymous visitor's provisional workspace (plan 02 §2.1). Returns the raw cookie token once. */
/**
 * A provisional workspace for an anonymous visitor (plan 02 §2.1). With the visitor's fingerprint, the creation is
 * counted against its network, device and ASN, and a farm is flagged for trust & safety (plan 05 §15).
 */
export async function createProvisionalWorkspace(fp?: ClientFingerprint): Promise<{ workspaceId: string; token: string }> {
  const workspaceId = newId();
  const token = randomToken();
  const slug = `p-${randomBytes(5).toString('hex')}`;
  await withTenant(workspaceId, async (tx) => {
    await tx`insert into workspaces (id, slug, name, state, provisional_token_hash, provisional_expires_at)
             values (${workspaceId}, ${slug}, 'Your brand', 'PROVISIONAL', ${sha256(token)},
                     now() + make_interval(days => ${PROVISIONAL.TTL_DAYS}))`;
    await tx`insert into brands (workspace_id, name) values (${workspaceId}, 'Your brand')`;
    await emit(tx, { workspaceId, actor: { kind: 'provisional', id: workspaceId } }, 'WORKSPACE_CREATED', { type: 'workspace', id: workspaceId }, { provisional: true });
    if (fp) await noteProvisionalCreated(tx, workspaceId, fp);
  });
  return { workspaceId, token };
}

export async function resolveProvisional(token: string | undefined | null): Promise<string | null> {
  if (!token) return null;
  const [r] = await globalTx((tx) => tx`select resolve_provisional(${sha256(token)}) as id`);
  return (r?.id as string) ?? null;
}

/**
 * Claim a provisional workspace for a user on signup: the preview work carries over (endowed progress,
 * plan 04 L3/L4). If the user already owns workspaces, the caller can instead move the SKU (see moveSku).
 */
export async function claimProvisional(workspaceId: string, userId: string, brandName?: string | null): Promise<string> {
  return withTenant(workspaceId, async (tx) => {
    const [w] = await tx`select state from workspaces where id = ${workspaceId} for update`;
    if (!w) throw notFound('Workspace not found');
    if (w.state !== 'PROVISIONAL') {
      const [m] = await tx`select 1 from memberships where user_id = ${userId}`;
      if (m) return workspaceId; // idempotent re-claim by the same user
      throw conflict('This preview has already been saved to another account');
    }
    const [u] = await tx`select email from users where id = ${userId}`;
    const name = brandName?.trim() || (u ? String(u.email).split('@')[1]!.split('.')[0]! : 'My brand');
    const slug = await uniqueSlug(name);
    await tx`update workspaces set state = 'ACTIVE_FREE', slug = ${slug}, name = ${name},
               provisional_token_hash = null, provisional_expires_at = null where id = ${workspaceId}`;
    await tx`update brands set name = ${name} where workspace_id = ${workspaceId}`;
    await tx`insert into memberships (workspace_id, user_id, role) values (${workspaceId}, ${userId}, 'OWNER')`;
    const ctx = { workspaceId, actor: { kind: 'user' as const, id: userId } };
    await emit(tx, ctx, 'WORKSPACE_STATE_CHANGED', { type: 'workspace', id: workspaceId }, { from: 'PROVISIONAL', to: 'ACTIVE_FREE' });
    await emit(tx, ctx, 'MEMBER_ADDED', { type: 'user', id: userId }, { role: 'OWNER' });
    return workspaceId;
  });
}

export async function createWorkspace(userId: string, name: string): Promise<{ workspaceId: string; slug: string }> {
  if (!name.trim()) throw invalid('Workspace name is required');
  const workspaceId = newId();
  const slug = await uniqueSlug(name);
  await withTenant(workspaceId, async (tx) => {
    await tx`insert into workspaces (id, slug, name, state) values (${workspaceId}, ${slug}, ${name.trim()}, 'ACTIVE_FREE')`;
    await tx`insert into memberships (workspace_id, user_id, role) values (${workspaceId}, ${userId}, 'OWNER')`;
    await tx`insert into brands (workspace_id, name) values (${workspaceId}, ${name.trim()})`;
    const ctx = { workspaceId, actor: { kind: 'user' as const, id: userId } };
    await emit(tx, ctx, 'WORKSPACE_CREATED', { type: 'workspace', id: workspaceId }, {});
    await emit(tx, ctx, 'MEMBER_ADDED', { type: 'user', id: userId }, { role: 'OWNER' });
  });
  return { workspaceId, slug };
}

/**
 * Move the SKUs of a provisional workspace into an existing workspace the user belongs to (plan 02 §2.1).
 * Composite FKs use ON UPDATE CASCADE, so rewriting skus.workspace_id carries the whole SKU subtree (facts,
 * claims, assets, projects, storyboards, scenes…) atomically. Append-only records of the free preview
 * (ledger, events, provider jobs) stay with the provisional workspace, which is then purged.
 *
 * Runs in the customer app, which holds only the RLS-bound app role (plan 02 §3 layer 2): the cross-workspace move
 * is the narrow move_provisional_skus() database function (it checks the membership and the provisional state
 * itself); the stored objects are then copied under the target tenant's own context. Should that copy be cut
 * short, the purge of the provisional workspace re-homes what is still referenced (purgeWorkspace).
 */
export async function moveProvisionalSkus(fromWorkspaceId: string, toWorkspaceId: string, userId: string): Promise<number> {
  let moved: number;
  try {
    const [r] = await globalTx((tx) => tx`select move_provisional_skus(${fromWorkspaceId}::uuid, ${toWorkspaceId}::uuid, ${userId}::uuid) as n`);
    moved = Number(r!.n);
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === '42501') throw forbidden();
    if (code === 'P0002') throw conflict('Nothing to move');
    throw e;
  }
  await rehomeObjects(toWorkspaceId, fromWorkspaceId);
  return moved;
}

/**
 * Storage keys embed the tenant prefix: copy a workspace's objects still stored under another tenant's prefix to
 * its own, so purging the old prefix cannot delete them. Runs in the owning tenant's context.
 */
export async function rehomeObjects(workspaceId: string, fromWorkspaceId: string): Promise<number> {
  return withTenant(workspaceId, async (tx) => {
    const rows = await tx`select id, storage_key, mime from assets where workspace_id = ${workspaceId} and storage_key like ${`t/${fromWorkspaceId}/%`}`;
    for (const a of rows) {
      const newKey = (a.storage_key as string).replace(`t/${fromWorkspaceId}/`, `t/${workspaceId}/`);
      await storage().put(newKey, await storage().get(a.storage_key as string), a.mime as string);
      await tx`update assets set storage_key = ${newKey} where id = ${a.id}`;
    }
    return rows.length;
  });
}

// ───────────── Limits ─────────────

/** Code defaults only; runtime checks use planQuota (settings-aware, plan 05 §20). */
export function limitsFor(plan: PlanCode | null | undefined) {
  if (!plan) return { ...FREE_LIMITS, creativeTestsPerMonth: 0 };
  const p = PLANS[plan];
  return { brands: p.brands, members: p.members, renderConcurrency: p.renderConcurrency, storageGb: p.storageGb, creativeTestsPerMonth: p.creativeTestsPerMonth };
}

// ───────────── Members & invites (plan 02 §1.1, §5) ─────────────

export async function listMembers(tx: Tx) {
  return tx`select m.user_id, m.role, m.created_at, u.email, u.name from memberships m join users u on u.id = m.user_id order by m.created_at`;
}

export async function inviteMember(tx: Tx, ctx: TenantContext, email: string, role: Exclude<Role, 'OWNER'>) {
  assertCan(ctx, 'member.invite');
  const normalized = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized)) throw invalid('Enter a valid email address');
  // The workspace row lock serializes invites, accepts and member changes per workspace: two concurrent invites
  // at limit−1 cannot both pass the count below (x-races-09).
  const [w] = await tx`select plan_code from workspaces where id = ${ctx.workspaceId} for update`;
  const lim = await planQuota(tx, w?.plan_code as PlanCode | null);
  // A re-invite replaces the address's live invite, so it does not count against the limit twice.
  const [c] = await tx`select (select count(*) from memberships) + (select count(*) from invites where accepted_at is null
                         and revoked_at is null and expires_at > now() and email <> ${normalized}) as n`;
  if (Number(c!.n) >= lim.members) throw new DomainError('PAYMENT_REQUIRED', `Your plan includes ${lim.members} members. Upgrade to invite more.`);
  const [existing] = await tx`select 1 from memberships m join users u on u.id = m.user_id where u.email = ${normalized}`;
  if (existing) throw conflict('That person is already a member');
  const token = randomToken();
  // One live invite per address (unique index invites_one_live): the new one replaces any earlier one.
  await tx`update invites set revoked_at = now() where email = ${normalized} and accepted_at is null and revoked_at is null`;
  const [inv] = await tx`
    insert into invites (workspace_id, email, role, token_hash, invited_by, expires_at)
    values (${ctx.workspaceId}, ${normalized}, ${role}, ${sha256(token)}, ${ctx.actor.kind === 'user' ? ctx.actor.id : null},
            now() + interval '7 days') returning id`;
  return { inviteId: inv!.id as string, token };
}

/**
 * Resend a pending invite (plan 05 §2.2 Members "Resend invite"): a new token (the old link stops working) and a
 * fresh 7-day expiry. Runs under any role; the explicit workspace filter keeps it tenant-scoped for staff.
 */
export async function rotateInviteToken(tx: Tx, workspaceId: string, inviteId: string) {
  const [inv] = await tx`select i.email, i.role, i.accepted_at, i.revoked_at, coalesce(u.name, u.email::text) as inviter, w.name as workspace_name
                         from invites i join workspaces w on w.id = i.workspace_id left join users u on u.id = i.invited_by
                         where i.id = ${inviteId} and i.workspace_id = ${workspaceId} for update of i`;
  if (!inv) throw notFound('Invite not found');
  if (inv.accepted_at) throw conflict('That invite was already accepted.');
  if (inv.revoked_at) throw conflict('That invite was revoked. Invite the person again instead.');
  const token = randomToken();
  await tx`update invites set token_hash = ${sha256(token)}, expires_at = now() + interval '7 days' where id = ${inviteId} and workspace_id = ${workspaceId}`;
  return { token, email: inv.email as string, role: inv.role as Role, inviterName: (inv.inviter as string) ?? (inv.workspace_name as string), workspaceName: inv.workspace_name as string };
}

export type InviteLookup =
  | { status: 'ok'; workspaceId: string; workspaceName: string; email: string; role: Role; inviteId: string }
  | { status: 'expired' | 'revoked' | 'accepted' | 'not_found'; workspaceName?: string };

export async function lookupInvite(token: string): Promise<InviteLookup> {
  const [i] = await globalTx((tx) => tx`select * from find_invite(${sha256(token)})`);
  if (!i) return { status: 'not_found' };
  if (i.revoked_at) return { status: 'revoked', workspaceName: i.workspace_name };
  if (i.accepted_at) return { status: 'accepted', workspaceName: i.workspace_name };
  if (new Date(i.expires_at as string) < new Date()) return { status: 'expired', workspaceName: i.workspace_name };
  return { status: 'ok', workspaceId: i.workspace_id, workspaceName: i.workspace_name, email: i.email, role: i.role, inviteId: i.invite_id };
}

/** M4: an invite opened while logged in as a different email is never auto-accepted. */
export async function acceptInvite(token: string, user: { id: string; email: string }) {
  const inv = await lookupInvite(token);
  if (inv.status !== 'ok') throw new DomainError('CONFLICT', `This invite is ${inv.status.replace('_', ' ')}`, { status: inv.status });
  if (inv.email.toLowerCase() !== user.email.toLowerCase())
    throw new DomainError('FORBIDDEN', `This invite is for ${inv.email}. Switch account to accept it.`, { mismatch: true, inviteEmail: inv.email });
  return withTenant(inv.workspaceId, async (tx) => {
    // Re-check the member limit at acceptance (the plan may have been downgraded since the invite was sent);
    // a full workspace leaves the invite open so it can be accepted after an upgrade.
    const [w] = await tx`select plan_code from workspaces where id = ${inv.workspaceId} for update`;
    const lim = await planQuota(tx, (w?.plan_code as PlanCode | null) ?? null);
    const [already] = await tx`select 1 from memberships where user_id = ${user.id}`;
    const [c] = await tx`select count(*)::int as n from memberships`;
    if (!already && c!.n >= lim.members)
      throw new DomainError('PAYMENT_REQUIRED', `This workspace’s plan includes ${lim.members} members and it is full. Ask an Owner to upgrade, then accept again.`);
    const upd = await tx`update invites set accepted_at = now(), accepted_by = ${user.id}
                         where id = ${inv.inviteId} and accepted_at is null and revoked_at is null returning id`;
    if (!upd.length) throw conflict('This invite was already used');
    await tx`insert into memberships (workspace_id, user_id, role) values (${inv.workspaceId}, ${user.id}, ${inv.role})
             on conflict do nothing`;
    await emit(tx, { workspaceId: inv.workspaceId, actor: { kind: 'user', id: user.id } }, 'MEMBER_ADDED', { type: 'user', id: user.id }, { role: inv.role, via: 'invite' });
    return inv.workspaceId;
  });
}

async function ownerCount(tx: Tx) {
  const [r] = await tx`select count(*)::int as n from memberships where role = 'OWNER'`;
  return r!.n as number;
}

/**
 * Owner-affecting changes (role change, removal, transfer) lock the workspace row first, so they run one at a
 * time per workspace and the last-Owner check (M1) sees committed state: two Owners demoting or removing each
 * other concurrently cannot both pass it (x-races-10).
 */
async function lockMembership(tx: Tx, ctx: TenantContext) {
  await tx`select 1 from workspaces where id = ${ctx.workspaceId} for update`;
}

export async function changeRole(tx: Tx, ctx: TenantContext, userId: string, role: Role) {
  await lockMembership(tx, ctx);
  const [target] = await tx`select role from memberships where user_id = ${userId} for update`;
  if (!target) throw notFound('Member not found');
  const from = target.role as Role;
  // Plan 02 §1.1: Admins manage every member except Owners (including other Admins); Owner changes are Owner-only.
  if (from === 'OWNER' || role === 'OWNER') assertCan(ctx, 'member.manage_owner');
  else assertCan(ctx, 'member.change_role');
  if (from === 'OWNER' && role !== 'OWNER' && (await ownerCount(tx)) <= 1)
    throw conflict('Transfer ownership first: a workspace needs at least one Owner.'); // M1
  await tx`update memberships set role = ${role} where user_id = ${userId}`;
  await tx`update workspaces set membership_version = membership_version + 1 where id = ${ctx.workspaceId}`;
  await emit(tx, ctx, 'MEMBER_ROLE_CHANGED', { type: 'user', id: userId }, { from, to: role });
}

export async function removeMember(tx: Tx, ctx: TenantContext, userId: string) {
  await lockMembership(tx, ctx);
  const [target] = await tx`select role from memberships where user_id = ${userId} for update`;
  if (!target) throw notFound('Member not found');
  const self = ctx.actor.kind === 'user' && ctx.actor.id === userId;
  if (!self) {
    assertCan(ctx, target.role === 'OWNER' ? 'member.manage_owner' : 'member.remove');
  }
  if (target.role === 'OWNER' && (await ownerCount(tx)) <= 1) throw conflict('Transfer ownership first: a workspace needs at least one Owner.');
  await tx`delete from memberships where user_id = ${userId}`;
  // M6: revocation takes effect on the next request (membership version bump invalidates cached lookups).
  await tx`update workspaces set membership_version = membership_version + 1 where id = ${ctx.workspaceId}`;
  await emit(tx, ctx, 'MEMBER_REMOVED', { type: 'user', id: userId }, { role: target.role, self });
}

/** Workspaces that are ending: their last Owner may leave with their account. */
const ENDING_STATES: readonly WorkspaceState[] = ['CANCELLED', 'PURGE_SCHEDULED', 'PURGED'];

/** The actor string a deleted user's past actions are attributed to (plan 02 §7). Stable, not reversible. */
export const deletedUserActor = (userId: string) => `user:deleted:${sha256(`arkiv-deleted-user:${userId}`).slice(0, 16)}`;

/**
 * Delete a user account (plan 02 §7, standard §40): the user leaves every workspace, their sign-in methods and
 * sessions are removed, their past actions in event logs are attributed to `user:deleted:<hash>`, and the user row
 * keeps no email or name. Refused while they are the last Owner of a live workspace (M1) — including a paid one
 * (M2): ownership is transferred, or the workspace cancelled or deleted, first. Financial and audit records stay.
 * Re-runnable: a partly finished deletion completes on the next call.
 */
export async function deleteUser(userId: string, meta: { by: 'self' | 'staff' } = { by: 'self' }): Promise<{ workspaces: number }> {
  // The user's own memberships (list_user_workspaces), with each workspace's Owner count read in that tenant.
  const listed = await globalTx((tx) => tx`select workspace_id, role, state, name from list_user_workspaces(${userId}::uuid)`);
  const memberships = await Promise.all(
    listed.map(async (m) => {
      const [o] = await withTenant(m.workspace_id as string, (tx) => tx`select count(*)::int as n from memberships where role = 'OWNER'`);
      return { workspace_id: m.workspace_id as string, role: m.role as string, state: m.state as string, name: m.name as string, owners: Number(o!.n) };
    }),
  );
  const [u] = await globalTx((tx) => tx`select id, email, deleted_at from users where id = ${userId}`);
  if (!u) throw notFound('Account not found');
  const blocking = memberships.filter((m) => m.role === 'OWNER' && m.owners <= 1 && !ENDING_STATES.includes(m.state as WorkspaceState));
  if (blocking.length) {
    const paid = blocking.some((m) => ['ACTIVE_PAID', 'PAST_DUE'].includes(m.state as string));
    throw conflict(
      `You’re the only Owner of ${blocking.map((m) => `“${m.name}”`).join(', ')}. Transfer ownership${paid ? ' or cancel the subscription' : ' or delete the workspace'} first.`,
      { workspaces: blocking.map((m) => m.workspace_id), paid },
    );
  }
  for (const m of memberships) {
    await withTenant(m.workspace_id as string, async (tx) => {
      await tx`select 1 from workspaces where id = ${m.workspace_id} for update`;
      const r = await tx`delete from memberships where user_id = ${userId} returning role`;
      if (!r.length) return;
      await tx`update workspaces set membership_version = membership_version + 1 where id = ${m.workspace_id}`;
      await emit(tx, { workspaceId: m.workspace_id as string, actor: { kind: 'user', id: userId } }, 'MEMBER_REMOVED', { type: 'user', id: userId }, { role: r[0]!.role, self: meta.by === 'self', reason: 'account_deleted' });
    });
  }
  await globalTx(async (tx) => {
    await tx`delete from sessions where user_id = ${userId}`;
    await tx`delete from passkeys where user_id = ${userId}`;
    await tx`delete from user_identities where user_id = ${userId}`;
    if (!u.deleted_at) await tx`delete from magic_links where email = ${u.email as string}`;
    await tx`update users set email = ${`deleted+${userId}@deleted.invalid`}, name = null, email_verified_at = null,
               deleted_at = coalesce(deleted_at, now()) where id = ${userId}`;
  });
  // Only once the user row is marked deleted: the database function re-attributes that user's events only.
  await globalTx((tx) => tx`select arkiv_anonymize_user_events(${userId}::uuid, ${deletedUserActor(userId)})`);
  return { workspaces: memberships.length };
}

export async function transferOwnership(tx: Tx, ctx: TenantContext, toUserId: string) {
  assertCan(ctx, 'workspace.transfer');
  await lockMembership(tx, ctx);
  const [t] = await tx`select role from memberships where user_id = ${toUserId} for update`;
  if (!t) throw notFound('New owner must already be a member');
  // The new Owner must exist when the outgoing one steps down, or the workspace would be left without one.
  const promoted = await tx`update memberships set role = 'OWNER' where user_id = ${toUserId} returning user_id`;
  if (!promoted.length) throw notFound('New owner must already be a member');
  // The outgoing owner steps down to Admin (not when they name themselves).
  let stepDown: { userId: string; from: Role } | null = null;
  if (ctx.actor.kind === 'user' && ctx.actor.id !== toUserId) {
    const [me] = await tx`select role from memberships where user_id = ${ctx.actor.id} for update`;
    if (me && me.role !== 'ADMIN') {
      await tx`update memberships set role = 'ADMIN' where user_id = ${ctx.actor.id}`;
      stepDown = { userId: ctx.actor.id, from: me.role as Role };
    }
  }
  const [ver] = await tx`update workspaces set membership_version = membership_version + 1 where id = ${ctx.workspaceId} returning membership_version`;
  // One MEMBER_ROLE_CHANGED per member whose role changed, in the shared payload shape (EVENT_PAYLOADS).
  if (t.role !== 'OWNER') await emit(tx, ctx, 'MEMBER_ROLE_CHANGED', { type: 'user', id: toUserId }, { from: t.role as Role, to: 'OWNER', transfer: true });
  if (stepDown) await emit(tx, ctx, 'MEMBER_ROLE_CHANGED', { type: 'user', id: stepDown.userId }, { from: stepDown.from, to: 'ADMIN', transfer: true });
  // Security email to the new and previous Owner (plan 03 A10 "security (… ownership change)"), sent after commit
  // through the outbox like the staff-requested transfer's.
  if (t.role !== 'OWNER' || stepDown) {
    const userIds = [...new Set([toUserId, ...(stepDown ? [stepDown.userId] : [])])];
    await enqueue(tx, ctx.workspaceId, Queues.sendEmail, { template: 'ownership_transferred', userIds }, { singletonKey: `owner-transferred:self:${String(ver?.membership_version ?? toUserId)}` });
  }
}

/**
 * Make `toUserId` the Owner and step every current Owner down to Admin, in one transaction. Shared by the staff
 * ownership transfer (completed when the current Owner confirms). Explicit workspace filters: callers may run as
 * the tenant (RLS) or as staff/system, whose policies see every tenant.
 */
export async function swapOwnership(tx: Tx, ctx: Pick<TenantContext, 'workspaceId' | 'actor'>, toUserId: string, extra: { byStaff?: true; reason?: string } = {}) {
  const ws = ctx.workspaceId;
  // Same per-workspace serialization as the other owner-affecting changes (lockMembership, x-races-10).
  await tx`select 1 from workspaces where id = ${ws} for update`;
  const [m] = await tx`select role from memberships where workspace_id = ${ws} and user_id = ${toUserId} for update`;
  if (!m) throw notFound('The new owner must still be a member of this workspace.');
  if (m.role === 'OWNER') throw conflict('That member already owns this workspace.');
  const prev = await tx`update memberships set role = 'ADMIN' where workspace_id = ${ws} and role = 'OWNER' returning user_id`;
  await tx`update memberships set role = 'OWNER' where workspace_id = ${ws} and user_id = ${toUserId}`;
  await tx`update workspaces set membership_version = membership_version + 1 where id = ${ws}`;
  // One MEMBER_ROLE_CHANGED per member whose role changed, in the shared payload shape (EVENT_PAYLOADS).
  await emit(tx, ctx, 'MEMBER_ROLE_CHANGED', { type: 'user', id: toUserId }, { from: m.role as Role, to: 'OWNER', transfer: true, ...extra });
  for (const p of prev) await emit(tx, ctx, 'MEMBER_ROLE_CHANGED', { type: 'user', id: p.user_id as string }, { from: 'OWNER', to: 'ADMIN', transfer: true, ...extra });
  return { from: m.role as Role, previousOwners: prev.map((p) => p.user_id as string) };
}

export type OwnershipTransferLookup =
  | { status: 'pending'; workspaceId: string; workspaceName: string; workspaceSlug: string; toEmail: string; toName: string | null; staffName: string; reason: string; expiresAt: string }
  | { status: 'confirmed' | 'declined' | 'cancelled' | 'expired' | 'not_found'; workspaceName?: string };

/** The confirmation page (GET): inspect a staff-requested ownership transfer without deciding it. */
export async function lookupOwnershipTransfer(token: string): Promise<OwnershipTransferLookup> {
  const [t] = await globalTx((tx) => tx`select * from find_ownership_transfer(${sha256(token)})`);
  if (!t) return { status: 'not_found' };
  if (t.status !== 'pending') return { status: t.status as 'confirmed' | 'declined' | 'cancelled', workspaceName: t.workspace_name as string };
  if (new Date(t.expires_at as string) <= new Date()) return { status: 'expired', workspaceName: t.workspace_name as string };
  return {
    status: 'pending',
    workspaceId: t.workspace_id as string,
    workspaceName: t.workspace_name as string,
    workspaceSlug: t.workspace_slug as string,
    toEmail: t.to_email as string,
    toName: (t.to_name as string) ?? null,
    staffName: t.staff_name as string,
    reason: t.reason as string,
    expiresAt: t.expires_at as string,
  };
}

/**
 * The current Owner confirms (or declines) a transfer Arkiv support requested (plan 05 §2.2 "🔐 transfer ownership
 * (with written reason + customer email confirmation)"). They must be signed in as an Owner of that workspace and
 * hold the emailed link. The decision is recorded on the request and in the staff audit log, and a confirmation
 * swaps the roles in the same transaction; both owners are told by email through the outbox.
 */
export async function decideOwnershipTransfer(token: string, user: { id: string }, confirm: boolean, meta: { ip?: string | null; userAgent?: string | null } = {}) {
  const t = await lookupOwnershipTransfer(token);
  if (t.status !== 'pending') throw new DomainError('CONFLICT', `This request is ${t.status.replace('_', ' ')}.`, { status: t.status });
  return withTenant(t.workspaceId, async (tx) => {
    const [me] = await tx`select role from memberships where workspace_id = ${t.workspaceId} and user_id = ${user.id}`;
    if (me?.role !== 'OWNER') throw new DomainError('FORBIDDEN', `Only an owner of ${t.workspaceName} can answer this request.`);
    const ip = meta.ip && isIP(meta.ip) ? meta.ip : null;
    const [d] = await tx`select * from ownership_transfer_decide(${sha256(token)}, ${user.id}, ${confirm}, ${ip}, ${meta.userAgent ?? null})`;
    if (!d) throw conflict('This request is no longer pending.');
    if (!confirm) return { workspaceId: t.workspaceId, slug: t.workspaceSlug, confirmed: false };
    const ctx = { workspaceId: t.workspaceId, actor: { kind: 'user' as const, id: user.id } };
    const r = await swapOwnership(tx, ctx, d.to_user_id as string, { byStaff: true, reason: d.reason as string });
    await enqueue(tx, t.workspaceId, Queues.sendEmail, { template: 'ownership_transferred', userIds: [d.to_user_id as string, ...r.previousOwners] }, { singletonKey: `owner-transferred:${d.id as string}` });
    return { workspaceId: t.workspaceId, slug: t.workspaceSlug, confirmed: true };
  });
}

/** Next catalogue number: `No. 001` stamp for each SKU (design M4). */
export async function nextCatalogueNo(tx: Tx): Promise<number> {
  const [w] = await tx`update workspaces set next_catalogue_no = next_catalogue_no + 1 returning next_catalogue_no - 1 as no`;
  return Number(w!.no);
}
