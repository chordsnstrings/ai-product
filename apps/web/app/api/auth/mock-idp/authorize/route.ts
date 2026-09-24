import { NextResponse } from 'next/server';
import { MOCK_IDENTITIES, mockAuthorize, mockIdpEnabled, type MockIdentity } from '@arkiv/auth';
import { env } from '@arkiv/shared';

/**
 * The mock identity provider's "sign in" button (PROVIDERS_MODE=mock only; see @arkiv/auth mock-idp.ts). Issues a
 * code for the chosen test identity and returns to the app the way the real provider would: a GET redirect for
 * Google, an auto-submitted cross-site form POST for Apple (response_mode=form_post).
 */
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export async function POST(req: Request) {
  if (!mockIdpEnabled()) return new NextResponse('Not found', { status: 404 });
  const f = await req.formData();
  const get = (k: string) => (typeof f.get(k) === 'string' ? (f.get(k) as string) : '');
  const provider = get('provider') === 'apple' ? 'apple' : 'google';
  const redirectUri = get('redirect_uri');
  const state = get('state');
  if (!redirectUri.startsWith(`${env().APP_URL}/api/auth/${provider}/callback`)) return new NextResponse('Bad redirect_uri', { status: 400 });
  const back = new URLSearchParams({ state });
  if (get('cancel')) back.set('error', 'access_denied');
  else {
    let identity: MockIdentity | undefined = MOCK_IDENTITIES[provider][Number(get('identity'))]?.identity;
    const custom = get('email').trim().toLowerCase();
    if (custom) identity = { sub: `${provider}-${custom}`, email: custom, emailVerified: true };
    if (!identity) return new NextResponse('Pick an identity', { status: 400 });
    back.set('code', await mockAuthorize({ provider, clientId: get('client_id'), redirectUri, nonce: get('nonce'), codeChallenge: get('code_challenge') || null, identity }));
  }
  if (provider === 'google') return NextResponse.redirect(`${redirectUri}?${back}`, 303);
  const inputs = [...back].map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('');
  const html = `<!doctype html><meta charset="utf-8"><title>Returning to Arkiv</title><form method="post" action="${esc(redirectUri)}">${inputs}<noscript><button>Continue</button></noscript></form><script>document.forms[0].submit()</script>`;
  return new NextResponse(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}
