import { NextResponse } from 'next/server';
import { withTenant, globalTx } from '@arkiv/db';
import { registerShopifyWebhooks, saveIntegration, shopTransferProof, stashPendingConnection } from '@arkiv/core';
import { metaExchangeCode, shopifyExchangeCode, tiktokExchangeCode, verifyShopifyQuery, verifyState } from '@arkiv/integrations';
import { DomainError, env, type Role, type WorkspaceState } from '@arkiv/shared';
import { logger } from '@arkiv/shared/log';

const log = logger('oauth-callback');
import { currentUser } from '@/lib/session';
import { clientFingerprint } from '@/lib/http';
import { previewContext } from '@/lib/preview-context';

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
  // "Connect Shopify" from the upload step (plan 03 P2): the store joins the preview it was started from.
  if (st.preview === '1' && provider === 'shopify') return previewShopifyCallback(req, q, st);
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
      try {
        await withTenant(ctx.workspaceId, (tx) => saveIntegration(tx, ctx, { provider: 'shopify', externalAccountId: shop, displayName: shop, token: tok.accessToken, scopes: tok.scopes }));
      } catch (e) {
        // The store is routed to another workspace (plan 02 §3 layer 8): this OAuth is the requester's proof of
        // control, carried (signed, short-lived, without the token) to the "Request transfer" prompt.
        if (e instanceof DomainError && e.code === 'CONFLICT' && e.details?.transfer) {
          const proof = shopTransferProof({ shop, workspaceId: ctx.workspaceId, userId: user.userId, scopes: tok.scopes });
          return NextResponse.redirect(`${env().APP_URL}/w/${st.slug}/settings/integrations?${new URLSearchParams({ result: e.message, transfer: proof })}`, 303);
        }
        throw e;
      }
      // Product webhooks now (§28 "re-sync on webhook"); the nightly check repairs a registration that fails here.
      await registerShopifyWebhooks(shop, tok.accessToken).catch((err: unknown) => log.warn('webhook registration failed', { shop, err }));
      return back(st.slug!, 'Shopify connected. Importing products…');
    }
    if (!q.code && !q.auth_code) return back(st.slug!, q.error_description ?? 'Connection cancelled.');
    const r = provider === 'meta' ? await metaExchangeCode(q.code!) : await tiktokExchangeCode(q.auth_code ?? q.code!);
    if (!r.accounts.length) return back(st.slug!, 'No ad accounts found on that login.');
    const label = provider === 'meta' ? 'Meta' : 'TikTok';
    if (r.accounts.length === 1) {
      const a = r.accounts[0]!;
      await withTenant(ctx.workspaceId, (tx) =>
        saveIntegration(tx, ctx, {
          provider: provider as 'meta' | 'tiktok',
          externalAccountId: a.id,
          displayName: a.name,
          token: r.accessToken,
          // The permissions actually granted (§27), so a declined one shows as unavailable features.
          scopes: r.scopes,
          currency: a.currency,
          timezone: a.timezone,
          platformUserId: r.platformUserId,
          tokenExpiresAt: r.expiresAt,
        }),
      );
      return back(st.slug!, `${label} connected (${a.name}). First sync running.`);
    }
    // Several readable accounts (an agency login can read other brands'): nothing is connected until the merchant
    // picks which belong to this workspace (§47 "Wrong ad account selected").
    const pendingId = await withTenant(ctx.workspaceId, (tx) => stashPendingConnection(tx, ctx, provider as 'meta' | 'tiktok', r.accessToken, r.accounts, r.platformUserId, { scopes: r.scopes, expiresAt: r.expiresAt }));
    return NextResponse.redirect(`${env().APP_URL}/w/${st.slug}/settings/integrations?${new URLSearchParams({ pick: pendingId })}`, 303);
  } catch (e) {
    return back(st.slug!, e instanceof Error ? e.message : 'Connection failed.');
  }
}

/**
 * The upload-step Shopify connection: only the browser (preview cookie) or the signed-in user that started it can
 * finish it, into the workspace it was started for. The store is then offered as a product picker (/start/shopify)
 * — an unsaved preview never imports the whole catalogue.
 */
async function previewShopifyCallback(req: Request, q: Record<string, string>, st: Record<string, string>) {
  const retry = (msg: string) => NextResponse.redirect(`${env().APP_URL}/start?${new URLSearchParams({ shopify_error: msg })}`, 303);
  try {
    const ctx = await previewContext(clientFingerprint(req), { create: false });
    const sameActor = st.uid ? ctx.actor.kind === 'user' && ctx.actor.id === st.uid : ctx.actor.kind === 'provisional';
    if (ctx.workspaceId !== st.ws || !sameActor) return retry('That connection was started in another browser. Please connect your store again.');
    if (!verifyShopifyQuery(q)) return retry('Shopify signature check failed. Try again.');
    const shop = q.shop!;
    const tok = await shopifyExchangeCode(shop, q.code!);
    await withTenant(ctx.workspaceId, (tx) => saveIntegration(tx, ctx, { provider: 'shopify', externalAccountId: shop, displayName: shop, token: tok.accessToken, scopes: tok.scopes }));
    await registerShopifyWebhooks(shop, tok.accessToken).catch((err: unknown) => log.warn('webhook registration failed', { shop, err }));
    return NextResponse.redirect(`${env().APP_URL}/start/shopify`, 303);
  } catch (e) {
    return retry(e instanceof DomainError || e instanceof Error ? e.message : 'We couldn’t connect that store.');
  }
}
