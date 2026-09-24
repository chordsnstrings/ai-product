import { NextResponse } from 'next/server';
import { withTenant, globalTx } from '@arkiv/db';
import { saveIntegration, stashPendingConnection } from '@arkiv/core';
import { metaExchangeCode, shopifyExchangeCode, tiktokExchangeCode, verifyShopifyQuery, verifyState } from '@arkiv/integrations';
import { env, type Role, type WorkspaceState } from '@arkiv/shared';
import { currentUser } from '@/lib/session';

/**
 * OAuth callback for Shopify / Meta / TikTok. The state must verify AND the signed-in user must still be an
 * admin of that workspace — a leaked callback URL can't attach an account to someone else's workspace.
 */
export async function GET(req: Request, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  const url = new URL(req.url);
  const q = Object.fromEntries(url.searchParams);
  const st = verifyState(q.state ?? '');
  const back = (slug: string, msg: string) => NextResponse.redirect(`${env().APP_URL}/w/${slug}/settings/integrations?${new URLSearchParams({ result: msg })}`, 303);
  if (!st || st.provider !== provider) return NextResponse.redirect(`${env().APP_URL}/app?error=connection_expired`, 303);
  const user = await currentUser();
  if (!user || user.userId !== st.uid) return NextResponse.redirect(`${env().APP_URL}/login?next=${encodeURIComponent(`/w/${st.slug}/settings/integrations`)}`, 303);
  const [m] = await globalTx((tx) => tx`select * from list_user_workspaces(${user.userId}) where workspace_id = ${st.ws!}`);
  if (!m || !['OWNER', 'ADMIN'].includes(m.role as string)) return back(st.slug!, 'Only owners and admins can connect accounts.');
  const ctx = { workspaceId: st.ws!, workspaceState: m.state as WorkspaceState, role: m.role as Role, actor: { kind: 'user' as const, id: user.userId }, requestId: crypto.randomUUID() };
  try {
    if (provider === 'shopify') {
      if (!verifyShopifyQuery(q)) return back(st.slug!, 'Shopify signature check failed. Try again.');
      const shop = q.shop!;
      const tok = await shopifyExchangeCode(shop, q.code!);
      await withTenant(ctx.workspaceId, (tx) => saveIntegration(tx, ctx, { provider: 'shopify', externalAccountId: shop, displayName: shop, token: tok.accessToken, scopes: tok.scopes }));
      return back(st.slug!, 'Shopify connected. Importing products…');
    }
    if (!q.code && !q.auth_code) return back(st.slug!, q.error_description ?? 'Connection cancelled.');
    const r = provider === 'meta' ? await metaExchangeCode(q.code!) : await tiktokExchangeCode(q.auth_code ?? q.code!);
    if (!r.accounts.length) return back(st.slug!, 'No ad accounts found on that login.');
    const label = provider === 'meta' ? 'Meta' : 'TikTok';
    if (r.accounts.length === 1) {
      const a = r.accounts[0]!;
      await withTenant(ctx.workspaceId, (tx) =>
        saveIntegration(tx, ctx, { provider: provider as 'meta' | 'tiktok', externalAccountId: a.id, displayName: a.name, token: r.accessToken, scopes: ['ads_read'], currency: a.currency, timezone: a.timezone, platformUserId: r.platformUserId }),
      );
      return back(st.slug!, `${label} connected (${a.name}). First sync running.`);
    }
    // Several readable accounts (an agency login can read other brands'): nothing is connected until the merchant
    // picks which belong to this workspace (§47 "Wrong ad account selected").
    const pendingId = await withTenant(ctx.workspaceId, (tx) => stashPendingConnection(tx, ctx, provider as 'meta' | 'tiktok', r.accessToken, r.accounts, r.platformUserId));
    return NextResponse.redirect(`${env().APP_URL}/w/${st.slug}/settings/integrations?${new URLSearchParams({ pick: pendingId })}`, 303);
  } catch (e) {
    return back(st.slug!, e instanceof Error ? e.message : 'Connection failed.');
  }
}
