import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool } from '@arkiv/db';
import { makeSku, makeTenant, truncateAll } from '@arkiv/db/testing';
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

describe('midweek signal update (standard §11)', () => {
  it('lists only tests that crossed a threshold in the window, once per workspace per window', async () => {
    const t = await makeTenant({ state: 'ACTIVE_PAID' });
    const skuId = await makeSku(t.workspaceId, 'Glow Serum');
    const exp = async (hypothesis: string) =>
      (await ownerPool()`insert into experiments (workspace_id, sku_id, hypothesis, primary_variable, primary_metric, mode, state, created_by)
                         values (${t.workspaceId}, ${skuId}, ${hypothesis}, 'hook', 'hold_rate', 'CONTROLLED', 'ACTIONABLE', 'test') returning id`)[0]!.id as string;
    const crossed = await exp('Texture-first opening lifts hold rate');
    const quiet = await exp('Routine placement');
    const changed = (id: string, from: string, to: string) =>
      ownerPool()`insert into events (workspace_id, type, actor, subject_type, subject_id, payload) values (${t.workspaceId}, 'CONFIDENCE_CHANGED', 'system:x', 'experiment', ${id}, ${ownerPool().json({ from, to })})`;
    await changed(crossed, 'GATHERING_SIGNAL', 'DIRECTIONAL');
    await changed(crossed, 'DIRECTIONAL', 'ACTIONABLE');
    await changed(quiet, 'READY_TO_RUN', 'GATHERING_SIGNAL'); // not a threshold
    const ctx = ctxFor(t.workspaceId, t.userId, 'OWNER', 'ACTIVE_PAID');
    const window = new Date(Date.now() + 86400_000).toISOString().slice(0, 10);
    await sendQueuedEmail(ctx, { template: 'signal_update', window }, 'job-1');
    await sendQueuedEmail(ctx, { template: 'signal_update', window }, 'job-2'); // a second job in the same window
    const sent = devOutbox.filter((x) => x.template === 'signal_update');
    expect(sent).toHaveLength(1);
    expect((sent[0]!.data as { changes: unknown[] }).changes).toEqual([{ test: 'Glow Serum: Texture-first opening lifts hold rate', from: 'GATHERING_SIGNAL', to: 'ACTIONABLE' }]);
  });
});
