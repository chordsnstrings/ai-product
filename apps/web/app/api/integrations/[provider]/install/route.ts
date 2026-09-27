import { NextResponse } from 'next/server';
import { env } from '@arkiv/shared';
import { acceptShopifyLaunch, SHOPIFY_INSTALL_COOKIE, SHOPIFY_INSTALL_TTL_S } from '@/lib/shopify-install';

/**
 * The Shopify app URL (plan 06 Phase 5 #1 "Shopify app"; plan 05 §16 listing): an install from the App Store, or the
 * app opened from the merchant's Shopify admin, lands here with a signed `shop`. A genuine, recent launch is kept
 * in a short-lived signed cookie and the merchant goes on to sign in and choose the workspace the store belongs
 * to; the OAuth itself starts from there, bound to that workspace and user. Anything else is refused.
 */
export async function GET(req: Request, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  if (provider !== 'shopify') return new NextResponse('Not found', { status: 404 });
  const launch = acceptShopifyLaunch(Object.fromEntries(new URL(req.url).searchParams));
  if (!launch) return NextResponse.redirect(`${env().APP_URL}/connect/shopify?error=invalid`, 303);
  const res = NextResponse.redirect(`${env().APP_URL}${launch.next}`, 303);
  res.cookies.set(SHOPIFY_INSTALL_COOKIE, launch.cookie, { httpOnly: true, secure: env().NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: SHOPIFY_INSTALL_TTL_S });
  return res;
}
