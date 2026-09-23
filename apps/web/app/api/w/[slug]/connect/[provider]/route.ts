import { NextResponse } from 'next/server';
import { assertCan } from '@arkiv/core';
import { metaAuthUrl, shopifyInstallUrl, signState, tiktokAuthUrl } from '@arkiv/integrations';
import { errorResponse } from '@/lib/http';
import { workspaceBySlug } from '@/lib/tenant';

/** Start an OAuth connection. The signed state binds the callback to this workspace + user (plan 02 layer 8). */
export async function GET(req: Request, { params }: { params: Promise<{ slug: string; provider: string }> }) {
  try {
    const { slug, provider } = await params;
    const w = await workspaceBySlug(slug);
    assertCan(w.ctx, 'integration.manage');
    const state = signState({ ws: w.ctx.workspaceId, uid: w.user!.id, slug, provider });
    if (provider === 'shopify') {
      const shop = (new URL(req.url).searchParams.get('shop') ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
      return NextResponse.redirect(shopifyInstallUrl(shop.includes('.') ? shop : `${shop}.myshopify.com`, state));
    }
    if (provider === 'meta') return NextResponse.redirect(metaAuthUrl(state));
    if (provider === 'tiktok') return NextResponse.redirect(tiktokAuthUrl(state));
    return new NextResponse('Not found', { status: 404 });
  } catch (e) {
    return errorResponse(e);
  }
}
