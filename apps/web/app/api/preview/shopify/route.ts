import { NextResponse } from 'next/server';
import { globalTx } from '@arkiv/db';
import { abuseGate, allowKey, assertCan, hit } from '@arkiv/core';
import { shopifyInstallUrl, signState } from '@arkiv/integrations';
import { DomainError, env } from '@arkiv/shared';
import { clientFingerprint, errorResponse } from '@/lib/http';
import { previewContext } from '@/lib/preview-context';

/**
 * "Connect Shopify" on the upload step (standard §13: "Shopify connection must be first-class"; plan 03 P2). No
 * account needed: the store connects to the visitor's preview workspace (created on first use, like any
 * preview) or to a signed-in user's current workspace. The signed state binds the callback to that workspace and
 * to this browser's preview (or user), so a leaked callback URL can't attach a store to someone else's preview.
 */
export async function GET(req: Request) {
  try {
    const client = clientFingerprint(req);
    const gate = await globalTx((tx) => abuseGate(tx, client.ip, [allowKey.ip(client.ip)]));
    if (gate.blocked) throw new DomainError('FORBIDDEN', 'Requests from your network are temporarily blocked. Contact support if you think this is a mistake.', { blocked: true });
    if (client.ip) await hit(`shopify-connect:ip:${client.ip}`, 10, 3600, undefined, { allow: [allowKey.ip(client.ip)] });
    const raw = (new URL(req.url).searchParams.get('shop') ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!raw) throw new DomainError('INVALID', 'Enter your Shopify store address.');
    const shop = raw.includes('.') ? raw : `${raw}.myshopify.com`;
    const ctx = await previewContext(client, { create: true });
    assertCan(ctx, 'integration.manage');
    const state = signState({
      ws: ctx.workspaceId,
      provider: 'shopify',
      preview: '1',
      ...(ctx.actor.kind === 'user' ? { uid: ctx.actor.id } : {}),
    });
    return NextResponse.redirect(shopifyInstallUrl(shop, state), 303);
  } catch (e) {
    // A bad store address comes back to the upload step with the reason, rather than a JSON error page.
    const msg = e instanceof Error ? e.message : 'We couldn’t connect that store.';
    if (e instanceof DomainError && e.code === 'FORBIDDEN') return errorResponse(e);
    return NextResponse.redirect(`${env().APP_URL}/start?${new URLSearchParams({ shopify_error: msg })}`, 303);
  }
}
