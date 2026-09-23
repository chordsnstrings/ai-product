import { createHash, randomBytes } from 'node:crypto';
import { globalTx, withSystem, withTenant, type Tx } from '@arkiv/db';
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
import { assertCan } from './authz';
import type { TenantContext } from './context';
import { emit } from './events';
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
  const [w] = await tx`select state, state_before_hold from workspaces where id = ${ctx.workspaceId} for update`;
  if (!w) throw notFound('Workspace not found');
  const from = w.state as WorkspaceState;
  if (from === to) return from;
  const liftingHold = (from === 'SUSPENDED' || from === 'LOCKED') && to === (w.state_before_hold as WorkspaceState);
  if (!liftingHold && !TRANSITIONS[from].includes(to)) throw conflict(`Cannot move workspace from ${from} to ${to}`);
  const holding = to === 'SUSPENDED' || to === 'LOCKED';
  await tx`
    update workspaces set state = ${to}, state_reason = ${reason},
      state_before_hold = ${holding ? from : null},
      cancelled_at = case when ${to} = 'CANCELLED' then now() else cancelled_at end
    where id = ${ctx.workspaceId}`;
  await emit(tx, ctx, 'WORKSPACE_STATE_CHANGED', { type: 'workspace', id: ctx.workspaceId }, { from, to, reason });
  return to;
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
export async function createProvisionalWorkspace(): Promise<{ workspaceId: string; token: string }> {
  const workspaceId = newId();
  const token = randomToken();
  const slug = `p-${randomBytes(5).toString('hex')}`;
  await withTenant(workspaceId, async (tx) => {
    await tx`insert into workspaces (id, slug, name, state, provisional_token_hash, provisional_expires_at)
             values (${workspaceId}, ${slug}, 'Your brand', 'PROVISIONAL', ${sha256(token)},
                     now() + make_interval(days => ${PROVISIONAL.TTL_DAYS}))`;
    await tx`insert into brands (workspace_id, name) values (${workspaceId}, 'Your brand')`;
    await emit(tx, { workspaceId, actor: { kind: 'provisional', id: workspaceId } }, 'WORKSPACE_CREATED', { type: 'workspace', id: workspaceId }, { provisional: true });
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
 */
export async function moveProvisionalSkus(fromWorkspaceId: string, toWorkspaceId: string, userId: string): Promise<number> {
  const [m] = await globalTx((tx) => tx`select * from list_user_workspaces(${userId}) where workspace_id = ${toWorkspaceId}`);
  if (!m || !['OWNER', 'ADMIN', 'MEMBER'].includes(m.role as string)) throw forbidden();
  return withSystem(async (tx) => {
    const [src] = await tx`select state from workspaces where id = ${fromWorkspaceId} for update`;
    if (!src || src.state !== 'PROVISIONAL') throw conflict('Nothing to move');
    const skus = await tx`select id from skus where workspace_id = ${fromWorkspaceId} order by catalogue_no`;
    for (const s of skus) {
      const [n] = await tx`update workspaces set next_catalogue_no = next_catalogue_no + 1 where id = ${toWorkspaceId}
                            returning next_catalogue_no - 1 as no`;
      await tx`update skus set brand_id = null where id = ${s.id}`;
      await tx`update skus set workspace_id = ${toWorkspaceId}, catalogue_no = ${n!.no} where id = ${s.id}`;
    }
    // Storage keys embed the tenant prefix; copy moved objects so purging the old prefix cannot delete them.
    const moved = await tx`select id, storage_key, mime from assets where workspace_id = ${toWorkspaceId}
                           and storage_key like ${`t/${fromWorkspaceId}/%`}`;
    for (const a of moved) {
      const newKey = (a.storage_key as string).replace(`t/${fromWorkspaceId}/`, `t/${toWorkspaceId}/`);
      await storage().put(newKey, await storage().get(a.storage_key as string), a.mime as string);
      await tx`update assets set storage_key = ${newKey} where id = ${a.id}`;
    }
    await tx`update workspaces set state = 'PURGE_SCHEDULED', purge_at = now(), provisional_token_hash = null
             where id = ${fromWorkspaceId}`;
    return skus.length;
  });
}

// ───────────── Limits ─────────────

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
  const [w] = await tx`select plan_code from workspaces where id = ${ctx.workspaceId}`;
  const lim = limitsFor(w?.plan_code as PlanCode | null);
  const [c] = await tx`select (select count(*) from memberships) + (select count(*) from invites where accepted_at is null
                         and revoked_at is null and expires_at > now()) as n`;
  if (Number(c!.n) >= lim.members) throw new DomainError('PAYMENT_REQUIRED', `Your plan includes ${lim.members} members. Upgrade to invite more.`);
  const [existing] = await tx`select 1 from memberships m join users u on u.id = m.user_id where u.email = ${normalized}`;
  if (existing) throw conflict('That person is already a member');
  const token = randomToken();
  await tx`update invites set revoked_at = now() where email = ${normalized} and accepted_at is null and revoked_at is null`;
  const [inv] = await tx`
    insert into invites (workspace_id, email, role, token_hash, invited_by, expires_at)
    values (${ctx.workspaceId}, ${normalized}, ${role}, ${sha256(token)}, ${ctx.actor.kind === 'user' ? ctx.actor.id : null},
            now() + interval '7 days') returning id`;
  return { inviteId: inv!.id as string, token };
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

export async function changeRole(tx: Tx, ctx: TenantContext, userId: string, role: Role) {
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

export async function transferOwnership(tx: Tx, ctx: TenantContext, toUserId: string) {
  assertCan(ctx, 'workspace.transfer');
  const [t] = await tx`select role from memberships where user_id = ${toUserId}`;
  if (!t) throw notFound('New owner must already be a member');
  await tx`update memberships set role = 'OWNER' where user_id = ${toUserId}`;
  if (ctx.actor.kind === 'user') await tx`update memberships set role = 'ADMIN' where user_id = ${ctx.actor.id}`;
  await tx`update workspaces set membership_version = membership_version + 1 where id = ${ctx.workspaceId}`;
  await emit(tx, ctx, 'MEMBER_ROLE_CHANGED', { type: 'user', id: toUserId }, { to: 'OWNER', transfer: true });
}

/** Next catalogue number: `No. 001` stamp for each SKU (design M4). */
export async function nextCatalogueNo(tx: Tx): Promise<number> {
  const [w] = await tx`update workspaces set next_catalogue_no = next_catalogue_no + 1 returning next_catalogue_no - 1 as no`;
  return Number(w!.no);
}
