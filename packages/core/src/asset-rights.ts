import type { Tx } from '@arkiv/db';
import { DomainError, formatDate } from '@arkiv/shared';
import { assertCan } from './authz';
import type { TenantContext } from './context';
import { emit } from './events';
import { enqueue, Queues } from './outbox';
import { ingestBytes } from './uploads';

/**
 * Creator usage rights (standard §48 "Creator usage rights expire or are revoked: mark the asset unavailable for new
 * production, preserve historical lineage/performance, warn on derivative reuse and offer replacement footage").
 * Expired, frozen (takedown case), held or rejected media never feeds new work — usableAssetIds() filters it out of
 * production inputs; this module refuses derivative reuse with a clear reason, tells the merchant when rights end,
 * and records replacement footage as the successor of what it replaces.
 */

export type UnusableReason = 'rights_expired' | 'rights_frozen' | 'held_for_review' | 'rejected' | 'deleted';

/** Why each of these assets can't go into new work (usable ones are left out). Runs under the caller's RLS. */
export async function unusableAssets(tx: Tx, assetIds: readonly string[]): Promise<{ assetId: string; reason: UnusableReason }[]> {
  if (!assetIds.length) return [];
  const rows = await tx`select id, case when deleted_at is not null then 'deleted'
                                        when rights_frozen_at is not null then 'rights_frozen'
                                        when rights_expires_at <= now() then 'rights_expired'
                                        when review_status = 'pending' then 'held_for_review'
                                        when review_status = 'rejected' then 'rejected' end as reason
                        from assets where id = any(${[...assetIds]}::uuid[])`;
  return rows.filter((r) => r.reason).map((r) => ({ assetId: r.id as string, reason: r.reason as UnusableReason }));
}

const REASON_TEXT: Record<UnusableReason, string> = {
  rights_expired: 'the creator usage rights have expired',
  rights_frozen: 'it is frozen while a rights complaint is reviewed',
  held_for_review: 'it is waiting for compliance review',
  rejected: 'compliance review did not approve it',
  deleted: 'it was deleted',
};

/**
 * Guard for any reuse of existing media in new work (a control ad, and REAL_ASSET_REMIX when it ships): refuses
 * with the reason and the assets concerned, so the UI can offer replacement footage.
 */
export async function assertAssetUsable(tx: Tx, assetIds: readonly string[], what = 'This footage'): Promise<void> {
  const bad = await unusableAssets(tx, assetIds);
  if (!bad.length) return;
  throw new DomainError('CONFLICT', `${what} can’t be used in new ads: ${REASON_TEXT[bad[0]!.reason]}. Add replacement footage to continue; past ads and their results are kept.`, {
    unusable: bad,
    replaceable: bad.some((b) => b.reason === 'rights_expired'),
  });
}

/** The media a creative is made of that its reuse depends on: its final files and the footage it was cut from. */
export async function creativeSourceAssets(tx: Tx, creativeId: string): Promise<string[]> {
  const [c] = await tx`select final_asset_ids, composition from creatives where id = ${creativeId}`;
  if (!c) throw new DomainError('NOT_FOUND', 'Creative not found');
  // Every file a scene was filled with: generated renders carry no usage rights, merchant or creator media does.
  const reused = ((c.composition as { scenes?: { assetId?: string | null }[] } | null)?.scenes ?? []).map((s) => s.assetId).filter((x): x is string => !!x);
  return [...new Set([...((c.final_asset_ids as string[] | null) ?? []), ...reused])];
}

/**
 * Replacement footage for a file whose rights ended (or that was frozen): a new upload of the same kind for the same
 * product, linked as its successor. The old file stays in the archive for lineage and results; it is never edited.
 */
export async function replaceAsset(tx: Tx, ctx: TenantContext, assetId: string, bytes: Buffer, filename: string | null) {
  assertCan(ctx, 'sku.edit');
  const [old] = await tx`select id, kind, sku_id from assets where id = ${assetId} and deleted_at is null`;
  if (!old) throw new DomainError('NOT_FOUND', 'File not found');
  if (!['creator_footage', 'historical_creative', 'product_photo', 'reference_view'].includes(old.kind as string)) throw new DomainError('INVALID', 'Only uploaded footage and photos can be replaced.');
  const next = await ingestBytes(tx, ctx, bytes, old.kind as never, (old.sku_id as string | null) ?? null, { filename, replaces: assetId });
  await tx`update assets set lineage = coalesce(lineage, '{}'::jsonb) || ${tx.json({ replaces: assetId } as never)} where id = ${next.id}`;
  await emit(tx, ctx, 'ASSET_REPLACED', { type: 'asset', id: next.id }, { replaces: assetId });
  return { assetId: next.id };
}

/**
 * Daily (system role): media whose usage rights ended and that hasn't been reported yet gets ASSET_RIGHTS_EXPIRED
 * (per asset, once — the event is the record) and one email per product to the owners and admins. Every predicate
 * names the row's own workspace: system_rw sees every tenant.
 */
export async function sweepExpiredRights(tx: Tx): Promise<number> {
  const rows = await tx`
    select a.id, a.workspace_id, a.sku_id, a.rights_expires_at from assets a
    where a.rights_expires_at <= now() and a.deleted_at is null
      and not exists (select 1 from events e where e.workspace_id = a.workspace_id and e.subject_id = a.id and e.type = 'ASSET_RIGHTS_EXPIRED')
    order by a.rights_expires_at limit 500`;
  const bySku = new Map<string, { workspaceId: string; skuId: string | null; ids: string[]; expiredOn: string }>();
  for (const r of rows) {
    const ws = r.workspace_id as string;
    const ctx = { workspaceId: ws, actor: { kind: 'system' as const, id: 'rights-expiry' } };
    await emit(tx, ctx, 'ASSET_RIGHTS_EXPIRED', { type: 'asset', id: r.id as string }, { expiredAt: new Date(r.rights_expires_at as string).toISOString() });
    const key = `${ws}:${(r.sku_id as string | null) ?? '-'}`;
    const g = bySku.get(key) ?? { workspaceId: ws, skuId: (r.sku_id as string | null) ?? null, ids: [], expiredOn: formatDate(r.rights_expires_at as string) };
    g.ids.push(r.id as string);
    bySku.set(key, g);
  }
  for (const g of bySku.values()) {
    await enqueue(tx, g.workspaceId, Queues.sendEmail, { template: 'rights_expired', skuId: g.skuId, assetIds: g.ids, expiredOn: g.expiredOn }, { singletonKey: `rights-expired:${g.ids[0]}` });
  }
  return rows.length;
}
