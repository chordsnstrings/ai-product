import { NextResponse } from 'next/server';
import { withTenant } from '@arkiv/db';
import { assetUrl, DELIVERY_HOLD_STATES, emit, projectVisitor, recordFunnel } from '@arkiv/core';
import { DomainError } from '@arkiv/shared';
import { errorResponse } from '@/lib/http';
import { projectAccess } from '@/lib/tenant';

/** Tracked download: records ASSET_EXPORTED (activation, plan 04 L9) then redirects to a signed URL. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const q = new URL(req.url).searchParams;
    const a = await projectAccess(q.get('project') ?? '');
    // Finished work isn't delivered while the workspace is suspended (plan 05 §2.3).
    if (DELIVERY_HOLD_STATES.has(a.ctx.workspaceState)) throw new DomainError('FORBIDDEN', 'This workspace is on hold. Downloads are available again once it is restored.');
    const url = await withTenant(a.ctx.workspaceId, async (tx) => {
      const [asset] = await tx`select id, lineage from assets where id = ${id}`;
      if (!asset) throw new Error('not found');
      await emit(tx, a.ctx, 'ASSET_EXPORTED', { type: 'asset', id }, { aspect: (asset.lineage as { aspect?: string })?.aspect ?? null });
      const visitorId = await projectVisitor(tx, a.ctx.workspaceId, q.get('project') ?? '');
      await recordFunnel('ASSET_EXPORTED', { workspaceId: a.ctx.workspaceId, visitorId, props: { aspect: (asset.lineage as { aspect?: string })?.aspect ?? null } }, tx);
      return assetUrl(tx, id, 600, (q.get('name') ?? 'arkiv-ad.mp4').replace(/[^\w.\-]/g, '_'));
    });
    return NextResponse.redirect(url, 303);
  } catch (e) {
    return errorResponse(e);
  }
}
