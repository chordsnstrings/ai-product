import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool } from '@arkiv/db';
import { makeTenant, truncateAll } from '@arkiv/db/testing';
import { digestOptOutLink } from '@arkiv/email';
import { GET, POST } from './route';

beforeEach(truncateAll);
afterAll(closeAll);

describe('weekly digest opt-out route (plan 03 A10)', () => {
  it('GET only confirms; the one-click POST turns off exactly that digest', async () => {
    const t = await makeTenant();
    const url = digestOptOutLink({ workspaceId: t.workspaceId, userId: t.userId, kind: 'friday_summary' });
    const get = await GET(new Request(url));
    expect(get.status).toBe(303);
    expect(new URL(get.headers.get('location')!).pathname).toBe('/email-preferences');
    expect(await ownerPool()`select 1 from notification_prefs`).toHaveLength(0);
    const r = await POST(new Request(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' }));
    expect(r.status).toBe(204);
    expect(await ownerPool()`select kind, enabled from notification_prefs where user_id = ${t.userId}`).toEqual([{ kind: 'friday_summary', enabled: false }]);
    // Receipts are untouched: nothing was added to the suppression list.
    expect(await ownerPool()`select 1 from email_suppressions`).toHaveLength(0);
    const bad = await POST(new Request('http://localhost/api/notifications/opt-out?t=AAAA.BBBB', { method: 'POST', body: 'List-Unsubscribe=One-Click' }));
    expect(bad.status).toBe(400);
  });
});
