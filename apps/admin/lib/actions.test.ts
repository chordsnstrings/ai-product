import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool } from '@arkiv/db';
import { makeSku, makeTenant, truncateAll } from '@arkiv/db/testing';
import { assertStaff, decideApproval, decideOwnershipTransfer, lookupInvite, startBreakGlass } from '@arkiv/core';
import { MockStripe, setBillingGateway } from '@arkiv/billing';
import { devOutbox, REDACTED_LINK, sendEmail } from '@arkiv/email';
import { DataRequestKind, newId, type StaffRole } from '@arkiv/shared';
import { ACTIONS, type ActionName } from './actions';
import type { StaffUser } from './staff';

/** The console's action registry, exercised the way /api/act/[action] runs it (permission → schema → run). */
async function staff(roles: StaffRole[], name = roles.join('+')): Promise<StaffUser> {
  const id = newId();
  await ownerPool()`insert into staff_users (id, email, name, password_hash, roles) values (${id}, ${`${id.slice(-6)}@arkiv.test`}, ${name}, 'x', ${roles})`;
  return { staffId: id, email: `${id.slice(-6)}@arkiv.test`, name, roles, sessionId: newId(), reauthAt: new Date() };
}

async function act(s: StaffUser, action: ActionName, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const def = ACTIONS[action];
  assertStaff(s, def.perm);
  const parsed = (def.schema as { parse: (x: unknown) => unknown }).parse(input);
  return ((await (def.run as (s: StaffUser, i: unknown) => Promise<unknown>)(s, parsed)) ?? {}) as Record<string, unknown>;
}

beforeEach(truncateAll);
afterAll(closeAll);

describe('staff.create (plan 05 §0.5, §23)', () => {
  it('creates the account without roles and routes the requested roles through four-eyes', async () => {
    const sa = await staff(['SUPER_ADMIN'], 'Founder A');
    const sa2 = await staff(['SUPER_ADMIN'], 'Founder B');
    await expect(act(sa, 'staff.create', { email: 'new@arkiv.test', name: 'New Person', password: 'correct horse battery staple', roles: 'SUPER_ADMIN,FINANCE' })).rejects.toThrow();
    await expect(act(sa, 'staff.create', { email: 'new@arkiv.test', name: 'New Person', password: 'correct horse battery staple', roles: 'WIZARD', reason: 'hiring' })).rejects.toThrow(/Unknown role/);
    const r = await act(sa, 'staff.create', { email: 'new@arkiv.test', name: 'New Person', password: 'correct horse battery staple', roles: 'super_admin, finance', reason: 'second founder joining' });
    expect(r.status).toBe('pending');
    expect(String(r.message)).toMatch(/pending approval/);
    const [u] = await ownerPool()`select id, roles from staff_users where email = 'new@arkiv.test'`;
    expect(u!.roles).toEqual([]);
    // The creator can't approve their own request; another SUPER_ADMIN can.
    await expect(decideApproval(sa, r.approvalId as string, true)).rejects.toThrow(/own request/);
    await decideApproval(sa2, r.approvalId as string, true);
    const [after] = await ownerPool()`select roles from staff_users where id = ${u!.id}`;
    expect(after!.roles).toEqual(['SUPER_ADMIN', 'FINANCE']);
  });
});

describe('qa.review (plan 05 §13)', () => {
  it('keys verdicts by position and check name, matching the stored QA report', async () => {
    const t = await makeTenant();
    const sku = await makeSku(t.workspaceId);
    const pid = newId();
    const report = { pass: true, hardFail: false, checks: [
      { check: 'product_fidelity', pass: true, hard: true, detail: 'Scene 1: label matches', data: { paletteDistance: 12.5 } },
      { check: 'product_fidelity', pass: false, hard: true, detail: 'Scene 2: cap colour differs' },
      { check: 'claims', pass: true, hard: true, detail: '4 lines mapped' },
    ] };
    await ownerPool()`insert into projects (id, workspace_id, sku_id, kind, state, created_by, qa_report) values (${pid}, ${t.workspaceId}, ${sku}, 'taste', 'COMPLETE', 'test', ${ownerPool().json(report)})`;
    const ops = await staff(['OPS']);
    await startBreakGlass(ops, t.workspaceId, { reasonKind: 'compliance_review', reason: 'QA calibration sample review' });
    await expect(act(ops, 'qa.review', { workspaceId: t.workspaceId, projectId: pid, verdicts: { undefined: 'agree' } })).rejects.toThrow(/1:product_fidelity/);
    await expect(act(ops, 'qa.review', { workspaceId: t.workspaceId, projectId: pid, verdicts: { '4:claims': 'agree' } })).rejects.toThrow(/No such check/);
    await act(ops, 'qa.review', { workspaceId: t.workspaceId, projectId: pid, verdicts: { '1:product_fidelity': 'agree', '2:product_fidelity': 'disagree', '3:claims': 'agree' }, failureLabel: 'false_positive' });
    const [r] = await ownerPool()`select verdicts from qa_reviews where project_id = ${pid}`;
    expect(r!.verdicts).toEqual({ '1:product_fidelity': 'agree', '2:product_fidelity': 'disagree', '3:claims': 'agree' });
  });
});

describe('offer.create (plan 05 §6)', () => {
  it('versions per type, validates eligibility, and anchors only to the price currently charged', async () => {
    const g = await staff(['GROWTH']);
    try {
      await expect(act(g, 'offer.create', { code: 'TASTE_X', type: 'TASTE', price: 24, eligibility: { first_timer: true } })).rejects.toThrow(/Unknown eligibility key/);
      await expect(act(g, 'offer.create', { code: 'TASTE_X', type: 'TASTE', price: 24, currency: 'EUR' })).rejects.toThrow();
      await expect(act(g, 'offer.create', { code: 'TASTE_X', type: 'TASTE', price: 24, nextOfferPolicy: { next: 'NOPE_1' } })).rejects.toThrow(/doesn’t exist/);
      const r = await act(g, 'offer.create', { code: 'TASTE_24_V2', type: 'TASTE', price: 24, referenceCode: 'STANDALONE_29', stripePriceId: 'price_abc123', eligibility: { and: [{ var: 'never_purchased' }] }, nextOfferPolicy: { next: 'STANDALONE_29' } });
      expect(r.message).toMatch(/v2/);
      const [d] = await ownerPool()`select version, currency, stripe_price_id, next_offer_policy from offer_definitions where code = 'TASTE_24_V2'`;
      expect(d).toMatchObject({ version: 2, currency: 'USD', stripe_price_id: 'price_abc123', next_offer_policy: { next: 'STANDALONE_29' } });
      await act(g, 'offer.create', { code: 'STANDALONE_35', type: 'STANDALONE', price: 35 });
      // $29 is no longer what we charge for a standalone ad, so it can't anchor a new offer.
      await expect(act(g, 'offer.create', { code: 'TASTE_22', type: 'TASTE', price: 22, referenceCode: 'STANDALONE_29' })).rejects.toThrow(/currently charged/);
    } finally {
      await ownerPool()`delete from offer_definitions where code not in ('TASTE_19', 'STANDALONE_29')`;
    }
  });
});

describe('route.update and eval.run (plan 05 §10–11)', () => {
  it('requires a passing golden-set eval for exactly the proposed template × model', async () => {
    const eng = await staff(['ENGINEERING']);
    const task = 'creative_director.storyboard';
    try {
      await expect(act(eng, 'route.update', { task: 'tts.voiceover', rolloutPct: '5', model: 'speech-2.8-turbo', reason: 'cheaper voice' })).rejects.toThrow(/No golden dataset covers tts\.voiceover/);
      await expect(act(eng, 'route.update', { task, rolloutPct: '5', promptVersion: 'storyboard@1.1.0', reason: 'tighter hooks' })).rejects.toThrow(/Run a passing compliance\.scan eval for creative_director\.storyboard · claude-opus-5-5 · storyboard@1\.1\.0/);
      // A passing run of the dataset for some other candidate doesn't count.
      await ownerPool()`insert into eval_runs (task, prompt_version, model, dataset, status, created_by) values (${task}, 'storyboard@9.9.9', 'claude-opus-5-5', 'compliance.scan', 'passed', ${eng.staffId})`;
      await expect(act(eng, 'route.update', { task, rolloutPct: '5', promptVersion: 'storyboard@1.1.0', reason: 'tighter hooks' })).rejects.toThrow(/Run a passing/);
      // eval.run records the run for the candidate and queues it for the worker.
      await act(eng, 'eval.run', { task, promptVersion: 'storyboard@1.1.0', reason: 'candidate' });
      const [run] = await ownerPool()`select id, task, model, prompt_version, dataset, status from eval_runs where prompt_version = 'storyboard@1.1.0'`;
      expect(run).toMatchObject({ task, model: 'claude-opus-5-5', dataset: 'compliance.scan', status: 'queued' });
      expect(await ownerPool()`select 1 from ops_commands where kind = 'eval.run' and payload->>'evalRunId' = ${run!.id as string}`).toHaveLength(1);
      await ownerPool()`update eval_runs set status = 'passed' where id = ${run!.id}`; // the worker's verdict
      const r = await act(eng, 'route.update', { task, rolloutPct: '5', promptVersion: 'storyboard@1.1.0', reason: 'tighter hooks' });
      expect(r.message).toMatch(/Canary at 5%/);
      const [c] = await ownerPool()`select canary from model_routes where task = ${task}`;
      expect(c!.canary).toMatchObject({ model: 'claude-opus-5-5', promptVersion: 'storyboard@1.1.0', pct: 5, evalRunId: run!.id });
      const started = (c!.canary as { startedAt: string }).startedAt;
      await act(eng, 'route.update', { task, rolloutPct: '25', promptVersion: 'storyboard@1.1.0', reason: 'step up' });
      const [c2] = await ownerPool()`select canary from model_routes where task = ${task}`;
      expect(c2!.canary).toMatchObject({ pct: 25, startedAt: started }); // same candidate keeps its window
      await act(eng, 'route.update', { task, rolloutPct: '0', reason: 'end canary' });
      const [c3] = await ownerPool()`select canary from model_routes where task = ${task}`;
      expect(c3!.canary).toBeNull();
      // A candidate model the Cost Governor can't price is refused even with a passing eval.
      await ownerPool()`insert into eval_runs (task, prompt_version, model, dataset, status, created_by) values (${task}, 'storyboard@1.1.0', 'unpriced-model', 'compliance.scan', 'passed', ${eng.staffId})`;
      await expect(act(eng, 'route.update', { task, rolloutPct: '5', model: 'unpriced-model', reason: 'try it' })).rejects.toThrow(/No published rate for anthropic\/unpriced-model/);
    } finally {
      await ownerPool()`update model_routes set canary = null`;
    }
  });

  it('route.fallback approves only a priced route of the same kind, never itself or a loop; route.pin is audited', async () => {
    const eng = await staff(['ENGINEERING']);
    const support = await staff(['SUPPORT']);
    try {
      await ownerPool()`insert into model_routes (task, provider, model, prompt_version) select 'video.scene_backup', provider, model, prompt_version from model_routes where task = 'video.scene'`;
      await ownerPool()`insert into model_routes (task, provider, model, prompt_version) values ('video.scene_unpriced', 'byteplus', 'no-rate-model', 'scene@1.0.0')`;
      expect(() => assertStaff(support, ACTIONS['route.fallback'].perm)).toThrow();
      await expect(act(eng, 'route.fallback', { task: 'video.scene', fallbackTask: 'video.scene', reason: 'self fallback' })).rejects.toThrow(/own fallback/);
      await expect(act(eng, 'route.fallback', { task: 'video.scene', fallbackTask: 'qa.fidelity', reason: 'wrong kind' })).rejects.toThrow(/different kind/);
      await expect(act(eng, 'route.fallback', { task: 'video.scene', fallbackTask: 'video.scene_unpriced', reason: 'no rate yet' })).rejects.toThrow(/No published rate/);
      const r = await act(eng, 'route.fallback', { task: 'video.scene', fallbackTask: 'video.scene_backup', reason: 'second region' });
      expect(r.message).toMatch(/fails over to video\.scene_backup/);
      expect((await ownerPool()`select fallback_task from model_routes where task = 'video.scene'`)[0]!.fallback_task).toBe('video.scene_backup');
      await expect(act(eng, 'route.fallback', { task: 'video.scene_backup', fallbackTask: 'video.scene', reason: 'loop back' })).rejects.toThrow(/already falls back/);
      await act(eng, 'route.fallback', { task: 'video.scene', fallbackTask: '', reason: 'remove' });
      expect((await ownerPool()`select fallback_task from model_routes where task = 'video.scene'`)[0]!.fallback_task).toBeNull();

      await act(eng, 'route.pin', { task: 'video.scene', version: 'seed-2026-09-01', reason: 'freeze output' });
      expect((await ownerPool()`select pinned_model_version from model_routes where task = 'video.scene'`)[0]!.pinned_model_version).toBe('seed-2026-09-01');
      await act(eng, 'route.pin', { task: 'video.scene', version: '', reason: 'unpin' });
      expect((await ownerPool()`select pinned_model_version from model_routes where task = 'video.scene'`)[0]!.pinned_model_version).toBeNull();
      const audits = await ownerPool()`select action from admin_audit_log where target_id = 'video.scene' order by at, id`;
      expect(audits.map((a) => a.action)).toEqual(['route.fallback', 'route.fallback', 'route.pin', 'route.pin']);
    } finally {
      await ownerPool()`update model_routes set fallback_task = null, pinned_model_version = null where task in ('video.scene', 'video.scene_backup')`;
      await ownerPool()`delete from model_routes where task in ('video.scene_backup', 'video.scene_unpriced')`;
    }
  });

  it('route.circuit can announce when an open circuit is expected back; closing clears it (plan 03 P9 ETA)', async () => {
    const ops = await staff(['OPS']);
    try {
      await act(ops, 'route.circuit', { task: 'video.scene', open: true, reopenMinutes: '30', reason: 'provider incident' });
      const [r] = await ownerPool()`select circuit_open, extract(epoch from circuit_until - now())::int as secs from model_routes where task = 'video.scene'`;
      expect(r!.circuit_open).toBe(true);
      expect(Number(r!.secs)).toBeGreaterThan(29 * 60);
      expect(Number(r!.secs)).toBeLessThanOrEqual(30 * 60);
      // Re-opening without an estimate keeps the announced one.
      await act(ops, 'route.circuit', { task: 'video.scene', open: true, reason: 'still down' });
      expect((await ownerPool()`select circuit_until is not null as eta from model_routes where task = 'video.scene'`)[0]!.eta).toBe(true);
      await act(ops, 'route.circuit', { task: 'video.scene', open: false, reason: 'recovered' });
      expect((await ownerPool()`select circuit_open, circuit_until from model_routes where task = 'video.scene'`)[0]).toMatchObject({ circuit_open: false, circuit_until: null });
      const audits = await ownerPool()`select action from admin_audit_log where target_id = 'video.scene' order by at`;
      expect(audits.map((a) => a.action)).toEqual(['route.circuit_open', 'route.circuit_open', 'route.circuit_close']);
      await expect(act(ops, 'route.circuit', { task: 'no.such_route', open: true, reason: 'typo' })).rejects.toThrow(/Unknown route/);
    } finally {
      await ownerPool()`update model_routes set circuit_open = false, circuit_until = null`;
    }
  });
});

describe('billing.refund (plan 05 §7)', () => {
  it('a repeated submit of the same refund form replays instead of refunding twice', async () => {
    const gw = new MockStripe();
    setBillingGateway(gw);
    const t = await makeTenant({ state: 'ACTIVE_PAID' });
    const purchaseId = newId();
    await ownerPool()`insert into purchases (id, workspace_id, kind, amount_micros, stripe_checkout_session_id, stripe_payment_intent_id, status, created_by)
                      values (${purchaseId}, ${t.workspaceId}, 'standalone', 29000000, ${'cs_' + purchaseId}, ${'pi_' + purchaseId}, 'paid', 'user:x')`;
    const fin = await staff(['FINANCE']);
    const form = { workspaceId: t.workspaceId, purchaseId, amount: 10, reasonCode: 'goodwill', customerNote: 'Sorry for the delay.', requestId: newId(), reason: 'late delivery' };
    const first = await act(fin, 'billing.refund', form);
    const again = await act(fin, 'billing.refund', form);
    expect(first.status).toBe('executed');
    expect((again.result as { replayed?: boolean }).replayed).toBe(true);
    expect(gw.refunds).toHaveLength(1);
    await expect(act(fin, 'billing.refund', { ...form, purchaseId: undefined })).rejects.toThrow(/exactly one payment/);
    const [pu] = await ownerPool()`select refunded_micros from purchases where id = ${purchaseId}`;
    expect(Number(pu!.refunded_micros)).toBe(10_000_000);
  });
});

describe('privacy.create (plan 05 §21)', () => {
  it('accepts every kind the console offers', async () => {
    const c = await staff(['COMPLIANCE']);
    const t = await makeTenant();
    for (const kind of DataRequestKind) await act(c, 'privacy.create', { kind, requesterEmail: 'person@example.com', workspaceId: t.workspaceId });
    const rows = await ownerPool()`select kind from data_requests order by kind`;
    expect(rows.map((r) => r.kind)).toEqual([...DataRequestKind].sort());
  });
});

describe('danger zone and jobs actions', () => {
  it('cancel purge reports the restored state; SUPPORT can retry only no-spend jobs', async () => {
    const t = await makeTenant({ state: 'ACTIVE_PAID', plan: 'LAUNCH' });
    // Paying = a live subscription (a lapsed one would come back CANCELLED).
    await ownerPool()`insert into subscriptions (workspace_id, stripe_subscription_id, plan_code, status, current_period_start, current_period_end, consent_record_id)
                      values (${t.workspaceId}, ${'sub_act_' + t.workspaceId.slice(0, 8)}, 'LAUNCH', 'active', now(), now() + interval '1 month', gen_random_uuid())`;
    const o = await staff(['OPS']);
    await act(o, 'tenant.schedule_purge', { workspaceId: t.workspaceId, reason: 'legal request' });
    const r = await act(o, 'tenant.cancel_purge', { workspaceId: t.workspaceId, reason: 'request withdrawn' });
    expect(r.message).toMatch(/active_paid/);
    const sup = await staff(['SUPPORT']);
    expect(ACTIONS['job.retry'].perm).toBe('jobs.retry_nospend');
    await act(sup, 'job.retry', { queue: 'send-email', jobId: 'j1', reason: 'bounced' });
    await expect(act(sup, 'job.retry', { queue: 'hook-variants', jobId: 'j2', reason: 'retry' })).rejects.toThrow(/no provider spend/);
    await expect(act(sup, 'job.cancel', { queue: 'send-email', jobId: 'j1', reason: 'stop' })).rejects.toThrow(/role/);
    await expect(act(sup, 'tenant.project_retry', { workspaceId: t.workspaceId, projectId: newId(), reason: 'retry' })).rejects.toThrow(/role/);
  });

  it('transfer ownership emails the current owner a confirmation link and changes roles only once they confirm', async () => {
    const t = await makeTenant();
    const [admin] = await ownerPool()`insert into users (email, email_verified_at) values ('next-owner@example.com', now()) returning id`;
    await ownerPool()`insert into memberships (workspace_id, user_id, role) values (${t.workspaceId}, ${admin!.id}, 'ADMIN')`;
    const o = await staff(['OPS']);
    devOutbox.length = 0;
    const r = await act(o, 'tenant.transfer_owner', { workspaceId: t.workspaceId, userId: admin!.id, reason: 'Ticket #88: owner left the company' });
    expect(String(r.message)).toMatch(/Nothing changes until an owner confirms/);
    const roles = await ownerPool()`select user_id, role from memberships where workspace_id = ${t.workspaceId}`;
    expect(Object.fromEntries(roles.map((x) => [x.user_id, x.role]))).toEqual({ [admin!.id as string]: 'ADMIN', [t.userId]: 'OWNER' });
    const mail = devOutbox.find((m) => m.template === 'ownership_transfer_confirm');
    expect(mail!.to).toBe(t.email);
    const url = (mail!.data as { url: string }).url;
    expect(url).toMatch(/\/ownership\/[A-Za-z0-9_-]{20,}$/);
    // The log keeps the email's content for resend/preview, but never the confirmation link itself.
    const [logged] = await ownerPool()`select id, data from email_log where template = 'ownership_transfer_confirm'`;
    expect((logged!.data as { url: string }).url).toBe(REDACTED_LINK);
    expect(ACTIONS['email.resend'].perm).toBe('email.manage');
    await expect(act(await staff(['SUPPORT']), 'email.resend', { logId: logged!.id, requestId: newId(), reason: 'customer lost it' })).rejects.toThrow(/single-use link/);
    // The owner confirms from the link (customer app), then the roles swap.
    await decideOwnershipTransfer(url.split('/ownership/')[1]!, { id: t.userId }, true);
    const after = await ownerPool()`select user_id, role from memberships where workspace_id = ${t.workspaceId}`;
    expect(Object.fromEntries(after.map((x) => [x.user_id, x.role]))).toEqual({ [admin!.id as string]: 'OWNER', [t.userId]: 'ADMIN' });
    await expect(act(o, 'tenant.transfer_owner', { workspaceId: t.workspaceId, userId: admin!.id, reason: 'again please' })).rejects.toThrow(/already owns/);
  });

  it('resend invite issues a fresh link by email; resend email replays a stored email once per click', async () => {
    const t = await makeTenant();
    const sup = await staff(['SUPPORT']);
    const [inv] = await ownerPool()`insert into invites (workspace_id, email, role, token_hash, invited_by, expires_at)
                                    values (${t.workspaceId}, 'teammate@brand.com', 'MEMBER', 'old-hash', ${t.userId}, now() + interval '1 day') returning id`;
    devOutbox.length = 0;
    await act(sup, 'tenant.invite_resend', { workspaceId: t.workspaceId, inviteId: inv!.id });
    const sent = devOutbox.find((m) => m.template === 'invite');
    expect(sent!.to).toBe('teammate@brand.com');
    const token = (sent!.data as { url: string }).url.split('/invite/')[1]!;
    expect((await lookupInvite(token)).status).toBe('ok');
    expect(await ownerPool()`select 1 from admin_audit_log where action = 'tenant.invite_resend' and workspace_id = ${t.workspaceId}`).toHaveLength(1);

    // A stored transactional email is resent with the same content; a double click (same requestId) sends once.
    await sendEmail('receipt', t.email, { productName: 'Dew Serum', amount: '$19.00', description: 'One 15-second ad', url: 'http://localhost/x' }, { idempotencyKey: 'orig-receipt', workspaceId: t.workspaceId });
    const [log] = await ownerPool()`select id from email_log where idempotency_key = 'orig-receipt'`;
    devOutbox.length = 0;
    const requestId = newId();
    const first = await act(sup, 'email.resend', { logId: log!.id, requestId, reason: 'customer can’t find it' });
    const again = await act(sup, 'email.resend', { logId: log!.id, requestId, reason: 'customer can’t find it' });
    expect([first.status, again.status]).toEqual(['logged', 'duplicate']);
    expect(devOutbox.filter((m) => m.template === 'receipt').map((m) => (m.data as { productName: string }).productName)).toEqual(['Dew Serum']);
    const fin = await staff(['FINANCE']);
    expect(() => assertStaff(fin, ACTIONS['email.resend'].perm)).toThrow(/role/);
  });

  it('marking a connection degraded is audited and tells the customer’s freshness view', async () => {
    const t = await makeTenant();
    const [i] = await ownerPool()`insert into integrations (workspace_id, provider, external_account_id, status) values (${t.workspaceId}, 'meta', 'act_9', 'active') returning id`;
    const o = await staff(['OPS']);
    await act(o, 'tenant.integration_status', { workspaceId: t.workspaceId, integrationId: i!.id, status: 'degraded', reason: 'Meta token scope missing' });
    const [row] = await ownerPool()`select status from integrations where id = ${i!.id}`;
    expect(row!.status).toBe('degraded');
    const ev = await ownerPool()`select type, actor from events where workspace_id = ${t.workspaceId} order by type`;
    expect(ev.map((e) => e.type)).toEqual(['DATA_FRESHNESS_CHANGED', 'INTEGRATION_DEGRADED']);
    expect(ev.every((e) => e.actor === `staff:${o.staffId}`)).toBe(true);
    await ownerPool()`update integrations set status = 'disconnected' where id = ${i!.id}`;
    await expect(act(o, 'tenant.integration_status', { workspaceId: t.workspaceId, integrationId: i!.id, status: 'active', reason: 'try again' })).rejects.toThrow(/only the customer/);
  });

  it('break-glass and claim review emails land on the access log and the SKU claims page', async () => {
    const t = await makeTenant();
    const sku = await makeSku(t.workspaceId);
    const [cl] = await ownerPool()`insert into claims (workspace_id, sku_id, canonical_meaning, preferred_wording, claim_category, risk_level, status, origin)
                                   values (${t.workspaceId}, ${sku}, 'hydrates', 'Hydrates for 24 hours', 'cosmetic', 'medium', 'RESTRICTED', 'merchant') returning id`;
    const sup = await staff(['SUPPORT']);
    devOutbox.length = 0;
    await act(sup, 'tenant.breakglass', { workspaceId: t.workspaceId, reasonKind: 'ticket', ticket: '812', reason: 'Customer reports the wrong cap colour in the storyboard' });
    const bg = devOutbox.find((m) => m.template === 'staff_break_glass');
    expect((bg!.data as { url: string }).url).toMatch(new RegExp(`/w/${t.slug}/settings/access-log$`));
    const comp = await staff(['COMPLIANCE']);
    await act(comp, 'claim.decide', { workspaceId: t.workspaceId, claimId: cl!.id, decision: 'block', reason: 'Needs a clinical study' });
    const cr = devOutbox.find((m) => m.template === 'claim_review_result');
    expect((cr!.data as { url: string }).url).toMatch(new RegExp(`/w/${t.slug}/products/${sku}/claims$`));
  });

  it('unblocking a claim (four-eyes) emits CLAIM_UNBLOCKED, not a restriction', async () => {
    const t = await makeTenant();
    const sku = await makeSku(t.workspaceId);
    const [cl] = await ownerPool()`insert into claims (workspace_id, sku_id, canonical_meaning, preferred_wording, claim_category, risk_level, status, origin, block_reason)
                                   values (${t.workspaceId}, ${sku}, 'repairs barrier', 'Repairs your skin barrier', 'cosmetic', 'high', 'BLOCKED', 'merchant', 'unsupported') returning id`;
    const c1 = await staff(['COMPLIANCE']);
    const c2 = await staff(['COMPLIANCE']);
    const r = await act(c1, 'claim.decide', { workspaceId: t.workspaceId, claimId: cl!.id, decision: 'unblock', reason: 'Evidence pack received' });
    expect(r.status).toBe('pending');
    await decideApproval(c2, r.approvalId as string, true);
    const [c] = await ownerPool()`select status, block_reason from claims where id = ${cl!.id}`;
    expect(c).toMatchObject({ status: 'MERCHANT_REVIEW_REQUIRED', block_reason: null });
    const ev = await ownerPool()`select type, actor, payload from events where subject_id = ${cl!.id}`;
    expect(ev).toEqual([{ type: 'CLAIM_UNBLOCKED', actor: `staff:${c2.staffId}`, payload: { from: 'BLOCKED', to: 'MERCHANT_REVIEW_REQUIRED', reason: 'Evidence pack received' } }]);
  });

  it('staff approval of a RESTRICTED claim needs evidence; approving without it goes to a second reviewer (§43)', async () => {
    const t = await makeTenant();
    const sku = await makeSku(t.workspaceId);
    const [cl] = await ownerPool()`insert into claims (workspace_id, sku_id, canonical_meaning, preferred_wording, claim_category, risk_level, status, origin)
                                   values (${t.workspaceId}, ${sku}, 'clinical', 'Clinically proven to smooth skin', 'clinical_claim', 'high', 'RESTRICTED', 'merchant') returning id`;
    const c1 = await staff(['COMPLIANCE']);
    const c2 = await staff(['COMPLIANCE']);
    await expect(act(c1, 'claim.decide', { workspaceId: t.workspaceId, claimId: cl!.id, decision: 'approve', reason: 'Looks fine' })).rejects.toThrow(/needs evidence/);
    const r = await act(c1, 'claim.decide', { workspaceId: t.workspaceId, claimId: cl!.id, decision: 'approve_without_evidence', reason: 'Study reviewed offline by counsel' });
    expect(r.status).toBe('pending');
    expect((await ownerPool()`select status from claims where id = ${cl!.id}`)[0]!.status).toBe('RESTRICTED');
    await expect(decideApproval(c1, r.approvalId as string, true)).rejects.toThrow(/own request/);
    await decideApproval(c2, r.approvalId as string, true);
    expect((await ownerPool()`select status from claims where id = ${cl!.id}`)[0]!.status).toBe('VERIFIED');
    const [ev] = await ownerPool()`select actor, payload from events where subject_id = ${cl!.id} and type = 'CLAIM_APPROVED'`;
    expect(ev!.actor).toBe(`staff:${c2.staffId}`);
    expect((ev!.payload as { evidenceOverride: string }).evidenceOverride).toMatch(/Study reviewed offline by counsel/);
  });

  it('allowlist keys are normalised so the heuristics recognise them', async () => {
    const c = await staff(['COMPLIANCE']);
    await act(c, 'abuse.allowlist', { key: '203.0.113.77', reason: 'agency evaluating 12 SKUs', days: 30 });
    await act(c, 'abuse.allowlist', { key: 'buyer@Agency.com', reason: 'agency evaluating 12 SKUs', days: 7 });
    const keys = await ownerPool()`select key from abuse_allowlist order by key`;
    expect(keys.map((k) => k.key)).toEqual(['domain:agency.com', 'ip:203.0.113']);
  });
});

describe('staff sign-in policies (plan 05 §0.1, §23)', () => {
  it('require passkey needs a registered passkey first and is audited', async () => {
    const sa = await staff(['SUPER_ADMIN']);
    const fin = await staff(['FINANCE']);
    await expect(act(sa, 'staff.require_passkey', { staffId: fin.staffId, required: true, reason: 'finance access' })).rejects.toThrow(/no passkey yet/);
    await ownerPool()`insert into staff_passkeys (staff_id, credential_id, public_key) values (${fin.staffId}, 'cred-1', '\\x00')`;
    await act(sa, 'staff.require_passkey', { staffId: fin.staffId, required: true, reason: 'finance access' });
    const [u] = await ownerPool()`select require_passkey from staff_users where id = ${fin.staffId}`;
    expect(u!.require_passkey).toBe(true);
    const [a] = await ownerPool()`select before, after from admin_audit_log where action = 'staff.require_passkey'`;
    expect(a).toEqual({ before: { require_passkey: false }, after: { require_passkey: true } });
    // Their own last passkey can't be removed while it's required.
    const [pk] = await ownerPool()`select id from staff_passkeys where staff_id = ${fin.staffId}`;
    await expect(act(fin, 'account.passkey_remove', { passkeyId: pk!.id })).rejects.toThrow(/requires a passkey/);
    // …and nobody removes someone else's passkey through their own account.
    await expect(act(sa, 'account.passkey_remove', { passkeyId: pk!.id })).rejects.toThrow(/not found/);
  });

  it('role network policies validate CIDRs and refuse a change that locks the actor out', async () => {
    const sa = { ...(await staff(['SUPER_ADMIN'])), ip: '198.51.100.7' };
    await expect(act(sa, 'staff.ip_policy', { role: 'FINANCE', enabled: true, cidrs: '10.0.0.0/33', reason: 'office only' })).rejects.toThrow(/isn’t a network/);
    const r = await act(sa, 'staff.ip_policy', { role: 'FINANCE', enabled: true, cidrs: '203.0.113.0/24, 2001:db8::/32', reason: 'office + VPN' });
    expect(r.message).toMatch(/limited to 2 networks/);
    const [p] = await ownerPool()`select enabled, cidrs::text[] as cidrs, updated_by from staff_role_ip_policies where role = 'FINANCE'`;
    expect(p).toEqual({ enabled: true, cidrs: ['203.0.113.0/24', '2001:db8::/32'], updated_by: sa.staffId });
    // SUPER_ADMIN at 198.51.100.7 can't restrict their own role to networks that exclude them.
    await expect(act(sa, 'staff.ip_policy', { role: 'SUPER_ADMIN', enabled: true, cidrs: '203.0.113.0/24', reason: 'office only' })).rejects.toThrow(/lock you out/);
    const [still] = await ownerPool()`select count(*)::int as n from staff_role_ip_policies where role = 'SUPER_ADMIN' and enabled`;
    expect(still!.n).toBe(0);
    await act(sa, 'staff.ip_policy', { role: 'SUPER_ADMIN', enabled: true, cidrs: '198.51.100.0/24', reason: 'founders office' });
  });
});

describe('act on behalf (plan 05 §0.3)', () => {
  it('needs SUPER_ADMIN/OPS with a write session, and every write carries actor=staff, on_behalf_of=workspace', async () => {
    const t = await makeTenant();
    const other = await makeTenant();
    const sku = await makeSku(t.workspaceId);
    const otherSku = await makeSku(other.workspaceId);
    const ops = await staff(['OPS']);
    const sup = await staff(['SUPPORT']);
    const fix = { workspaceId: t.workspaceId, skuId: sku, key: 'size_ml', value: '30', reason: 'Ticket #9: label says 30 ml' };
    expect(ACTIONS['tenant.fact_decide'].perm).toBe('breakglass.write');
    await expect(act(sup, 'tenant.fact_decide', fix)).rejects.toThrow(/role/);
    await expect(act(ops, 'tenant.fact_decide', fix)).rejects.toThrow(/break-glass/);
    await startBreakGlass(ops, t.workspaceId, { reasonKind: 'ticket', ticket: '9', reason: 'Customer asked us to fix the size' });
    await expect(act(ops, 'tenant.fact_decide', fix)).rejects.toThrow(/write access/);
    await startBreakGlass(ops, t.workspaceId, { reasonKind: 'ticket', ticket: '9', reason: 'Customer asked us to fix the size', write: true, writeReason: 'They can’t edit from their phone' });
    // A write session on one tenant never reaches another tenant's SKU.
    await expect(act(ops, 'tenant.fact_decide', { ...fix, skuId: otherSku })).rejects.toThrow(/not found/i);
    await act(ops, 'tenant.fact_decide', fix);
    const onBehalf = `staff:${ops.staffId}>workspace:${t.workspaceId}`;
    const [f] = await ownerPool()`select value_text, created_by, state from product_facts where sku_id = ${sku} and normalized_key = 'size_ml' and status <> 'SUPERSEDED'`;
    expect(f).toEqual({ value_text: '30', created_by: onBehalf, state: 'DECIDED' });
    const [ev] = await ownerPool()`select actor from events where workspace_id = ${t.workspaceId} and type = 'PRODUCT_FACT_CHANGED'`;
    expect(ev!.actor).toBe(onBehalf);
    const audits = await ownerPool()`select action from admin_audit_log where staff_id = ${ops.staffId} and action in ('content.write', 'tenant.fact_decide') order by id`;
    // Refused attempts roll back with their transaction; the successful write leaves both rows.
    expect(audits.map((a) => a.action)).toEqual(['content.write', 'tenant.fact_decide']);

    // Storyboard lines edited on the customer's behalf go through the same claims check as their own edits.
    const pid = newId();
    await ownerPool()`insert into projects (id, workspace_id, sku_id, kind, state, created_by) values (${pid}, ${t.workspaceId}, ${sku}, 'taste', 'STORYBOARD_READY', 'test')`;
    const [sb] = await ownerPool()`insert into storyboards (workspace_id, project_id, concept_id, status) values (${t.workspaceId}, ${pid}, ${newId()}, 'ready') returning id`;
    const [sc] = await ownerPool()`insert into scenes (workspace_id, storyboard_id, position, purpose, duration_ms, visual_plan, spoken_line, production_mode)
                                   values (${t.workspaceId}, ${sb!.id}, 1, 'hook', 3000, 'close-up', 'Meet your new serum', 'STRICT_COMPOSITE') returning id`;
    await expect(act(ops, 'tenant.scene_edit', { workspaceId: t.workspaceId, sceneId: sc!.id, spokenLine: 'Cures acne overnight', reason: 'Ticket #9' })).rejects.toThrow(/can’t be used/);
    await act(ops, 'tenant.scene_edit', { workspaceId: t.workspaceId, sceneId: sc!.id, spokenLine: 'Meet your new favourite serum', reason: 'Ticket #9: typo' });
    const [line] = await ownerPool()`select spoken_line from scenes where id = ${sc!.id}`;
    expect(line!.spoken_line).toBe('Meet your new favourite serum');
    const [sa] = await ownerPool()`select before, after from admin_audit_log where action = 'tenant.scene_edit'`;
    expect(sa).toMatchObject({ before: { spoken_line: 'Meet your new serum' }, after: { spoken_line: 'Meet your new favourite serum' } });
  });
});

describe('tenant billing tab actions (plan 05 §2.2 Billing)', () => {
  it('FINANCE applies a coupon and changes plan with the customer consent reference; both are audited', async () => {
    const gw = new MockStripe();
    setBillingGateway(gw);
    const t = await makeTenant({ state: 'ACTIVE_PAID', plan: 'GROWTH' });
    await ownerPool()`insert into subscriptions (workspace_id, stripe_subscription_id, plan_code, status, current_period_start, current_period_end, consent_record_id)
                      values (${t.workspaceId}, 'sub_tab', 'GROWTH', 'active', now() - interval '5 days', now() + interval '25 days', gen_random_uuid())`;
    const fin = await staff(['FINANCE']);
    expect(() => assertStaff({ roles: ['SUPPORT'] }, ACTIONS['billing.apply_coupon'].perm)).toThrow(/role/);
    expect(ACTIONS['billing.change_plan'].reauth).toBe(true);
    await act(fin, 'billing.apply_coupon', { workspaceId: t.workspaceId, coupon: 'SORRY_20', reason: 'Ticket #5: late delivery' });
    expect(gw.coupons).toEqual([{ id: 'sub_tab', coupon: 'SORRY_20' }]);
    const r = await act(fin, 'billing.change_plan', { workspaceId: t.workspaceId, plan: 'LAUNCH', consentRef: 'Ticket #6 (customer email)', reason: 'Customer asked to downgrade' });
    expect(String(r.message)).toMatch(/end of the current period/);
    const [s] = await ownerPool()`select plan_code, pending_plan_code, coupon from subscriptions where workspace_id = ${t.workspaceId}`;
    expect(s).toEqual({ plan_code: 'GROWTH', pending_plan_code: 'LAUNCH', coupon: 'SORRY_20' });
    const audits = await ownerPool()`select action from admin_audit_log where workspace_id = ${t.workspaceId} and action like 'billing.%' order by id`;
    expect(audits.map((a) => a.action)).toEqual(['billing.apply_coupon', 'billing.change_plan']);
    const [c] = await ownerPool()`select context->>'reference' as ref from consent_records where workspace_id = ${t.workspaceId}`;
    expect(c!.ref).toBe('Ticket #6 (customer email)');
  });

  it('SKU transfer needs break-glass write (🔐) and the owner consent reference', async () => {
    expect(ACTIONS['tenant.sku_transfer']).toMatchObject({ perm: 'breakglass.write', reauth: true });
    const from = await makeTenant();
    const to = await makeTenant();
    const sku = await makeSku(from.workspaceId);
    const ops = await staff(['OPS']);
    await expect(act(ops, 'tenant.sku_transfer', { workspaceId: from.workspaceId, skuId: sku, toWorkspaceId: to.workspaceId, consentRef: 'Ticket #3 owner email', reason: 'consolidating' })).rejects.toThrow(/break-glass/);
    await startBreakGlass(ops, from.workspaceId, { reasonKind: 'ticket', ticket: '3', reason: 'Owner asked to move a SKU', write: true, writeReason: 'Moving it for them' });
    const r = await act(ops, 'tenant.sku_transfer', { workspaceId: from.workspaceId, skuId: sku, toWorkspaceId: to.workspaceId, consentRef: 'Ticket #3 owner email', reason: 'consolidating' });
    expect(r.transferId).toBeTruthy();
    expect(await ownerPool()`select 1 from outbox where queue = 'transfer-sku' and workspace_id = ${from.workspaceId}`).toHaveLength(1);
  });
});

describe('users module actions (plan 05 §3)', () => {
  it('resend verification and send sign-in link email the user a fresh link, never staff, and are audited', async () => {
    const sup = await staff(['SUPPORT']);
    const [u] = await ownerPool()`insert into users (email) values ('unverified@brand.com') returning id`;
    devOutbox.length = 0;
    const r = await act(sup, 'user.resend_verification', { userId: u!.id, reason: 'Ticket #21: never got the email' });
    expect(String(r.message)).toMatch(/Verification link sent/);
    expect(devOutbox.map((m) => [m.template, m.to])).toEqual([['magic_link', 'unverified@brand.com']]);
    await ownerPool()`update users set email_verified_at = now() where id = ${u!.id}`;
    await expect(act(sup, 'user.resend_verification', { userId: u!.id, reason: 'again please' })).rejects.toThrow(/already verified/);
    await act(sup, 'user.send_login_link', { userId: u!.id, reason: 'Ticket #22: can’t sign in' });
    expect(devOutbox.filter((m) => m.template === 'magic_link').every((m) => m.to === 'unverified@brand.com')).toBe(true);
    const audits = await ownerPool()`select action, target_id from admin_audit_log where staff_id = ${sup.staffId} order by id`;
    expect(audits.map((a) => a.action)).toEqual(['user.resend_verification', 'user.send_login_link']);
    await ownerPool()`update users set locked_at = now() where id = ${u!.id}`;
    await expect(act(sup, 'user.send_login_link', { userId: u!.id, reason: 'locked user' })).rejects.toThrow(/locked/);
  });
});

describe('ad spend import (plan 05 §4 CAC)', () => {
  it('GROWTH and FINANCE import a CSV; a re-import of the same day replaces it; the import is audited', async () => {
    expect(() => assertStaff({ roles: ['SUPPORT'] }, ACTIONS['adspend.import'].perm)).toThrow(/role/);
    const g = await staff(['GROWTH']);
    const r = await act(g, 'adspend.import', { csv: 'date,campaign,spend\n2026-09-20,texture-launch,84.20\n2026-09-21,texture-launch,10', source: 'meta' });
    expect(String(r.message)).toMatch(/Imported 2 rows/);
    await act(await staff(['FINANCE']), 'adspend.import', { csv: 'date,campaign,spend,source\n2026-09-20,texture-launch,90,meta' });
    const rows = await ownerPool()`select date::text as date, spend_micros from ad_spend order by date`;
    expect(rows).toEqual([{ date: '2026-09-20', spend_micros: 90_000_000 }, { date: '2026-09-21', spend_micros: 10_000_000 }]);
    expect(await ownerPool()`select 1 from admin_audit_log where action = 'adspend.import'`).toHaveLength(2);
    await expect(act(g, 'adspend.import', { csv: 'date,campaign,spend\nnot-a-date,x,1', source: 'meta' })).rejects.toThrow(/Line 2/);
  });
});

describe('growth and finance consoles (plan 05 §5–§10)', () => {
  it('landing pages: status → live is a publish (checked), rollback keeps variants, and only GROWTH edits', async () => {
    const g = await staff(['GROWTH']);
    const slug = `act-${newId().slice(-8)}`;
    try {
      expect(() => assertStaff({ roles: ['FINANCE'] }, ACTIONS['lp.publish'].perm)).toThrow(/role/);
      const base = { label: 'Skincare · Ad testing', headline: 'Texture ads for your serum', sub: 'Three ideas in a minute.', visualAssetId: null, visualCaption: '' };
      const content = { hero: base, proof: { text: 'Built only for skincare brands', liveCounter: true, testimonialIds: [] }, howItWorks: [{ title: 'One', body: 'a' }, { title: 'Two', body: 'b' }, { title: 'Three', body: 'c' }], gallery: { items: [] }, faq: [{ q: 'What does it cost?', a: 'Free to start.' }], cta: { label: 'Start free', assurance: 'No card' } };
      await expect(act(g, 'lp.save', { slug, archetype: 'general', content: { ...content, hero: { ...base, headline: 'Brands see 3x ROAS' } }, variants: [], utmMatch: '' })).rejects.toThrow(/Compliance lint/);
      await act(g, 'lp.save', { slug, archetype: 'general', content, variants: [{ key: 'b', weight: 1, content: { hero: { headline: 'Launch your serum with a tested ad' } } }], utmMatch: 'serum', primaryMetric: 'taste_cvr', minSample: 300 });
      expect(String((await act(g, 'lp.status', { slug, status: 'live' })).message)).toMatch(/v1 is live/);
      await act(g, 'lp.save', { slug, archetype: 'general', content, variants: [], utmMatch: 'serum' });
      await act(g, 'lp.publish', { slug });
      expect(String((await act(g, 'lp.rollback', { slug, version: 1 })).message)).toMatch(/v1 is live again as v3/);
      const [p] = await ownerPool()`select status, live_version, live_variants, experiment, utm_match from landing_pages where slug = ${slug}`;
      expect(p).toMatchObject({ status: 'live', live_version: 3, experiment: { primaryMetric: 'taste_cvr', minSample: 300 }, utm_match: ['serum'] });
      expect((p!.live_variants as { key: string }[]).map((v) => v.key)).toEqual(['b']);
      expect(String((await act(g, 'lp.status', { slug, status: 'paused' })).message)).toMatch(/redirected/);
    } finally {
      await ownerPool()`delete from landing_pages where slug = ${slug}`;
    }
  });

  it('offers: experiments are started and stopped by GROWTH/FINANCE; an archived Stripe Price blocks reactivation', async () => {
    const g = await staff(['GROWTH']);
    try {
      expect(() => assertStaff({ roles: ['SUPPORT'] }, ACTIONS['offer.experiment'].perm)).toThrow(/role/);
      const r = await act(g, 'offer.experiment', { code: 'TASTE_19', experiment: { key: 'timer-test-1', variants: [{ key: 't30', weight: 1, windowMinutes: 30 }, { key: 't60', weight: 1, windowMinutes: 60 }], guardrails: { maxRefundRate: 0.1 } }, reason: 'does a shorter timer convert better?' });
      expect(String(r.message)).toMatch(/timer-test-1 running/);
      expect(String((await act(g, 'offer.experiment', { code: 'TASTE_19', experiment: null, reason: 'enough data' })).message)).toMatch(/stopped/);
      await ownerPool()`update offer_definitions set active = false, stripe_price_id = 'price_gone', stripe_price_archived_at = now(), paused_reason = 'Stripe Price price_gone archived' where code = 'TASTE_19'`;
      await expect(act(g, 'offer.active', { code: 'TASTE_19', active: true })).rejects.toThrow(/archived/);
      await ownerPool()`update offer_definitions set stripe_price_archived_at = null where code = 'TASTE_19'`;
      await act(g, 'offer.active', { code: 'TASTE_19', active: true });
      const [o] = await ownerPool()`select active, paused_reason from offer_definitions where code = 'TASTE_19'`;
      expect(o).toEqual({ active: true, paused_reason: null });
    } finally {
      await ownerPool()`update offer_definitions set active = true, stripe_price_id = null, stripe_price_archived_at = null, paused_reason = null, experiment = null, experiment_history = '[]' where code = 'TASTE_19'`;
    }
  });

  it('finance: provider invoices, reconciliation runs and exceptions, dispute evidence need FINANCE (🔐 to submit)', async () => {
    const fin = await staff(['FINANCE']);
    for (const name of ['provider_invoice.import', 'billing.recon_run', 'billing.recon_resolve', 'billing.dispute_submit'] as const) {
      expect(() => assertStaff({ roles: ['GROWTH'] }, ACTIONS[name].perm), name).toThrow(/role/);
    }
    expect(ACTIONS['billing.dispute_submit'].reauth).toBe(true);
    const month = new Date().toISOString().slice(0, 7);
    expect(String((await act(fin, 'provider_invoice.import', { provider: 'minimax', csv: `month,model,amount\n${month},speech-2.8-hd,12.50` })).message)).toMatch(/Imported 1 minimax line/);
    await act(fin, 'billing.recon_run', {});
    const [cmd] = await ownerPool()`select kind from ops_commands`;
    expect(cmd!.kind).toBe('stripe.reconcile');
    const [run] = await ownerPool()`insert into stripe_recon_runs (status) values ('completed') returning id`;
    const [e] = await ownerPool()`insert into stripe_recon_exceptions (run_id, kind, stripe_id) values (${run!.id}, 'charge_unmatched', 'ch_x') returning id`;
    await act(fin, 'billing.recon_resolve', { id: e!.id, reason: 'test charge made in the dashboard' });
    await expect(act(fin, 'billing.recon_resolve', { id: e!.id, reason: 'again please' })).rejects.toThrow(/Already resolved/);
    const audits = await ownerPool()`select action from admin_audit_log where staff_id = ${fin.staffId} order by id`;
    expect(audits.map((a) => a.action)).toEqual(['provider_invoice.import', 'ops.stripe.reconcile', 'billing.recon_resolve']);
  });

  it('providers: the registry is edited with a reason (🔐, audited); Pulse alerts are resolved by operating roles', async () => {
    const eng = await staff(['ENGINEERING']);
    try {
      expect(ACTIONS['provider.update'].reauth).toBe(true);
      expect(() => assertStaff({ roles: ['GROWTH'] }, ACTIONS['provider.update'].perm)).toThrow(/role/);
      await act(eng, 'provider.update', { name: 'minimax', status: 'degraded', region: 'global', concurrencyLimit: 4, timeoutMs: 30000, retryAttempts: 2, retryBackoffMs: 250, reason: 'provider incident #12' });
      const [p] = await ownerPool()`select status, concurrency_limit, timeout_ms, retry_attempts, updated_by from providers where name = 'minimax'`;
      expect(p).toEqual({ status: 'degraded', concurrency_limit: 4, timeout_ms: 30000, retry_attempts: 2, updated_by: eng.staffId });
      const [a] = await ownerPool()`select before, after, reason from admin_audit_log where action = 'provider.update'`;
      expect(a).toMatchObject({ reason: 'provider incident #12', before: { status: 'active' }, after: { status: 'degraded' } });
      await expect(act(eng, 'provider.update', { name: 'nope', status: 'active', concurrencyLimit: 1, timeoutMs: 1000, retryAttempts: 1, retryBackoffMs: 0, reason: 'typo test' })).rejects.toThrow(/Unknown provider/);

      expect(() => assertStaff({ roles: ['ANALYST'] }, ACTIONS['alert.resolve'].perm)).toThrow(/role/);
      const [al] = await ownerPool()`insert into platform_alerts (kind, subject_type, subject_id, message) values ('offer.stripe_price_archived', 'offer', 'TASTE_19', 'paused') returning id`;
      await act(eng, 'alert.resolve', { id: al!.id, reason: 'new version created' });
      const [r] = await ownerPool()`select resolved_by, resolution from platform_alerts where id = ${al!.id}`;
      expect(r).toEqual({ resolved_by: eng.staffId, resolution: 'new version created' });
    } finally {
      await ownerPool()`update providers set status = 'active', region = 'global', concurrency_limit = 8, timeout_ms = 60000, retry_attempts = 3, retry_backoff_ms = 500, updated_by = null where name = 'minimax'`;
    }
  });
});
