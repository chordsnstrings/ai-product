import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool, withTenant } from '@arkiv/db';
import { makeSku, makeTenant, truncateAll } from '@arkiv/db/testing';
import { devOutbox } from '@arkiv/email';
import { inviteMember, transition } from '@arkiv/core';
import { ctxFor } from '@arkiv/core/testing';
import { newId } from '@arkiv/shared';
import { sendQueuedEmail } from './emails';

beforeEach(() => {
  devOutbox.length = 0;
  return truncateAll();
});
afterAll(closeAll);

const sent = (t: string) => devOutbox.filter((x) => x.template === t);
const outboxRows = async (ws: string, template: string) => ownerPool()`select payload, singleton_key from outbox where workspace_id = ${ws} and payload->>'template' = ${template} order by created_at`;
async function project(ws: string, state = 'RENDERING', extra: { experimentId?: string } = {}) {
  const sku = await makeSku(ws, 'Dew Serum');
  const id = newId();
  await ownerPool()`insert into projects (id, workspace_id, sku_id, kind, state, created_by, entitlement_unit, experiment_id) values (${id}, ${ws}, ${sku}, 'taste', ${state}, 'test', 'taste', ${extra.experimentId ?? null})`;
  return { id, sku };
}

describe('QA needs you (plan 03 A10)', () => {
  it('queues one email per stop, names the workspace, and skips a stop that already cleared', async () => {
    const t = await makeTenant({ state: 'ACTIVE_PAID' });
    const ctx = ctxFor(t.workspaceId, t.userId, 'OWNER', 'ACTIVE_PAID');
    const p = await project(t.workspaceId);
    await withTenant(t.workspaceId, (tx) => transition(tx, ctx, p.id, 'BLOCKED_COMPLIANCE', { reason: 'A line needs changing before we can finish your ad.', code: 'claims_blocked' }));
    const [row] = await outboxRows(t.workspaceId, 'qa_needs_you');
    expect(row!.payload).toMatchObject({ projectId: p.id, state: 'BLOCKED_COMPLIANCE', actorUserId: t.userId });
    await sendQueuedEmail(ctx, row!.payload as Record<string, unknown>, 'job-qa');
    const [mail] = sent('qa_needs_you');
    expect(mail!.to).toBe(t.email);
    expect(mail!.subject).toBe('Dew Serum: A line in your ad needs changing');
    const [w] = await ownerPool()`select name from workspaces where id = ${t.workspaceId}`;
    expect((mail!.data as { workspaceName: string }).workspaceName).toBe(w!.name);
    expect(mail!.html).toContain(w!.name as string);
    expect((mail!.data as { url: string }).url).toMatch(new RegExp(`/produce/${p.id}$`));
    // A redelivered job sends nothing more; a payload for an earlier stop (the project moved on) is skipped.
    await sendQueuedEmail(ctx, row!.payload as Record<string, unknown>, 'job-qa-2');
    expect(sent('qa_needs_you')).toHaveLength(1);
    await ownerPool()`update projects set state = 'STORYBOARD_READY' where id = ${p.id}`;
    await sendQueuedEmail(ctx, { ...(row!.payload as object), stateVersion: 99 } as Record<string, unknown>, 'job-qa-3');
    expect(sent('qa_needs_you')).toHaveLength(1);
  });

  it('an outage pause (resumes by itself) queues nothing', async () => {
    const t = await makeTenant({ state: 'ACTIVE_PAID' });
    const ctx = ctxFor(t.workspaceId, t.userId, 'OWNER', 'ACTIVE_PAID');
    const p = await project(t.workspaceId);
    await withTenant(t.workspaceId, (tx) => transition(tx, ctx, p.id, 'NEEDS_USER_ACTION', { reason: 'Queued', code: 'provider_outage' }));
    expect(await outboxRows(t.workspaceId, 'qa_needs_you')).toHaveLength(0);
  });
});

describe('asset ready (plan 03 A10)', () => {
  it('a Creative Test links to the Studio and reaches the member who approved it', async () => {
    const t = await makeTenant({ state: 'ACTIVE_PAID' });
    const [m] = await ownerPool()`insert into users (email) values ('member@brand.com') returning id`;
    await ownerPool()`insert into memberships (workspace_id, user_id, role) values (${t.workspaceId}, ${m!.id}, 'MEMBER')`;
    const expId = newId();
    const p = await project(t.workspaceId, 'COMPLETE');
    await ownerPool()`insert into experiments (id, workspace_id, sku_id, hypothesis, primary_variable, mode, created_by, state) values (${expId}, ${t.workspaceId}, ${p.sku}, 'Texture beats talking heads', 'hook', 'CONTROLLED', 'test', 'GATHERING_SIGNAL')`;
    await ownerPool()`update projects set experiment_id = ${expId} where id = ${p.id}`;
    await ownerPool()`insert into events (workspace_id, type, actor, subject_type, subject_id, payload) values (${t.workspaceId}, 'PROJECT_STATE_CHANGED', ${'user:' + m!.id}, 'project', ${p.id}, ${ownerPool().json({ from: 'STORYBOARD_READY', to: 'STORYBOARD_APPROVED' })})`;
    const ctx = ctxFor(t.workspaceId, t.userId, 'OWNER', 'ACTIVE_PAID');
    await sendQueuedEmail(ctx, { template: 'asset_ready', projectId: p.id }, 'job-a1');
    await sendQueuedEmail(ctx, { template: 'asset_ready', projectId: p.id }, 'job-a2'); // a second job: same event, no second email
    const mails = sent('asset_ready');
    expect(mails.map((x) => x.to).sort()).toEqual(['member@brand.com', t.email].sort());
    expect((mails[0]!.data as { url: string; variants: boolean })).toMatchObject({ url: expect.stringMatching(new RegExp(`/w/${t.slug}/studio/${expId}$`)), variants: true });
    expect(mails[0]!.html).toContain('Download your variants');
  });
});

describe('weekly emails (standard §11)', () => {
  it('sends the Monday brief at most once per week, and says why when there is nothing new', async () => {
    const t = await makeTenant({ state: 'ACTIVE_PAID' });
    const ctx = ctxFor(t.workspaceId, t.userId, 'OWNER', 'ACTIVE_PAID');
    const sku = await makeSku(t.workspaceId, 'Dew Serum');
    await ownerPool()`insert into recommendations (workspace_id, sku_id, week_of, slot, proposal, score, score_breakdown, basis, status) values (${t.workspaceId}, ${sku}, '2026-09-21', 'EXPLOIT', ${ownerPool().json({ hypothesis: 'Texture close-ups beat talking heads' })}, 0.9, '{}', 'cold_start', 'open')`;
    await sendQueuedEmail(ctx, { template: 'weekly_brief', week: '2026-09-21' }, 'job-b1');
    await sendQueuedEmail(ctx, { template: 'weekly_brief', week: '2026-09-21' }, 'job-b2'); // mid-week refresh
    expect(sent('weekly_brief')).toHaveLength(1);
    expect(sent('weekly_brief')[0]!.html).toContain('/api/notifications/opt-out');
    // A week without open recommendations: the brief explains instead of staying silent.
    await sendQueuedEmail(ctx, { template: 'weekly_brief', week: '2026-09-28', blockedReason: null }, 'job-b3');
    const empty = sent('weekly_brief')[1]!;
    expect(empty.subject).toContain('What to test this week');
    expect(empty.html).toContain('No new tests this week');
  });

  it('skips a member who turned the digest off', async () => {
    const t = await makeTenant({ state: 'ACTIVE_PAID' });
    const ctx = ctxFor(t.workspaceId, t.userId, 'OWNER', 'ACTIVE_PAID');
    await ownerPool()`insert into notification_prefs (workspace_id, user_id, kind, enabled) values (${t.workspaceId}, ${t.userId}, 'weekly_brief', false)`;
    await sendQueuedEmail(ctx, { template: 'weekly_brief', week: '2026-09-28' }, 'job-b4');
    expect(sent('weekly_brief')).toHaveLength(0);
  });

  it('the Friday summary covers what was learned, what is uncertain, what is fatiguing and what comes next', async () => {
    const t = await makeTenant({ state: 'ACTIVE_PAID' });
    const ctx = ctxFor(t.workspaceId, t.userId, 'OWNER', 'ACTIVE_PAID');
    const sku = await makeSku(t.workspaceId, 'Dew Serum');
    await ownerPool()`insert into experiments (workspace_id, sku_id, hypothesis, primary_variable, mode, created_by, state) values (${t.workspaceId}, ${sku}, 'Routine vs ingredient', 'angle', 'CONTROLLED', 'test', 'GATHERING_SIGNAL')`;
    await ownerPool()`insert into experiments (workspace_id, sku_id, hypothesis, primary_variable, mode, created_by, state, fatigue, fatigue_at) values (${t.workspaceId}, ${sku}, 'Before/after angle', 'angle', 'CONTROLLED', 'test', 'ACTIONABLE', ${ownerPool().json({ fatigued: true, reason: 'CTR down 28% over 14 days' })}, now())`;
    await ownerPool()`insert into recommendations (workspace_id, sku_id, week_of, slot, proposal, score, score_breakdown, basis, status) values (${t.workspaceId}, ${sku}, '2026-09-21', 'EXPLORE', ${ownerPool().json({ hypothesis: 'Test a texture close-up' })}, 0.8, '{}', 'cold_start', 'open')`;
    await sendQueuedEmail(ctx, { template: 'friday_summary', week: '2026-09-21' }, 'job-f1');
    const [mail] = sent('friday_summary');
    expect(mail!.data).toMatchObject({ learned: [], uncertain: [expect.stringContaining('Routine vs ingredient')], fatiguing: [expect.stringContaining('CTR down 28%')], nextLikely: 'Test a texture close-up' });
    expect(mail!.html).toContain('Still uncertain');
  });
});

describe('billing and support emails', () => {
  it('confirms each cancellation once, with the date in the design-system format', async () => {
    const t = await makeTenant({ state: 'ACTIVE_PAID' });
    const ctx = ctxFor(t.workspaceId, t.userId, 'OWNER', 'ACTIVE_PAID');
    const d = { template: 'cancellation_confirmed', plan: 'GROWTH', endsAt: '2026-10-23T16:00:00.000Z' };
    await sendQueuedEmail(ctx, { ...d, cancelId: 'c1' }, 'job-c1');
    await sendQueuedEmail(ctx, { ...d, cancelId: 'c1' }, 'job-c1b');
    await sendQueuedEmail(ctx, { ...d, cancelId: 'c2' }, 'job-c2'); // cancelled again after "keep my plan"
    expect(sent('cancellation_confirmed')).toHaveLength(2);
    expect(sent('cancellation_confirmed')[0]!.data).toMatchObject({ endsOn: '23 Oct 2026', planName: 'Growth' });
  });

  it('sends a receipt for a paid subscription invoice', async () => {
    const t = await makeTenant({ state: 'ACTIVE_PAID' });
    const ctx = ctxFor(t.workspaceId, t.userId, 'OWNER', 'ACTIVE_PAID');
    await ownerPool()`insert into subscriptions (workspace_id, stripe_subscription_id, plan_code, status, consent_record_id) values (${t.workspaceId}, 'sub_r', 'GROWTH', 'active', gen_random_uuid())`;
    await ownerPool()`insert into stripe_invoices (id, workspace_id, stripe_subscription_id, status, amount_paid_cents, period_start, period_end, hosted_invoice_url)
                      values ('in_1', ${t.workspaceId}, 'sub_r', 'paid', 29900, '2026-09-24T12:00:00Z', '2026-10-24T12:00:00Z', 'https://invoice.stripe.com/i/x')`;
    await sendQueuedEmail(ctx, { template: 'invoice_receipt', invoiceId: 'in_1', number: 'ARK-0042', taxCents: null, paidAt: '2026-09-24T12:00:00Z' }, 'job-i1');
    const [mail] = sent('invoice_receipt');
    expect(mail!.data).toMatchObject({ planName: 'Growth', amount: '$299.00', invoiceNumber: 'ARK-0042', periodStart: '24 Sep 2026', hostedInvoiceUrl: 'https://invoice.stripe.com/i/x' });
  });

  it('the break-glass notice links to the access log and names the workspace', async () => {
    const t = await makeTenant({ state: 'ACTIVE_PAID' });
    const ctx = ctxFor(t.workspaceId, t.userId, 'OWNER', 'ACTIVE_PAID');
    await sendQueuedEmail(ctx, { template: 'staff_break_glass', breakGlassId: newId(), staffName: 'Sam', reason: 'Support ticket #812: export failed' }, 'job-bg');
    const [mail] = sent('staff_break_glass');
    expect((mail!.data as { url: string }).url).toMatch(new RegExp(`/w/${t.slug}/settings/access-log$`));
    expect((mail!.data as { when: string }).when).toMatch(/^\d{1,2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2} /);
  });

  it('shows a billing notice in the app when every recipient bounces', async () => {
    const t = await makeTenant({ state: 'ACTIVE_PAID' });
    const ctx = ctxFor(t.workspaceId, t.userId, 'OWNER', 'ACTIVE_PAID');
    await ownerPool()`insert into email_suppressions (email, reason, stream) values (${t.email}, 'hard_bounce', 'all')`;
    await sendQueuedEmail(ctx, { template: 'cancellation_confirmed', plan: 'GROWTH', endsAt: null, cancelId: 'c9' }, 'job-c9');
    expect(await ownerPool()`select status from email_log where workspace_id = ${t.workspaceId}`).toEqual([{ status: 'suppressed' }]);
    const [n] = await ownerPool()`select title, link_path from workspace_notices where workspace_id = ${t.workspaceId}`;
    expect(n).toMatchObject({ title: 'We couldn’t email your cancellation confirmation', link_path: '/settings/billing' });
  });
});

describe('invites through the queue (plan 06 Phase 0 #6)', () => {
  it('queues the invite with its link sealed, and the worker sends only a live invite', async () => {
    const t = await makeTenant({ state: 'ACTIVE_PAID', plan: 'GROWTH' });
    const ctx = ctxFor(t.workspaceId, t.userId, 'OWNER', 'ACTIVE_PAID');
    const r = await withTenant(t.workspaceId, (tx) => inviteMember(tx, ctx, 'Teammate@Brand.com', 'MEMBER'));
    const [row] = await outboxRows(t.workspaceId, 'invite');
    expect(JSON.stringify(row!.payload)).not.toContain(r.token);
    await sendQueuedEmail(ctx, row!.payload as Record<string, unknown>, 'job-inv');
    const [mail] = sent('invite');
    expect(mail!.to).toBe('teammate@brand.com');
    expect((mail!.data as { url: string }).url).toContain(`/invite/${r.token}`);
    // Revoked since: nothing is sent.
    devOutbox.length = 0;
    await ownerPool()`update invites set revoked_at = now() where id = ${r.inviteId}`;
    await ownerPool()`delete from email_log`;
    await sendQueuedEmail(ctx, row!.payload as Record<string, unknown>, 'job-inv2');
    expect(sent('invite')).toHaveLength(0);
  });
});

describe('purge notices (plan 02 §2)', () => {
  it('sends the scheduled and final notices only while the deletion stands', async () => {
    const t = await makeTenant({ state: 'ACTIVE_FREE' });
    const ctx = ctxFor(t.workspaceId, t.userId, 'OWNER', 'ACTIVE_FREE');
    await ownerPool()`update workspaces set state = 'PURGE_SCHEDULED', purge_at = '2026-10-03T12:00:00Z' where id = ${t.workspaceId}`;
    await sendQueuedEmail(ctx, { template: 'purge_scheduled', stage: 'final', at: 'T1:x' }, 'job-p1');
    const [mail] = sent('purge_scheduled');
    expect(mail!.subject).toContain('will be deleted tomorrow');
    expect(mail!.data).toMatchObject({ purgeOn: expect.stringMatching(/Oct 2026$/) });
    await ownerPool()`update workspaces set state = 'ACTIVE_FREE', purge_at = null where id = ${t.workspaceId}`;
    await sendQueuedEmail(ctx, { template: 'purge_scheduled', stage: 'final', at: 'T1:y' }, 'job-p2');
    expect(sent('purge_scheduled')).toHaveLength(1);
  });
});
