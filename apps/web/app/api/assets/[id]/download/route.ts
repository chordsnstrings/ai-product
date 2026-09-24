import { NextResponse } from 'next/server';
import { withTenant } from '@arkiv/db';
import { assetUrl, DELIVERY_HOLD_STATES, recordAssetExport } from '@arkiv/core';
import { DomainError } from '@arkiv/shared';
import { errorResponse } from '@/lib/http';
import { deny, projectAccess } from '@/lib/tenant';

/** Tracked download: records ASSET_EXPORTED (activation, plan 04 L9) then redirects to a signed URL. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const q = new URL(req.url).searchParams;
    const a = await projectAccess(q.get('project') ?? '');
    // Finished work isn't delivered while the workspace is suspended (plan 05 §2.3).
    if (DELIVERY_HOLD_STATES.has(a.ctx.workspaceState)) throw new DomainError('FORBIDDEN', 'This workspace is on hold. Downloads are available again once it is restored.');
    const projectId = q.get('project') ?? '';
    const url = await withTenant(a.ctx.workspaceId, async (tx) => {
      // Plan 02 B9: a refunded ad stays downloadable, unless its payment was refunded as fraudulent.
      const [flagged] = await tx`select 1 from purchases where workspace_id = ${a.ctx.workspaceId} and project_id = ${projectId} and fraud_flagged_at is not null limit 1`;
      if (flagged) throw new DomainError('FORBIDDEN', 'This ad is no longer available for download. Contact support if you think this is a mistake.');
      // Only this project's finished exports: the event carries the project (and variant) it belongs to.
      const exported = await recordAssetExport(tx, a.ctx, id, projectId);
      if (!exported) return null;
      return assetUrl(tx, id, 600, (q.get('name') ?? 'arkiv-ad.mp4').replace(/[^\w.\-]/g, '_'));
    });
    // An asset id that isn't one of this project's exports (another account's, or guessed): denied and logged (§48).
    if (!url) return await deny('asset', id, a.user?.id ?? null);
    return NextResponse.redirect(url, 303);
  } catch (e) {
    return errorResponse(e);
  }
}
