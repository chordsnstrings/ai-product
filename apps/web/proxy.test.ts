import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { proxy } from './proxy';

const req = (path: string, cookies: Record<string, string> = {}, method = 'GET') =>
  new NextRequest(`http://localhost:3000${path}`, { method, headers: { cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ') } });

describe('rolling session cookie (plan 03 Part C "30-day rolling")', async () => {
  it('re-issues the session cookie for 30 days on a page load, at most once a day', async () => {
    const res = await proxy(req('/w/glow/this-week', { arkiv_session: 'tok-abcdefghijklmnopqrstuvwxyz' }));
    const s = res.cookies.get('arkiv_session');
    expect(s?.value).toBe('tok-abcdefghijklmnopqrstuvwxyz');
    expect(s?.maxAge).toBe(30 * 86400);
    expect(s?.httpOnly).toBe(true);
    expect(s?.sameSite).toBe('lax');
    expect(res.cookies.get('arkiv_sr')?.maxAge).toBe(86400);
    // Refreshed within the day: nothing to do.
    expect((await proxy(req('/w/glow/this-week', { arkiv_session: 'tok', arkiv_sr: '1' }))).cookies.get('arkiv_session')).toBeUndefined();
  });

  it('leaves API routes (sign-in, rotation, sign-out set the cookie themselves), other verbs and signed-out visitors alone', async () => {
    expect((await proxy(req('/api/auth/logout', { arkiv_session: 'tok' }, 'POST'))).cookies.get('arkiv_session')).toBeUndefined();
    expect((await proxy(req('/api/me/password-set', { arkiv_session: 'tok' }, 'POST'))).cookies.get('arkiv_session')).toBeUndefined();
    expect((await proxy(req('/api/projects/x', { arkiv_session: 'tok' }))).cookies.get('arkiv_session')).toBeUndefined();
    expect((await proxy(req('/'))).cookies.get('arkiv_session')).toBeUndefined();
  });

  it('refreshes the session cookie on a campaign landing page too, alongside the visitor cookie', async () => {
    const res = await proxy(req('/for/serum', { arkiv_session: 'tok-landing' }));
    expect(res.cookies.get('arkiv_session')?.value).toBe('tok-landing');
    expect(res.cookies.get('arkiv_v')?.value).toBeTruthy();
    // Visitor cookies are a landing-page concern only.
    expect((await proxy(req('/w/glow/this-week'))).cookies.get('arkiv_v')).toBeUndefined();
  });

  it('still limits framing of campaign previews to the console', async () => {
    expect((await proxy(req('/for/serum?preview=abc'))).headers.get('Content-Security-Policy')).toMatch(/^frame-ancestors 'self'/);
    expect((await proxy(req('/for/serum'))).headers.get('Content-Security-Policy')).toBeNull();
    expect((await proxy(req('/concepts/x?preview=abc'))).headers.get('Content-Security-Policy')).toBeNull();
  });
});
