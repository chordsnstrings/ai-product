import { NextResponse } from 'next/server';
import { finishOAuth } from '@arkiv/auth';
import { env, geoFromHeaders } from '@arkiv/shared';
import { afterLogin } from '@/lib/after-login';
import { clientIp } from '@/lib/http';
import { clearProvisionalCookie, setSessionCookie } from '@/lib/session';

/** Google returns via GET; Apple posts the form (response_mode=form_post), so both verbs land here. */
async function handle(req: Request, provider: string, params: URLSearchParams) {
  if (provider !== 'google' && provider !== 'apple') return new NextResponse('Not found', { status: 404 });
  const base = env().APP_URL;
  const code = params.get('code');
  const state = params.get('state');
  if (!code || !state) return NextResponse.redirect(`${base}/login?error=${encodeURIComponent(params.get('error') ?? 'cancelled')}`, 303);
  try {
    const r = await finishOAuth(provider, { code, state, user: params.get('user') }, { ip: clientIp(req), userAgent: req.headers.get('user-agent'), geo: geoFromHeaders(req.headers) });
    await setSessionCookie(r.token);
    const next = await afterLogin({ userId: r.userId }, r.provisionalWorkspaceId, r.redirectTo);
    if (r.provisionalWorkspaceId) await clearProvisionalCookie();
    return NextResponse.redirect(`${base}${next}`, 303);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Sign-in failed';
    return NextResponse.redirect(`${base}/login?error=${encodeURIComponent(msg)}`, 303);
  }
}

export async function GET(req: Request, { params }: { params: Promise<{ provider: string }> }) {
  return handle(req, (await params).provider, new URL(req.url).searchParams);
}

export async function POST(req: Request, { params }: { params: Promise<{ provider: string }> }) {
  const form = await req.formData();
  const p = new URLSearchParams();
  for (const [k, v] of form) if (typeof v === 'string') p.set(k, v);
  return handle(req, (await params).provider, p);
}
