import { describe, expect, it } from 'vitest';
import { DomainError, env } from '@arkiv/shared';
import { inAppBrowser, IN_APP_UA } from './in-app';
import { noJsAnswer, noJsReturn } from './preview-nojs';

/** Plan 03 P1 edge cases: the plain form without JavaScript, and in-app browsers that block the file picker. */
describe('the upload form without JavaScript', () => {
  it('answers a started preview with a redirect to it', () => {
    const r = noJsAnswer({ projectId: '0b8c1f0e-2c1a-4c3e-9a55-2f1d5e7c9b10' });
    expect(r.status).toBe(303);
    expect(r.headers.get('location')).toBe(`${env().APP_URL}/start/0b8c1f0e-2c1a-4c3e-9a55-2f1d5e7c9b10`);
  });

  it('sends a refused post back to /start with the reason and the link, and never leaks an internal error', () => {
    const r = noJsAnswer({ error: new DomainError('INVALID', 'Marketplace listings aren’t supported yet.'), url: 'https://amazon.com/dp/1' });
    const to = new URL(r.headers.get('location')!);
    expect(to.pathname).toBe('/start');
    expect(noJsReturn(Object.fromEntries(to.searchParams))).toEqual({ error: 'Marketplace listings aren’t supported yet.', url: 'https://amazon.com/dp/1' });
    const internal = new URL(noJsAnswer({ error: new Error('connection refused at 10.0.0.3'), url: null }).headers.get('location')!);
    expect(internal.searchParams.get('error')).toBe('Something went wrong. Please try again.');
    expect(internal.searchParams.has('url')).toBe(false);
  });

  it('reads the return parameters defensively', () => {
    expect(noJsReturn({})).toEqual({ error: null, url: '' });
    expect(noJsReturn({ error: ['a', 'b'], url: 'x'.repeat(900) })).toEqual({ error: 'a', url: 'x'.repeat(500) });
  });
});

describe('in-app browsers', () => {
  it('names the app, so the hint says where its "open in browser" is', () => {
    expect(inAppBrowser('Mozilla/5.0 (iPhone) AppleWebKit Instagram 309.0.0')).toBe('Instagram');
    expect(inAppBrowser('Mozilla/5.0 (iPhone) [FBAN/FBIOS;FBAV/450.0]')).toBe('Facebook');
    expect(inAppBrowser('Mozilla/5.0 (Linux; Android 14) musical_ly_2023 BytedanceWebview/d8a21c6')).toBe('TikTok');
    expect(inAppBrowser('Mozilla/5.0 (Macintosh) Safari/605.1.15')).toBeNull();
    expect(IN_APP_UA.test('TikTok 32.1')).toBe(true);
  });
});
