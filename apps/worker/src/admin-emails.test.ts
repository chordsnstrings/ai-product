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

  it('sends the price-change notice (plan 04 §3) to owners, and not once it has applied', async () => {
    const t = await makeTenant({ state: 'ACTIVE_PAID' });
    const [s] = await ownerPool()`insert into subscriptions (workspace_id, stripe_subscription_id, plan_code, status, consent_record_id) values (${t.workspaceId}, 'sub_pc', 'GROWTH', 'active', gen_random_uuid()) returning id`;
    const [v] = await ownerPool()`insert into plan_prices (plan_code, price_micros, effective_from, reason, created_by) values ('GROWTH', 129000000, now() + interval '31 days', 'repricing', gen_random_uuid()) returning id`;
    const [n] = await ownerPool()`insert into price_change_notices (workspace_id, subscription_id, plan_price_id, plan_code, old_price_micros, new_price_micros, effective_from)
                                  values (${t.workspaceId}, ${s!.id}, ${v!.id}, 'GROWTH', 99000000, 129000000, now() + interval '31 days') returning id`;
    await sendQueuedEmail(ctxFor(t.workspaceId, t.userId, 'OWNER', 'ACTIVE_PAID'), { template: 'price_change_notice', noticeId: n!.id }, 'job-pc');
    const [mail] = devOutbox.filter((x) => x.template === 'price_change_notice');
    expect(mail).toMatchObject({ to: t.email, data: { planName: 'Growth', oldPrice: '$99', newPrice: '$129' } });
    expect((mail!.data as { url: string }).url).toMatch(new RegExp(`/w/${t.slug}/settings/billing$`));
    await ownerPool()`update price_change_notices set applied_at = now() where id = ${n!.id}`;
    await sendQueuedEmail(ctxFor(t.workspaceId, t.userId, 'OWNER', 'ACTIVE_PAID'), { template: 'price_change_notice', noticeId: n!.id }, 'job-pc2');
    expect(devOutbox.filter((x) => x.template === 'price_change_notice')).toHaveLength(1);
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

describe('integration emails (plan 03 A10, plan 05 §16, plan 02 §3 layer 8)', () => {
  it('asks the owners to reconnect before a token expires, and the owner (only) to decide a store transfer', async () => {
    const t = await makeTenant({ state: 'ACTIVE_PAID' });
    const [a] = await ownerPool()`insert into users (email) values ('admin@brand.com') returning id`;
    await ownerPool()`insert into memberships (workspace_id, user_id, role) values (${t.workspaceId}, ${a!.id}, 'ADMIN')`;
    const ctx = ctxFor(t.workspaceId, t.userId, 'OWNER', 'ACTIVE_PAID');
    await sendQueuedEmail(ctx, { template: 'integration_expiring', provider: 'Meta', expiresAt: '2026-10-01T12:00:00Z' }, 'job-e');
    const exp = devOutbox.filter((x) => x.template === 'integration_expiring');
    expect(exp.map((x) => x.to).sort()).toEqual(['admin@brand.com', t.email].sort());
    expect(exp[0]!.subject).toBe('Reconnect Meta before October 1');

    const other = await makeTenant({ email: 'jordan@elsewhere.example' });
    const [r] = await ownerPool()`insert into shop_transfer_requests (workspace_id, from_workspace_id, shop_domain, requested_by, requester_email)
                                  values (${other.workspaceId}, ${t.workspaceId}, 'glow.myshopify.com', ${other.userId}, 'jordan@elsewhere.example') returning id`;
    await sendQueuedEmail(ctx, { template: 'shop_transfer_request', requestId: r!.id }, 'job-t');
    const tr = devOutbox.filter((x) => x.template === 'shop_transfer_request');
    expect(tr.map((x) => x.to)).toEqual([t.email]);
    expect(tr[0]!.data).toMatchObject({ shop: 'glow.myshopify.com', requester: 'j•••@elsewhere.example' });
    // Decided already, or not addressed to this workspace: nothing is sent.
    await ownerPool()`update shop_transfer_requests set status = 'rejected' where id = ${r!.id}`;
    await sendQueuedEmail(ctx, { template: 'shop_transfer_request', requestId: r!.id }, 'job-t2');
    await ownerPool()`update shop_transfer_requests set status = 'pending' where id = ${r!.id}`;
    await sendQueuedEmail(ctxFor(other.workspaceId, other.userId), { template: 'shop_transfer_request', requestId: r!.id }, 'job-t3');
    expect(devOutbox.filter((x) => x.template === 'shop_transfer_request')).toHaveLength(1);
  });
});
