import type { Tx } from '@arkiv/db';
import { signState, verifyState } from '@arkiv/integrations';
import { DomainError } from '@arkiv/shared';
import type { Staff } from './admin';
import { staffCtx } from './admin';
import { assertCan } from './authz';
import { actorString, type TenantContext } from './context';
import { emit } from './events';

/**
 * Shopify store transfer (plan 02 §3 layer 8, plan 06 Phase 5 #1): a store is routed to one workspace. Another
 * workspace that completes a Shopify OAuth for it may request a transfer; the current workspace's Owner approves
 * or rejects it, or staff approve it once it has waited SHOP_TRANSFER_STAFF_DAYS with that OAuth as proof.
 * Approval releases the store (its connection is disconnected; past data stays); the requester then connects it
 * again, which is a fresh authorization by the store.
 */

export const SHOP_TRANSFER_STAFF_DAYS = 14;

/**
 * Proof the requester completed a Shopify OAuth for the shop (issued by the OAuth callback when the store turned
 * out to be connected elsewhere). Signed and short-lived; never carries the access token.
 */
export function shopTransferProof(input: { shop: string; workspaceId: string; userId: string; scopes: string[] }): string {
  return signState({ kind: 'shop_transfer', shop: input.shop, ws: input.workspaceId, uid: input.userId, scopes: input.scopes.join(','), at: new Date().toISOString() });
}

export function readShopTransferProof(token: string): { shop: string; workspaceId: string; userId: string; scopes: string[]; at: string } | null {
  const p = verifyState(token);
  if (!p || p.kind !== 'shop_transfer' || !p.shop || !p.ws || !p.uid) return null;
  return { shop: p.shop, workspaceId: p.ws, userId: p.uid, scopes: (p.scopes ?? '').split(',').filter(Boolean), at: p.at ?? '' };
}

/** File the request (the current owner's workspace is emailed). Returns its id. */
export async function requestShopTransfer(tx: Tx, ctx: TenantContext, proofToken: string, requesterEmail: string): Promise<string> {
  assertCan(ctx, 'integration.manage');
  const proof = readShopTransferProof(proofToken);
  if (!proof || proof.workspaceId !== ctx.workspaceId || ctx.actor.kind !== 'user' || proof.userId !== ctx.actor.id) {
    throw new DomainError('FORBIDDEN', 'That transfer link expired. Connect the store again to request a transfer.');
  }
  const [r] = await tx`select shop_transfer_request(${proof.shop}, ${ctx.actor.id}, ${requesterEmail},
                         ${tx.json({ oauth: 'shopify', oauthAt: proof.at, scopes: proof.scopes } as never)}) as id`;
  if (!r?.id) throw new DomainError('CONFLICT', 'That store is no longer connected to another workspace. Connect it again.');
  return r.id as string;
}

export interface ShopTransfer {
  id: string;
  shop: string;
  status: string;
  direction: 'incoming' | 'outgoing';
  requester: string;
  createdAt: string;
  decidedAt: string | null;
}

const mask = (email: string) => {
  const [local, domain] = email.split('@');
  return domain ? `${(local ?? '').slice(0, 1)}•••@${domain}` : '•••';
};

/** This workspace's transfer requests: ones it made (outgoing) and ones for its stores (incoming). */
export async function listShopTransfers(tx: Tx, workspaceId: string): Promise<ShopTransfer[]> {
  const rows = await tx`select id, shop_domain, status, workspace_id, from_workspace_id, requester_email, created_at, decided_at from shop_transfer_requests
                        where created_at > now() - interval '90 days' order by created_at desc limit 50`;
  return rows.map((r) => ({
    id: r.id as string,
    shop: r.shop_domain as string,
    status: r.status as string,
    direction: r.from_workspace_id === workspaceId ? 'incoming' : 'outgoing',
    // The current owner sees who asked only as a masked address (the requester is another tenant).
    requester: r.from_workspace_id === workspaceId ? mask(r.requester_email as string) : (r.requester_email as string),
    createdAt: new Date(r.created_at as string).toISOString(),
    decidedAt: r.decided_at ? new Date(r.decided_at as string).toISOString() : null,
  }));
}

/** Release the store from the owning workspace: its Shopify connection is disconnected and routing removed. */
async function releaseShop(tx: Tx, ctx: Pick<TenantContext, 'workspaceId' | 'actor'>, workspaceId: string, shop: string, reason: string) {
  const conns = await tx`update integrations set status = 'disconnected', token_enc = null, refresh_token_enc = null
                         where workspace_id = ${workspaceId} and provider = 'shopify' and external_account_id = ${shop} and status <> 'disconnected' returning id`;
  await tx`delete from shopify_shops where shop_domain = ${shop} and workspace_id = ${workspaceId}`;
  for (const c of conns) await emit(tx, ctx, 'INTEGRATION_DISCONNECTED', { type: 'integration', id: c.id as string }, { provider: 'shopify', reason });
}

/**
 * The current owner decides (Owner role only: moving the store changes where its data goes). Approval releases
 * the store and closes other workspaces' pending requests for it.
 */
export async function decideShopTransfer(tx: Tx, ctx: TenantContext, requestId: string, decision: 'approve' | 'reject'): Promise<void> {
  assertCan(ctx, 'integration.manage');
  if (ctx.role !== 'OWNER') throw new DomainError('FORBIDDEN', 'Only the workspace owner can decide a store transfer.');
  const [r] = await tx`select id, shop_domain, status from shop_transfer_requests where id = ${requestId} and from_workspace_id = ${ctx.workspaceId} for update`;
  if (!r) throw new DomainError('NOT_FOUND', 'Transfer request not found');
  if (r.status !== 'pending') throw new DomainError('CONFLICT', `This request was already ${r.status as string}.`);
  await tx`update shop_transfer_requests set status = ${decision === 'approve' ? 'approved' : 'rejected'}, decided_by = ${actorString(ctx)}, decided_at = now()
           where id = ${requestId}`;
  if (decision === 'approve') {
    await releaseShop(tx, ctx, ctx.workspaceId, r.shop_domain as string, 'shop_transfer');
    await tx`update shop_transfer_requests set status = 'cancelled', decided_by = ${actorString(ctx)}, decided_at = now(), decision_note = 'The store went to another request.'
             where from_workspace_id = ${ctx.workspaceId} and shop_domain = ${r.shop_domain as string} and status = 'pending' and id <> ${requestId}`;
  }
}

/**
 * Staff approval (admin console, audited by the caller): only for a request pending at least
 * SHOP_TRANSFER_STAFF_DAYS whose requester proved control of the store with a Shopify OAuth. Admin role.
 */
export async function staffApproveShopTransfer(tx: Tx, s: Staff, requestId: string, note: string) {
  const [r] = await tx`select id, shop_domain, status, from_workspace_id, workspace_id, proof, created_at < now() - make_interval(days => ${SHOP_TRANSFER_STAFF_DAYS}) as waited
                       from shop_transfer_requests where id = ${requestId} for update`;
  if (!r) throw new DomainError('NOT_FOUND', 'Transfer request not found');
  if (r.status !== 'pending') throw new DomainError('CONFLICT', `This request was already ${r.status as string}.`);
  if (!r.waited) throw new DomainError('CONFLICT', `Staff can approve a transfer only after ${SHOP_TRANSFER_STAFF_DAYS} days without the owner’s decision.`);
  if (!(r.proof as { oauthAt?: string } | null)?.oauthAt) throw new DomainError('CONFLICT', 'This request has no proof of a Shopify sign-in by the store.');
  const from = r.from_workspace_id as string;
  await tx`update shop_transfer_requests set status = 'approved', decided_by = ${`staff:${s.staffId}`}, decided_at = now(), decision_note = ${note} where id = ${requestId}`;
  await releaseShop(tx, staffCtx(s, from), from, r.shop_domain as string, 'shop_transfer_staff');
  return { shop: r.shop_domain as string, fromWorkspaceId: from, toWorkspaceId: r.workspace_id as string };
}
