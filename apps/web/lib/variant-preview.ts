import type { Tx } from '@arkiv/db';
import { assetUrl } from '@arkiv/core';
import type { PlatformAsset } from '@arkiv/shared';

/**
 * A variant's 9:16 cut as a short-lived signed URL without a download name, so it plays inline in a video
 * thumbnail (design §2.4). Tenant-scoped: callers pass their withTenant transaction.
 */
export async function variantPreviewUrl(tx: Tx, v: { platform_assets?: unknown; creative_id?: unknown; project_id?: unknown }): Promise<string | null> {
  const tall = ((v.platform_assets as PlatformAsset[] | null) ?? []).find((pa) => pa.aspect === '9x16');
  if (tall) return assetUrl(tx, tall.assetId, 3600);
  const creativeId = (v.creative_id as string | null) ?? (v.project_id ? ((await tx`select final_creative_id from projects where id = ${v.project_id as string}`)[0]?.final_creative_id as string | null) : null);
  if (!creativeId) return null;
  const [cr] = await tx`select final_asset_ids from creatives where id = ${creativeId}`;
  const ids = (cr?.final_asset_ids as string[] | null) ?? [];
  if (!ids.length) return null;
  const [a] = await tx`select id from assets where id in ${tx(ids)} and lineage->>'aspect' = '9x16' and deleted_at is null limit 1`;
  return a ? assetUrl(tx, a.id as string, 3600) : null;
}
