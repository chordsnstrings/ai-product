import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool } from '@arkiv/db';
import { makeSku, makeTenant, truncateAll } from '@arkiv/db/testing';
import { assertStaff, decideApproval, startBreakGlass } from '@arkiv/core';
import { MockStripe, setBillingGateway } from '@arkiv/billing';
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
    await startBreakGlass(ops, t.workspaceId, { reason: 'QA calibration sample review' });
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
      await ownerPool()`insert into eval_runs (task, prompt_version, model, dataset, status, created_by) values (${task}, 'storyboard@1.0.0', 'unpriced-model', 'compliance.scan', 'passed', ${eng.staffId})`;
      await expect(act(eng, 'route.update', { task, rolloutPct: '5', model: 'unpriced-model', reason: 'try it' })).rejects.toThrow(/No published rate for anthropic\/unpriced-model/);
    } finally {
      await ownerPool()`update model_routes set canary = null`;
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

  it('allowlist keys are normalised so the heuristics recognise them', async () => {
    const c = await staff(['COMPLIANCE']);
    await act(c, 'abuse.allowlist', { key: '203.0.113.77', reason: 'agency evaluating 12 SKUs', days: 30 });
    await act(c, 'abuse.allowlist', { key: 'buyer@Agency.com', reason: 'agency evaluating 12 SKUs', days: 7 });
    const keys = await ownerPool()`select key from abuse_allowlist order by key`;
    expect(keys.map((k) => k.key)).toEqual(['domain:agency.com', 'ip:203.0.113']);
  });
});
