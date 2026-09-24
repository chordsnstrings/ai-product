import { NextResponse } from 'next/server';
import { assertRecentLogin, safeRedirect, startOAuth } from '@arkiv/auth';
import { DomainError, env } from '@arkiv/shared';
import { currentUser, setOAuthBindingCookie } from '@/lib/session';

/**
 * Profile → "Connect Google/Apple" (plan 03 Part C: "the Apple relay email differs from the Google email → two
 * users unless linked from Profile"). Adds the provider identity to the signed-in user; it needs a recent sign-in,
 * since a connected identity can sign in to the account from then on.
 */
export async function GET(req: Request, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  if (provider !== 'google' && provider !== 'apple') return new NextResponse('Not found', { status: 404 });
  const base = env().APP_URL;
  const back = safeRedirect(new URL(req.url).searchParams.get('next')) ?? '/app';
  const u = await currentUser();
  if (!u) return NextResponse.redirect(`${base}/login?next=${encodeURIComponent(back)}`, 303);
  const sep = back.includes('?') ? '&' : '?';
  try {
    assertRecentLogin(u);
    const { url, binding } = await startOAuth(provider, { redirectTo: back, linkUserId: u.userId });
    await setOAuthBindingCookie(provider, binding);
    return NextResponse.redirect(url, 303);
  } catch (e) {
    if (e instanceof DomainError && (e.details as { stepUp?: boolean } | undefined)?.stepUp) return NextResponse.redirect(`${base}${back}${sep}stepup=1`, 303);
    const msg = e instanceof DomainError ? e.message : 'Connecting isn’t available right now.';
    return NextResponse.redirect(`${base}${back}${sep}error=${encodeURIComponent(msg)}`, 303);
  }
}
