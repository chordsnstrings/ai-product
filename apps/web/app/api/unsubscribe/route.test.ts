import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool } from '@arkiv/db';
import { truncateAll } from '@arkiv/db/testing';
import { unsubscribeLink } from '@arkiv/email';
import { GET, POST } from './route';

beforeEach(truncateAll);
afterAll(closeAll);

const suppressed = async (email: string) => (await ownerPool()`select stream, reason from email_suppressions where email = ${email}`)[0];

describe('unsubscribe route (plan 04 L20)', () => {
  it('serves the List-Unsubscribe URL: GET only confirms, the one-click POST suppresses', async () => {
    const url = unsubscribeLink('reader@example.com');
    const get = await GET(new Request(url));
    expect(get.status).toBe(303);
    const to = new URL(get.headers.get('location')!);
    expect(to.pathname).toBe('/unsubscribe');
    expect(to.searchParams.get('t')).toBe(new URL(url).searchParams.get('t'));
    expect(await suppressed('reader@example.com')).toBeUndefined(); // a link scanner's GET changes nothing

    const oneClick = await POST(new Request(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' }));
    expect(oneClick.status).toBe(204);
    expect(await suppressed('reader@example.com')).toMatchObject({ stream: 'marketing', reason: 'unsubscribed' });
  });

  it('confirms from the page and rejects a forged token', async () => {
    const form = new FormData();
    form.set('confirm', '1');
    const r = await POST(new Request(unsubscribeLink('page@example.com'), { method: 'POST', body: form }));
    expect(r.status).toBe(303);
    expect(new URL(r.headers.get('location')!).searchParams.get('state')).toBe('done');
    expect(await suppressed('page@example.com')).toBeTruthy();

    const forged = `${Buffer.from('victim@example.com').toString('base64url')}.AAAAAAAAAAAAAAAAAAAAAA`;
    const bad = await POST(new Request(`http://localhost/api/unsubscribe?t=${forged}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' }));
    expect(bad.status).toBe(400);
    expect(await suppressed('victim@example.com')).toBeUndefined();
  });
});
