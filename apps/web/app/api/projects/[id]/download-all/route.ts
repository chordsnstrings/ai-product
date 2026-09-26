import { withTenant } from '@arkiv/db';
import { deliveryBundle, DELIVERY_HOLD_STATES } from '@arkiv/core';
import { DomainError } from '@arkiv/shared';
import { errorResponse } from '@/lib/http';
import { projectAccess } from '@/lib/tenant';

/**
 * P10 "Download all" (plan 03 P10): every finished export of this ad in one zip. The same holds as a single
 * download apply — a suspended workspace or a payment refunded as fraudulent gets nothing — and each file is
 * recorded as exported.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const a = await projectAccess(id);
    if (DELIVERY_HOLD_STATES.has(a.ctx.workspaceState)) throw new DomainError('FORBIDDEN', 'This workspace is on hold. Downloads are available again once it is restored.');
    const bundle = await withTenant(a.ctx.workspaceId, async (tx) => {
      const [flagged] = await tx`select 1 from purchases where workspace_id = ${a.ctx.workspaceId} and project_id = ${id} and fraud_flagged_at is not null limit 1`;
      if (flagged) throw new DomainError('FORBIDDEN', 'This ad is no longer available for download. Contact support if you think this is a mistake.');
      return deliveryBundle(tx, a.ctx, id);
    });
    if (!bundle) throw new DomainError('NOT_FOUND', 'This ad has no files to download yet.');
    return new Response(Buffer.from(bundle.zip), {
      headers: {
        'content-type': 'application/zip',
        'content-disposition': 'attachment; filename="arkiv-ad.zip"',
        'cache-control': 'private, no-store',
      },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
