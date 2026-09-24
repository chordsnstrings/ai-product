import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool } from '@arkiv/db';
import { makeTenant, truncateAll } from '@arkiv/db/testing';
import { devOutbox } from '@arkiv/email';
import { ctxFor } from '@arkiv/core/testing';
import { sendQueuedEmail } from './emails';

beforeEach(() => {
  devOutbox.length = 0;
  return truncateAll();
});
afterAll(closeAll);

describe('queued staff-initiated emails (plan 05 §2.2, §17)', () => {
  it('sends a playbook email to owners and admins, linking inside the workspace', async () => {
    const t = await makeTenant({ state: 'ACTIVE_PAID' });
    const [a] = await ownerPool()`insert into users (email) values ('admin@brand.com') returning id`;
    const [m] = await ownerPool()`insert into users (email) values ('member@brand.com') returning id`;
    await ownerPool()`insert into memberships (workspace_id, user_id, role) values (${t.workspaceId}, ${a!.id}, 'ADMIN'), (${t.workspaceId}, ${m!.id}, 'MEMBER')`;
    await sendQueuedEmail(ctxFor(t.workspaceId, t.userId, 'OWNER', 'ACTIVE_PAID'), { template: 'intervention', indicator: 'ad_account_disconnected', flagId: 'f' }, 'job-1');
    const sent = devOutbox.filter((x) => x.template === 'intervention');
    expect(sent.map((x) => x.to).sort()).toEqual(['admin@brand.com', t.email].sort());
    expect(sent[0]!.subject).toBe('Reconnect your ad account');
    expect((sent[0]!.data as { url: string }).url).toMatch(new RegExp(`/w/${t.slug}/settings/integrations$`));
    // The personal-follow-up playbook has no templated email.
    await sendQueuedEmail(ctxFor(t.workspaceId, t.userId, 'OWNER', 'ACTIVE_PAID'), { template: 'intervention', indicator: 'negative_support_sentiment' }, 'job-2');
    expect(devOutbox.filter((x) => x.template === 'intervention')).toHaveLength(2);
  });

  it('tells the new and previous owners after a confirmed ownership transfer', async () => {
    const t = await makeTenant();
    const [n] = await ownerPool()`insert into users (email) values ('new-owner@brand.com') returning id`;
    await ownerPool()`insert into memberships (workspace_id, user_id, role) values (${t.workspaceId}, ${n!.id}, 'OWNER')`;
    const outsider = await makeTenant();
    await sendQueuedEmail(ctxFor(t.workspaceId, t.userId), { template: 'ownership_transferred', userIds: [n!.id, t.userId, outsider.userId] }, 'job-3');
    const sent = devOutbox.filter((x) => x.template === 'security_alert');
    // Only this workspace's members are emailed, even if a payload named someone else.
    expect(sent.map((x) => x.to).sort()).toEqual(['new-owner@brand.com', t.email].sort());
    expect((sent[0]!.data as { event: string }).event).toMatch(/Ownership of .* was transferred/);
  });
});
