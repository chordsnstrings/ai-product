import { NextResponse } from 'next/server';
import { withTenant } from '@arkiv/db';
import { assetUrl, emit, recordFunnel } from '@arkiv/core';
import { errorResponse } from '@/lib/http';
import { projectAccess } from '@/lib/tenant';

/** Tracked download: records ASSET_EXPORTED (activation, plan 04 L9) then redirects to a signed URL. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const q = new URL(req.url).searchParams;
    const a = await projectAccess(q.get('project') ?? '');
    const url = await withTenant(a.ctx.workspaceId, async (tx) => {
      const [asset] = await tx`select id, lineage from assets where id = ${id}`;
      if (!asset) throw new Error('not found');
      await emit(tx, a.ctx, 'ASSET_EXPORTED', { type: 'asset', id }, { aspect: (asset.lineage as { aspect?: string })?.aspect ?? null });
      await recordFunnel('ASSET_EXPORTED', { workspaceId: a.ctx.workspaceId, props: { aspect: (asset.lineage as { aspect?: string })?.aspect ?? null } }, tx);
      return assetUrl(tx, id, 600, (q.get('name') ?? 'arkiv-ad.mp4').replace(/[^\w.\-]/g, '_'));
    });
    return NextResponse.redirect(url, 303);
  } catch (e) {
    return errorResponse(e);
  }
}
