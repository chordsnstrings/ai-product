import { NextResponse } from 'next/server';
import { assertLoginBudget, safeRedirect, startOAuth } from '@arkiv/auth';
import { resolveProvisional } from '@arkiv/core';
import { DomainError, env } from '@arkiv/shared';
import { clientIp } from '@/lib/http';
import { provisionalToken, setOAuthBindingCookie } from '@/lib/session';

/**
 * Start Google/Apple sign-in. A top-level navigation, so failures go back to /login with a readable message rather
 * than a JSON body; past the per-IP sign-in budget the login page shows the human check (`challenge=1`).
 */
export async function GET(req: Request, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  if (provider !== 'google' && provider !== 'apple') return new NextResponse('Not found', { status: 404 });
  const q = new URL(req.url).searchParams;
  const next = safeRedirect(q.get('next'));
  try {
    await assertLoginBudget(clientIp(req), q.get('turnstile'));
    const { url, binding } = await startOAuth(provider, { redirectTo: next, provisionalWorkspaceId: await resolveProvisional(await provisionalToken()) });
    await setOAuthBindingCookie(provider, binding);
    return NextResponse.redirect(url, 303);
  } catch (e) {
    const msg = e instanceof DomainError ? e.message : 'Sign-in isn’t available right now. Use your email instead.';
    const challenge = e instanceof DomainError && (e.details as { challenge?: boolean } | undefined)?.challenge;
    const back = new URLSearchParams({ error: msg, ...(next ? { next } : {}), ...(challenge ? { challenge: '1' } : {}) });
    return NextResponse.redirect(`${env().APP_URL}/login?${back}`, 303);
  }
}
