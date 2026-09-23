import { z } from 'zod';
import { withAdmin } from '@arkiv/db';
import { assertFreshReauth, createStaff, deprovisionStaff, revokeAllSessions } from '@arkiv/auth';
import {
  addTenantNote,
  approveClaim,
  assertBreakGlass,
  assertStaff,
  audit,
  blockClaim,
  cancelProjectBeforeDispatch,
  cancelTenantPurge,
  classifyClaim,
  clearSettingsCache,
  decideApproval,
  endBreakGlass,
  enqueue,
  GOLDEN,
  normalizeAllowKey,
  QA_VERDICT_KEY,
  Queues,
  registerExecutor,
  requestOpsCommand,
  requestOrExecute,
  retryProjectProduction,
  scanCreativeText,
  scheduleTenantPurge,
  SETTING_DEFAULTS,
  setTenantFlags,
  setTenantHold,
  startBreakGlass,
  suppressRiskFlag,
  validateEligibility,
  type Permission,
  type SettingKey,
} from '@arkiv/core';
import { billingGateway, processStripeEvent, refundPayment } from '@arkiv/billing';
import { sendEmail } from '@arkiv/email';
import { DataRequestKind, DomainError, env, newId, RefundReason, StaffRole } from '@arkiv/shared';
import type { StaffUser } from './staff';

/**
 * Every console mutation goes through this registry: permission check, optional 🔐 fresh second factor,
 * input schema, and an audit record (inside the domain functions or here). Four-eyes actions route through
 * requestOrExecute → approvals.
 */
interface Action<S extends z.ZodType> {
  perm: Permission;
  reauth?: boolean;
  schema: S;
  run: (s: StaffUser, input: z.infer<S>) => Promise<unknown>;
}
const a = <S extends z.ZodType>(x: Action<S>) => x;
const uuid = z.string().uuid();
const reason = z.string().trim().min(4, 'A reason is required');

// ── Executors that need packages core can't import (billing) ──
// Refund tool (§7): one idempotent operation — Stripe refund + refunds mirror + CREDIT_REFUNDED (see billing/refunds).
registerExecutor('billing.refund', (p, who) =>
  refundPayment(
    {
      workspaceId: p.workspaceId as string,
      purchaseId: (p.purchaseId as string) ?? null,
      invoiceEventId: (p.invoiceEventId as string) ?? null,
      amountMicros: Number(p.amountMicros),
      reasonCode: p.reasonCode as RefundReason,
      customerNote: (p.customerNote as string) ?? null,
      nonce: p.nonce as string,
      reason: p.reason as string,
    },
    who,
  ),
);

registerExecutor('stripe.assign', async (p, { approver }) => {
  const [e] = await withAdmin((tx) => tx`select * from stripe_events where id = ${p.eventId as string}`);
  if (!e || e.status !== 'unmatched') throw new DomainError('CONFLICT', 'Event is not unmatched');
  const customer = ((e.payload as { data: { object: { customer?: string } } }).data.object.customer as string) ?? null;
  await withAdmin(async (tx) => {
    if (customer) await tx`insert into stripe_customers (customer_id, workspace_id) values (${customer}, ${p.workspaceId as string}) on conflict (customer_id) do nothing`;
    await tx`update stripe_events set status = 'received', workspace_id = ${p.workspaceId as string} where id = ${e.id}`;
    await audit(tx, approver, 'stripe.assigned', { type: 'stripe_event', id: e.id as string }, { workspaceId: p.workspaceId as string, reason: p.reason as string });
  });
  return { outcome: await processStripeEvent(e.id as string) };
});

// ── Compliance lint for marketing content (plan 05 §5): no unsubstantiated outcome claims, no fake proof ──
const MARKETING_BANNED = [
  { re: /\b\d+(\.\d+)?\s*[x×]\s*(roas|return|revenue|sales|conversions?)\b/i, why: 'Customer-result multiples need substantiation.' },
  { re: /\bguarantee(d|s)?\b/i, why: 'Guarantees are only allowed if they are real, written policies.' },
  { re: /\b(only|just)\s+\d+\s+(spots?|left|remaining)\b/i, why: 'Scarcity must be real; the system has no such limit.' },
  { re: /\b(thousands|millions|\d{2,}[,\d]*)\s+(of\s+)?(brands|customers|users)\b/i, why: 'Usage numbers must come from live data, not copy.' },
  { re: /\b(rated|voted)\s+#?1\b/i, why: 'Rankings need a verifiable source.' },
];
function lintMarketing(content: unknown): string[] {
  const text = JSON.stringify(content);
  const out = MARKETING_BANNED.filter((b) => b.re.test(text)).map((b) => b.why);
  const scan = scanCreativeText(text.split(/(?<=[.!?"])\s+/).slice(0, 200), []);
  if (!scan.ok) out.push(...scan.violations.map((v) => `“${v.text.slice(0, 60)}”: ${v.reason}`));
  return out;
}

/** "support, ops" → ['SUPPORT','OPS']; unknown names are rejected rather than silently dropped. */
function parseRoles(raw: string): StaffRole[] {
  const roles = [...new Set(raw.split(',').map((r) => r.trim().toUpperCase()).filter(Boolean))];
  const unknown = roles.filter((r) => !(StaffRole as readonly string[]).includes(r));
  if (unknown.length) throw new DomainError('INVALID', `Unknown role ${unknown.join(', ')}. Roles: ${StaffRole.join(', ')}.`);
  return roles as StaffRole[];
}

async function ownerEmails(workspaceId: string) {
  return withAdmin((tx) => tx`select u.email from memberships m join users u on u.id = m.user_id where m.workspace_id = ${workspaceId} and m.role in ('OWNER','ADMIN')`).then((r) => r.map((x) => x.email as string));
}

export const ACTIONS = {
  /* ── Approvals ── */
  'approval.decide': a({ perm: 'approvals.read', reauth: true, schema: z.object({ id: uuid, approve: z.boolean(), note: z.string().max(500).optional() }), run: (s, i) => decideApproval(s, i.id, i.approve, i.note) }),

  /* ── Tenants ── */
  'tenant.hold': a({ perm: 'tenant.state', reauth: true, schema: z.object({ workspaceId: uuid, hold: z.enum(['SUSPENDED', 'LOCKED', 'LIFT']), reason }), run: (s, i) => setTenantHold(s, i.workspaceId, i.hold, i.reason) }),
  'tenant.flags': a({ perm: 'tenant.flags', schema: z.object({ workspaceId: uuid, isVip: z.boolean().optional(), isTest: z.boolean().optional(), tags: z.string().optional() }), run: (s, i) => setTenantFlags(s, i.workspaceId, { isVip: i.isVip, isTest: i.isTest, tags: i.tags === undefined ? undefined : i.tags.split(',').map((t) => t.trim()).filter(Boolean) }) }),
  'tenant.note': a({ perm: 'tenant.note', schema: z.object({ workspaceId: uuid, body: z.string().min(1).max(4000), sentiment: z.enum(['positive', 'neutral', 'negative']).optional() }), run: (s, i) => addTenantNote(s, i.workspaceId, i.body, i.sentiment ?? null) }),
  'tenant.breakglass': a({
    perm: 'breakglass.read',
    schema: z.object({ workspaceId: uuid, reason: z.string().min(8), ticket: z.string().max(40).optional(), write: z.boolean().optional(), writeReason: z.string().optional() }),
    run: async (s, i) => {
      if (i.write) assertFreshReauth(s);
      const r = await startBreakGlass(s, i.workspaceId, i);
      for (const to of await ownerEmails(i.workspaceId)) {
        await sendEmail('staff_break_glass', to, { staffName: s.name, reason: i.reason, when: new Date().toUTCString(), url: `${env().APP_URL}/app` }, { idempotencyKey: `bg:${r.id}:${to}`, workspaceId: i.workspaceId }).catch(() => {});
      }
      return { ...r, message: `Access until ${new Date(r.expiresAt).toLocaleTimeString()}; the customer can see this in their access log.` };
    },
  }),
  'tenant.breakglass_end': a({ perm: 'breakglass.read', schema: z.object({ workspaceId: uuid }), run: (s, i) => endBreakGlass(s, i.workspaceId) }),
  'tenant.purge_now': a({ perm: 'tenant.purge', reauth: true, schema: z.object({ workspaceId: uuid, reason }), run: (s, i) => requestOrExecute(s, 'workspace.purge_now', { workspaceId: i.workspaceId }, i.reason) }),
  'tenant.schedule_purge': a({ perm: 'tenant.purge', reauth: true, schema: z.object({ workspaceId: uuid, reason }), run: (s, i) => scheduleTenantPurge(s, i.workspaceId, i.reason) }),
  'tenant.cancel_purge': a({
    perm: 'tenant.purge',
    schema: z.object({ workspaceId: uuid, reason }),
    run: async (s, i) => ({ message: `Purge cancelled; workspace restored to ${(await cancelTenantPurge(s, i.workspaceId, i.reason)).toLowerCase()}.` }),
  }),
  'tenant.export': a({
    perm: 'tenant.state',
    reauth: true,
    schema: z.object({ workspaceId: uuid, reason }),
    run: (s, i) =>
      withAdmin(async (tx) => {
        await enqueue(tx, i.workspaceId, Queues.exportWorkspace, { requestedBy: { kind: 'staff', id: s.staffId } }, { singletonKey: `export:${i.workspaceId}` });
        await audit(tx, s, 'tenant.export', { type: 'workspace', id: i.workspaceId }, { workspaceId: i.workspaceId, reason: i.reason });
        return { message: 'Export queued; the link is emailed to workspace owners.' };
      }),
  }),
  'tenant.ledger_adjust': a({
    perm: 'ledger.adjust',
    reauth: true,
    schema: z.object({ workspaceId: uuid, unit: z.enum(['creative_test', 'taste', 'standalone']), amount: z.number().int().refine((n) => n !== 0, 'Amount cannot be 0'), reason }),
    run: (s, i) => requestOrExecute(s, 'ledger.adjust', { workspaceId: i.workspaceId, unit: i.unit, amount: i.amount, nonce: newId() }, i.reason),
  }),
  'tenant.transfer_owner': a({
    perm: 'tenant.state',
    reauth: true,
    schema: z.object({ workspaceId: uuid, userId: uuid, reason }),
    run: (s, i) =>
      withAdmin(async (tx) => {
        const [m] = await tx`select role from memberships where workspace_id = ${i.workspaceId} and user_id = ${i.userId}`;
        if (!m) throw new DomainError('NOT_FOUND', 'That user is not a member');
        const prev = await tx`update memberships set role = 'ADMIN' where workspace_id = ${i.workspaceId} and role = 'OWNER' returning user_id`;
        await tx`update memberships set role = 'OWNER' where workspace_id = ${i.workspaceId} and user_id = ${i.userId}`;
        await tx`update workspaces set membership_version = membership_version + 1 where id = ${i.workspaceId}`;
        await tx`insert into events (workspace_id, type, actor, subject_type, subject_id, payload) values (${i.workspaceId}, 'MEMBER_ROLE_CHANGED', ${`staff:${s.staffId}`}, 'user', ${i.userId}, ${tx.json({ to: 'OWNER', from: prev.map((p) => p.user_id as string), reason: i.reason })})`;
        await audit(tx, s, 'tenant.transfer_owner', { type: 'workspace', id: i.workspaceId }, { workspaceId: i.workspaceId, reason: i.reason, before: prev, after: { owner: i.userId } });
        const emails = await tx`select email from users where id in ${tx([i.userId, ...prev.map((p) => p.user_id as string)])}`;
        for (const e of emails) await sendEmail('security_alert', e.email as string, { event: 'Workspace ownership was transferred by Arkiv support', when: new Date().toUTCString(), url: `${env().APP_URL}/app` }, { idempotencyKey: `owner:${i.workspaceId}:${i.userId}:${e.email}` }).catch(() => {});
      }),
  }),
  'tenant.invite_revoke': a({ perm: 'tenant.flags', schema: z.object({ workspaceId: uuid, inviteId: uuid }), run: (s, i) => withAdmin(async (tx) => { await tx`update invites set revoked_at = now() where id = ${i.inviteId} and workspace_id = ${i.workspaceId}`; await audit(tx, s, 'tenant.invite_revoke', { type: 'invite', id: i.inviteId }, { workspaceId: i.workspaceId }); }) }),
  'tenant.integration_sync': a({ perm: 'integrations.manage', schema: z.object({ workspaceId: uuid, integrationId: uuid }), run: (s, i) => withAdmin(async (tx) => { await enqueue(tx, i.workspaceId, Queues.syncIntegration, { integrationId: i.integrationId, full: true }, { singletonKey: `sync:${i.integrationId}` }); await audit(tx, s, 'integration.resync', { type: 'integration', id: i.integrationId }, { workspaceId: i.workspaceId }); }) }),
  'tenant.integration_status': a({ perm: 'integrations.manage', schema: z.object({ workspaceId: uuid, integrationId: uuid, status: z.enum(['active', 'paused', 'degraded']), reason }), run: (s, i) => withAdmin(async (tx) => { await tx`update integrations set status = ${i.status} where id = ${i.integrationId} and workspace_id = ${i.workspaceId}`; await audit(tx, s, 'integration.status', { type: 'integration', id: i.integrationId }, { workspaceId: i.workspaceId, reason: i.reason, after: { status: i.status } }); }) }),
  'tenant.risk_suppress': a({
    perm: 'tenant.flags',
    schema: z.object({ workspaceId: uuid, flagId: uuid, reason, days: z.number().int().min(1).max(180).default(30) }),
    run: async (s, i) => {
      const r = await suppressRiskFlag(s, i.workspaceId, i.flagId, i.reason, i.days);
      return { message: `Suppressed until ${new Date(r.suppressedUntil).toDateString()}.` };
    },
  }),
  /* Experiments & jobs tab (§2.2): retry a failed production within entitlement; cancel before dispatch. */
  'tenant.project_retry': a({ perm: 'jobs.manage', schema: z.object({ workspaceId: uuid, projectId: uuid, reason }), run: (s, i) => retryProjectProduction(s, i.workspaceId, i.projectId, i.reason) }),
  'tenant.project_cancel': a({ perm: 'jobs.manage', schema: z.object({ workspaceId: uuid, projectId: uuid, reason }), run: (s, i) => cancelProjectBeforeDispatch(s, i.workspaceId, i.projectId, i.reason) }),

  /* ── Users ── */
  'user.lock': a({ perm: 'users.lock', reauth: true, schema: z.object({ userId: uuid, reason }), run: (s, i) => withAdmin(async (tx) => { await tx`update users set locked_at = now(), locked_reason = ${i.reason} where id = ${i.userId}`; await tx`update sessions set revoked_at = now() where user_id = ${i.userId} and revoked_at is null`; await audit(tx, s, 'user.lock', { type: 'user', id: i.userId }, { reason: i.reason }); }) }),
  'user.unlock': a({ perm: 'users.lock', reauth: true, schema: z.object({ userId: uuid, reason }), run: (s, i) => withAdmin(async (tx) => { await tx`update users set locked_at = null, locked_reason = null where id = ${i.userId}`; await audit(tx, s, 'user.unlock', { type: 'user', id: i.userId }, { reason: i.reason }); }) }),
  'user.force_logout': a({ perm: 'users.read', schema: z.object({ userId: uuid, reason }), run: async (s, i) => { await revokeAllSessions(i.userId); await withAdmin((tx) => audit(tx, s, 'user.force_logout', { type: 'user', id: i.userId }, { reason: i.reason })); } }),

  /* ── Billing ── */
  'billing.refund': a({
    perm: 'billing.refund',
    reauth: true,
    schema: z
      .object({
        workspaceId: uuid,
        purchaseId: uuid.optional(),
        invoiceEventId: z.string().min(3).optional(),
        amount: z.number().positive(),
        reasonCode: z.enum(RefundReason),
        customerNote: z.string().max(500).optional(),
        reason,
      })
      .refine((x) => !!x.purchaseId !== !!x.invoiceEventId, 'Choose exactly one payment to refund'),
    // The nonce is minted once per request, so a replay after approval (or a retried click) never refunds twice.
    run: (s, i) => requestOrExecute(s, 'billing.refund', { workspaceId: i.workspaceId, purchaseId: i.purchaseId ?? null, invoiceEventId: i.invoiceEventId ?? null, amountMicros: Math.round(i.amount * 1e6), reasonCode: i.reasonCode, customerNote: i.customerNote ?? null, nonce: newId() }, i.reason),
  }),
  'billing.stripe_assign': a({ perm: 'billing.unmatched', reauth: true, schema: z.object({ eventId: z.string(), workspaceId: uuid, reason }), run: (s, i) => requestOrExecute(s, 'stripe.assign', { eventId: i.eventId, workspaceId: i.workspaceId }, i.reason) }),
  'billing.stripe_ignore': a({ perm: 'billing.unmatched', schema: z.object({ eventId: z.string(), reason }), run: (s, i) => withAdmin(async (tx) => { await tx`update stripe_events set status = 'ignored', error = ${i.reason}, processed_at = now() where id = ${i.eventId} and status = 'unmatched'`; await audit(tx, s, 'stripe.ignored', { type: 'stripe_event', id: i.eventId }, { reason: i.reason }); }) }),
  'billing.portal': a({ perm: 'billing.read', schema: z.object({ workspaceId: uuid }), run: async (s, i) => { const [c] = await withAdmin((tx) => tx`select customer_id from stripe_customers where workspace_id = ${i.workspaceId}`); if (!c) throw new DomainError('NOT_FOUND', 'No Stripe customer'); await withAdmin((tx) => audit(tx, s, 'billing.open_stripe', { type: 'workspace', id: i.workspaceId }, { workspaceId: i.workspaceId })); return { url: billingGateway().live ? `https://dashboard.stripe.com/customers/${c.customer_id}` : `${env().ADMIN_URL}/billing?customer=${c.customer_id}` }; } }),

  /* ── Rates ── */
  'rates.propose': a({
    perm: 'rates.propose',
    schema: z.object({ provider: z.string().min(2), model: z.string().min(2), unit: z.string().min(2), rates: z.record(z.string(), z.number().nonnegative()), sourceUrl: z.string().url().optional(), notes: z.string().max(500).optional(), effectiveFrom: z.string().optional() }),
    run: (s, i) =>
      withAdmin(async (tx) => {
        const [v] = await tx`select coalesce(max(version), 0) + 1 as v from provider_rate_tables where provider = ${i.provider} and model = ${i.model}`;
        const [r] = await tx`insert into provider_rate_tables (provider, model, version, unit, rates, effective_from, source_url, notes, status, created_by)
                             values (${i.provider}, ${i.model}, ${v!.v}, ${i.unit}, ${tx.json(i.rates)}, ${i.effectiveFrom ?? new Date().toISOString()}, ${i.sourceUrl ?? null}, ${i.notes ?? null}, 'draft', ${s.staffId}) returning id`;
        await audit(tx, s, 'rates.proposed', { type: 'rate_table', id: r!.id as string }, { after: i });
        return { id: r!.id, message: `Draft v${v!.v} created. Publishing needs a second approver.` };
      }),
  }),
  'rates.publish': a({ perm: 'rates.propose', reauth: true, schema: z.object({ rateTableId: uuid, reason }), run: (s, i) => requestOrExecute(s, 'rates.publish', { rateTableId: i.rateTableId }, i.reason) }),

  /* ── Providers & routes ── */
  'route.circuit': a({ perm: 'providers.circuit', schema: z.object({ task: z.string(), open: z.boolean(), reason }), run: (s, i) => withAdmin(async (tx) => { const [b] = await tx`select circuit_open from model_routes where task = ${i.task}`; await tx`update model_routes set circuit_open = ${i.open}, updated_at = now() where task = ${i.task}`; await audit(tx, s, i.open ? 'route.circuit_open' : 'route.circuit_close', { type: 'route', id: i.task }, { reason: i.reason, before: b, after: { circuit_open: i.open } }); }) }),
  'route.update': a({
    perm: 'routes.manage',
    reauth: true,
    schema: z.object({ task: z.string(), rolloutPct: z.number().int().min(0).max(100), model: z.string().optional(), promptVersion: z.string().optional(), reason }),
    run: async (s, i) => {
      const dataset = GOLDEN[i.task] ? i.task : i.task.startsWith('compliance') || i.task.startsWith('creative_director') ? 'compliance.scan' : null;
      if (dataset) {
        const [ev] = await withAdmin((tx) => tx`select status from eval_runs where dataset = ${dataset} and created_at > now() - interval '7 days' order by created_at desc limit 1`);
        if (ev?.status !== 'passed') throw new DomainError('CONFLICT', `Run a passing ${dataset} eval (within 7 days) before changing this route.`);
      }
      if (i.rolloutPct >= 100) return requestOrExecute(s, 'route.promote', { task: i.task, rolloutPct: i.rolloutPct, model: i.model ?? null, promptVersion: i.promptVersion ?? null }, i.reason);
      return withAdmin(async (tx) => {
        const [b] = await tx`select * from model_routes where task = ${i.task}`;
        await tx`update model_routes set canary = ${tx.json({ model: i.model ?? b?.model, promptVersion: i.promptVersion ?? b?.prompt_version, pct: i.rolloutPct })}, updated_at = now() where task = ${i.task}`;
        await audit(tx, s, 'route.canary', { type: 'route', id: i.task }, { reason: i.reason, before: b, after: i });
        return { message: `Canary at ${i.rolloutPct}%` };
      });
    },
  }),
  'eval.run': a({ perm: 'evals.run', schema: z.object({ dataset: z.string(), reason: z.string().default('manual eval run') }), run: async (s, i) => { if (!GOLDEN[i.dataset]) throw new DomainError('INVALID', 'Unknown dataset'); const [r] = await withAdmin((tx) => tx`insert into eval_runs (task, prompt_version, model, dataset, status, created_by) values (${i.dataset}, 'rules', 'deterministic', ${i.dataset}, 'queued', ${s.staffId}) returning id`); await requestOpsCommand(s, 'eval.run', { dataset: i.dataset, evalRunId: r!.id }, i.reason); return { message: 'Eval queued; results appear in a few seconds.' }; } }),

  /* ── Jobs ── */
  // SUPPORT may retry no-spend queues only; requestOpsCommand enforces the queue check.
  'job.retry': a({ perm: 'jobs.retry_nospend', schema: z.object({ queue: z.string(), jobId: z.string(), workspaceId: uuid.optional(), reason }), run: (s, i) => requestOpsCommand(s, 'job.retry', i, i.reason).then(() => ({ message: 'Retry queued' })) }),
  'job.cancel': a({ perm: 'jobs.manage', schema: z.object({ queue: z.string(), jobId: z.string(), workspaceId: uuid.optional(), reason }), run: (s, i) => requestOpsCommand(s, 'job.cancel', i, i.reason).then(() => ({ message: 'Cancel queued' })) }),
  'dlq.requeue': a({ perm: 'jobs.manage', reauth: true, schema: z.object({ queue: z.string(), limit: z.number().int().min(1).max(1000).default(100), reason }), run: (s, i) => requestOpsCommand(s, 'dlq.requeue', { queue: i.queue, limit: i.limit }, i.reason).then(() => ({ message: 'Redrive queued' })) }),

  'integration.verify': a({ perm: 'integrations.manage', schema: z.object({}), run: (s) => requestOpsCommand(s, 'integration.verify_webhooks', {}, 'nightly check run manually').then(() => ({ message: 'Verification queued' })) }),

  /* ── QA review (content → break-glass) ── */
  'qa.review': a({
    perm: 'qa.review',
    schema: z.object({
      workspaceId: uuid,
      projectId: uuid,
      // Keyed "<#>:<check>" (position in the stored report), since several scene checks share a name.
      verdicts: z.record(z.string().regex(QA_VERDICT_KEY, 'Verdict keys look like "1:product_fidelity"'), z.enum(['agree', 'disagree'])),
      failureLabel: z.string().max(60).optional(),
      notes: z.string().max(1000).optional(),
    }),
    run: (s, i) =>
      withAdmin(async (tx) => {
        await assertBreakGlass(tx, s, i.workspaceId, `qa review ${i.projectId}`);
        const [p] = await tx`select qa_report from projects where id = ${i.projectId} and workspace_id = ${i.workspaceId}`;
        if (!p) throw new DomainError('NOT_FOUND', 'Project not found');
        const stored = ((p.qa_report as { checks?: { check: string }[] } | null)?.checks ?? []).map((c, n) => `${n + 1}:${c.check}`);
        const unknown = Object.keys(i.verdicts).filter((k) => !stored.includes(k));
        if (unknown.length) throw new DomainError('INVALID', `No such check in this QA report: ${unknown.join(', ')}`);
        await tx`insert into qa_reviews (workspace_id, project_id, staff_id, verdicts, failure_label, notes) values (${i.workspaceId}, ${i.projectId}, ${s.staffId}, ${tx.json(i.verdicts)}, ${i.failureLabel ?? null}, ${i.notes ?? null})`;
        await audit(tx, s, 'qa.review', { type: 'project', id: i.projectId }, { workspaceId: i.workspaceId, after: i.verdicts });
      }),
  }),

  /* ── Claims (tenant routed these to our compliance team; views are audited as content access) ── */
  'claim.decide': a({
    perm: 'claims.review',
    schema: z.object({ workspaceId: uuid, claimId: uuid, decision: z.enum(['approve', 'block', 'unblock']), wording: z.string().max(200).optional(), qualifier: z.string().max(200).optional(), platforms: z.string().default('meta,tiktok'), reason }),
    run: async (s, i) => {
      if (i.decision === 'unblock') return requestOrExecute(s, 'claim.unblock', { workspaceId: i.workspaceId, claimId: i.claimId }, i.reason);
      return withAdmin(async (tx) => {
        const ctx = { workspaceId: i.workspaceId, workspaceState: 'ACTIVE_PAID' as const, role: 'OWNER' as const, actor: { kind: 'staff' as const, id: s.staffId }, requestId: newId() };
        if (i.decision === 'block') await blockClaim(tx, ctx, i.claimId, i.reason);
        else await approveClaim(tx, ctx, i.claimId, { markets: ['US'], platforms: i.platforms.split(',').map((p) => p.trim()), qualifier: i.qualifier ?? null, wording: i.wording });
        await audit(tx, s, `claim.${i.decision}`, { type: 'claim', id: i.claimId }, { workspaceId: i.workspaceId, reason: i.reason, after: { wording: i.wording, qualifier: i.qualifier } });
        const [c] = await tx`select preferred_wording from claims where id = ${i.claimId}`;
        for (const to of await ownerEmails(i.workspaceId)) await sendEmail('claim_review_result', to, { claim: c?.preferred_wording as string, outcome: i.decision === 'block' ? `Blocked: ${i.reason}` : 'Approved for use', url: `${env().APP_URL}/app` }, { idempotencyKey: `claimrev:${i.claimId}:${i.decision}:${to}`, workspaceId: i.workspaceId }).catch(() => {});
      });
    },
  }),
  'claim.check': a({ perm: 'claims.review', schema: z.object({ text: z.string().min(1).max(300) }), run: async (_s, i) => ({ message: JSON.stringify(classifyClaim(i.text)) }) }),

  /* ── Abuse & rights ── */
  // Keys are normalised (ip:/24, domain:, ws:) so the multi-SKU and rate-limit heuristics recognise them.
  'abuse.allowlist': a({
    perm: 'abuse.manage',
    schema: z.object({ key: z.string().min(3), days: z.number().int().min(1).max(30).default(30), reason }),
    run: (s, i) =>
      withAdmin(async (tx) => {
        const key = normalizeAllowKey(i.key);
        await tx`insert into abuse_allowlist (key, reason, until, created_by) values (${key}, ${i.reason}, now() + make_interval(days => ${i.days}), ${s.staffId}) on conflict (key) do update set reason = excluded.reason, until = excluded.until, created_by = excluded.created_by`;
        await audit(tx, s, 'abuse.allowlist', { type: 'key', id: key }, { reason: i.reason, after: { days: i.days } });
        return { message: `Allowlisted ${key} for ${i.days} days.` };
      }),
  }),
  'abuse.allowlist_remove': a({ perm: 'abuse.manage', schema: z.object({ key: z.string().min(3), reason }), run: (s, i) => withAdmin(async (tx) => { await tx`delete from abuse_allowlist where key = ${i.key}`; await audit(tx, s, 'abuse.allowlist_remove', { type: 'key', id: i.key }, { reason: i.reason }); }) }),
  'rights.create': a({ perm: 'abuse.manage', schema: z.object({ complainant: z.string().min(2), detail: z.string().min(5), workspaceId: uuid.optional(), assetId: uuid.optional() }), run: (s, i) => withAdmin(async (tx) => { const [c] = await tx`insert into rights_cases (complainant, detail, workspace_id, asset_id, created_by) values (${i.complainant}, ${i.detail}, ${i.workspaceId ?? null}, ${i.assetId ?? null}, ${s.staffId}) returning id`; await audit(tx, s, 'rights.create', { type: 'rights_case', id: c!.id as string }, { workspaceId: i.workspaceId ?? null }); }) }),
  'rights.update': a({
    perm: 'abuse.manage',
    schema: z.object({ id: uuid, status: z.enum(['frozen', 'resolved_kept', 'resolved_removed']), resolution: z.string().max(1000).optional() }),
    run: (s, i) =>
      withAdmin(async (tx) => {
        const [c] = await tx`update rights_cases set status = ${i.status}, resolution = ${i.resolution ?? null}, resolved_at = case when ${i.status} like 'resolved%' then now() end where id = ${i.id} returning asset_id, workspace_id`;
        // Freezing marks the asset's rights expired so it can't be used in new production.
        if (c?.asset_id && i.status !== 'resolved_kept') await tx`update assets set rights_expires_at = now() where id = ${c.asset_id}`;
        await audit(tx, s, `rights.${i.status}`, { type: 'rights_case', id: i.id }, { workspaceId: (c?.workspace_id as string) ?? null, reason: i.resolution ?? null });
      }),
  }),

  /* ── Growth: landing pages, offers, testimonials ── */
  'lp.save': a({
    perm: 'growth.manage',
    schema: z.object({ slug: z.string().regex(/^[a-z0-9-]{2,40}$/), archetype: z.string().min(2), content: z.record(z.string(), z.unknown()), variants: z.array(z.object({ key: z.string(), weight: z.number().min(0), content: z.record(z.string(), z.unknown()) })).default([]), utmMatch: z.string().default('') }),
    run: (s, i) =>
      withAdmin(async (tx) => {
        const lint = lintMarketing([i.content, i.variants]);
        if (lint.length) throw new DomainError('GATE_BLOCKED', `Compliance lint: ${lint.join(' ')}`);
        const [before] = await tx`select * from landing_pages where slug = ${i.slug} for update`;
        const utm = i.utmMatch.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
        if (before) {
          await tx`update landing_pages set archetype = ${i.archetype}, content = ${tx.json(i.content as never)}, variants = ${tx.json(i.variants as never)}, utm_match = ${utm},
                     version = version + 1, history = history || ${tx.json([{ version: before.version, content: before.content, variants: before.variants, at: new Date().toISOString(), by: s.email }] as never)},
                     published_at = case when status = 'live' then now() else published_at end, updated_at = now() where slug = ${i.slug}`;
        } else {
          await tx`insert into landing_pages (slug, archetype, status, content, variants, utm_match) values (${i.slug}, ${i.archetype}, 'draft', ${tx.json(i.content as never)}, ${tx.json(i.variants as never)}, ${utm})`;
        }
        await audit(tx, s, 'lp.save', { type: 'landing_page', id: i.slug }, { before: before?.content ?? null, after: i.content });
        return { message: before ? `Saved v${Number(before.version) + 1}` : 'Draft created' };
      }),
  }),
  'lp.status': a({ perm: 'growth.manage', schema: z.object({ slug: z.string(), status: z.enum(['draft', 'live', 'paused']) }), run: (s, i) => withAdmin(async (tx) => { if (i.slug === 'default' && i.status !== 'live') throw new DomainError('CONFLICT', 'The default page must stay live (paused pages redirect to it).'); await tx`update landing_pages set status = ${i.status}, published_at = case when ${i.status} = 'live' then now() else published_at end where slug = ${i.slug}`; await audit(tx, s, 'lp.status', { type: 'landing_page', id: i.slug }, { after: { status: i.status } }); }) }),
  'lp.rollback': a({ perm: 'growth.manage', schema: z.object({ slug: z.string(), version: z.number().int() }), run: (s, i) => withAdmin(async (tx) => { const [p] = await tx`select history, content, version from landing_pages where slug = ${i.slug} for update`; const h = (p?.history as { version: number; content: unknown; variants: unknown }[]) ?? []; const v = h.find((x) => x.version === i.version); if (!v) throw new DomainError('NOT_FOUND', 'Version not found'); await tx`update landing_pages set content = ${tx.json(v.content as never)}, variants = ${tx.json(v.variants as never)}, version = version + 1, history = history || ${tx.json([{ version: p!.version, content: p!.content, at: new Date().toISOString(), by: s.email }] as never)} where slug = ${i.slug}`; await audit(tx, s, 'lp.rollback', { type: 'landing_page', id: i.slug }, { after: { toVersion: i.version } }); }) }),
  'offer.create': a({
    perm: 'offers.manage',
    schema: z.object({
      code: z.string().regex(/^[A-Z0-9_]{3,40}$/),
      type: z.enum(['TASTE', 'STANDALONE', 'PLAN_UPGRADE', 'WIN_BACK']),
      price: z.number().positive(),
      currency: z.literal('USD').default('USD'), // USD only in V1 (plan 05 §6)
      referenceCode: z.string().optional(),
      windowMinutes: z.number().int().min(5).max(10080).optional(),
      bonus: z.record(z.string(), z.unknown()).default({}),
      eligibility: z.record(z.string(), z.unknown()).default({}),
      nextOfferPolicy: z.object({ next: z.string().regex(/^[A-Z0-9_]{3,40}$/).optional() }).strict().default({}),
      stripePriceId: z.string().regex(/^price_[A-Za-z0-9_]+$/, 'Stripe Price IDs start with price_').optional(),
    }),
    run: (s, i) =>
      withAdmin(async (tx) => {
        const priceMicros = Math.round(i.price * 1e6);
        validateEligibility(i.eligibility);
        if (i.referenceCode) {
          // Honest anchoring: the reference must be the price we actually charge for its type today (its latest
          // active version), and above this price.
          const [ref] = await tx`select type, price_micros, active from offer_definitions where code = ${i.referenceCode}`;
          if (!ref || !ref.active) throw new DomainError('GATE_BLOCKED', 'Reference price must be an active, purchasable price.');
          const [cur] = await tx`select code from offer_definitions where type = ${ref.type} and active order by version desc, created_at desc limit 1`;
          if (cur?.code !== i.referenceCode) throw new DomainError('GATE_BLOCKED', `Reference must be the price currently charged for ${String(ref.type).toLowerCase()} (${cur?.code as string}).`);
          if (Number(ref.price_micros) <= priceMicros) throw new DomainError('GATE_BLOCKED', 'Reference price must be higher than the offer price.');
        }
        if (i.nextOfferPolicy.next) {
          const [n] = await tx`select type from offer_definitions where code = ${i.nextOfferPolicy.next}`;
          if (!n) throw new DomainError('INVALID', `Next offer ${i.nextOfferPolicy.next} doesn’t exist.`);
        }
        const [exists] = await tx`select 1 from offer_definitions where code = ${i.code}`;
        if (exists) throw new DomainError('CONFLICT', 'Code exists. Prices on existing offers can’t be edited — create a new code (version).');
        // Versions are per type; the engine uses the latest active version whose eligibility matches.
        const [v] = await tx`select coalesce(max(version), 0) + 1 as v from offer_definitions where type = ${i.type}`;
        await tx`insert into offer_definitions (code, type, price_micros, currency, reference_code, window_minutes, bonus, eligibility, next_offer_policy, stripe_price_id, version)
                 values (${i.code}, ${i.type}, ${priceMicros}, ${i.currency}, ${i.referenceCode ?? null}, ${i.windowMinutes ?? null}, ${tx.json(i.bonus as never)},
                         ${tx.json(i.eligibility as never)}, ${tx.json(i.nextOfferPolicy as never)}, ${i.stripePriceId ?? null}, ${Number(v!.v)})`;
        await audit(tx, s, 'offer.create', { type: 'offer', id: i.code }, { after: { ...i, version: Number(v!.v) } });
        return { message: `Created ${i.code} as ${i.type.toLowerCase()} v${v!.v}. New customers get it once it’s the latest active eligible version.` };
      }),
  }),
  'offer.active': a({ perm: 'offers.manage', schema: z.object({ code: z.string(), active: z.boolean() }), run: (s, i) => withAdmin(async (tx) => { if (!i.active) { const refs = await tx`select code from offer_definitions where reference_code = ${i.code} and active`; if (refs.length) throw new DomainError('CONFLICT', `Active offers anchor to this price: ${refs.map((r) => r.code).join(', ')}. Pause them first.`); } await tx`update offer_definitions set active = ${i.active}, updated_at = now() where code = ${i.code}`; await audit(tx, s, 'offer.active', { type: 'offer', id: i.code }, { after: { active: i.active } }); }) }),
  'testimonial.create': a({ perm: 'growth.manage', schema: z.object({ quote: z.string().min(10).max(400), personName: z.string().min(2), brandName: z.string().optional(), consentDocument: z.string().min(5), consentGivenAt: z.string() }), run: (s, i) => withAdmin(async (tx) => { const [t] = await tx`insert into testimonials (quote, person_name, brand_name, consent_document, consent_given_at) values (${i.quote}, ${i.personName}, ${i.brandName ?? null}, ${i.consentDocument}, ${i.consentGivenAt}) returning id`; await audit(tx, s, 'testimonial.create', { type: 'testimonial', id: t!.id as string }, { after: i }); }) }),
  'testimonial.revoke': a({ perm: 'growth.manage', schema: z.object({ id: uuid }), run: (s, i) => withAdmin(async (tx) => { await tx`update testimonials set revoked_at = now() where id = ${i.id}`; await audit(tx, s, 'testimonial.revoke', { type: 'testimonial', id: i.id }); }) }),

  /* ── Email ── */
  'email.unsuppress': a({ perm: 'email.manage', schema: z.object({ email: z.string().email(), reason }), run: (s, i) => withAdmin(async (tx) => { await tx`delete from email_suppressions where email = ${i.email.toLowerCase()}`; await audit(tx, s, 'email.unsuppress', { type: 'email', id: i.email }, { reason: i.reason }); }) }),
  'email.test': a({ perm: 'email.read', schema: z.object({ template: z.enum(['magic_link', 'receipt', 'asset_ready', 'weekly_brief', 'cancellation_confirmed']) }), run: async (s, i) => { const samples = { magic_link: { url: `${env().APP_URL}/auth/magic/test`, purpose: 'login' as const }, receipt: { productName: 'Dew Serum', amount: '$19.00', description: 'One 15-second ad', url: env().APP_URL }, asset_ready: { productName: 'Dew Serum', url: env().APP_URL, catalogueNo: '014' }, weekly_brief: { workspaceName: 'Sample Brand', week: 'Week 39', recommendations: [{ hypothesis: 'Texture close-ups beat talking heads for serums', slot: 'EXPLOIT' }], url: env().APP_URL }, cancellation_confirmed: { planName: 'Growth', endsOn: 'October 23', exportUrl: env().APP_URL } }; await sendEmail(i.template, s.email, samples[i.template] as never, { idempotencyKey: `test:${i.template}:${newId()}` }); return { message: `Sent to ${s.email}` }; } }),

  /* ── Flags, settings, banner ── */
  'flag.set': a({
    perm: 'flags.manage',
    schema: z.object({ key: z.string(), enabled: z.boolean(), rules: z.record(z.string(), z.unknown()).optional(), reason }),
    run: async (s, i) => {
      if (i.key.startsWith('kill.')) {
        assertStaff(s, 'killswitch');
        assertFreshReauth(s);
      } else assertStaff(s, 'flags.manage');
      return withAdmin(async (tx) => {
        const [b] = await tx`select enabled, rules from feature_flags where key = ${i.key}`;
        if (!b) throw new DomainError('NOT_FOUND', 'Unknown flag');
        await tx`update feature_flags set enabled = ${i.enabled}, rules = ${tx.json((i.rules ?? b.rules) as never)}, updated_at = now() where key = ${i.key}`;
        await audit(tx, s, 'flag.set', { type: 'flag', id: i.key }, { reason: i.reason, before: b, after: { enabled: i.enabled, rules: i.rules } });
      });
    },
  }),
  'flag.create': a({ perm: 'flags.manage', schema: z.object({ key: z.string().regex(/^[a-z0-9_.]{3,60}$/), description: z.string().min(5), owner: z.string().min(2), kind: z.enum(['boolean', 'percentage', 'workspace_allowlist', 'plan']), expiresAt: z.string().optional() }), run: (s, i) => withAdmin(async (tx) => { await tx`insert into feature_flags (key, description, owner, kind, expires_at) values (${i.key}, ${i.description}, ${i.owner}, ${i.kind}, ${i.expiresAt ?? null})`; await audit(tx, s, 'flag.create', { type: 'flag', id: i.key }, { after: i }); }) }),
  'setting.set': a({
    perm: 'flags.manage',
    schema: z.object({ key: z.string().regex(/^[a-z0-9_.]{3,60}$/, 'Keys look like area.name'), value: z.unknown(), reason }),
    run: (s, i) =>
      withAdmin(async (tx) => {
        if (i.value === undefined) throw new DomainError('INVALID', 'A value is required.');
        const known = SETTING_DEFAULTS[i.key as SettingKey];
        // Wired settings must keep their shape, or the app silently falls back to the code default.
        if (known !== undefined && typeof i.value !== typeof known) throw new DomainError('INVALID', `${i.key} must be a ${typeof known}.`);
        const [b] = await tx`select value from platform_settings where key = ${i.key}`;
        await tx`insert into platform_settings (key, value, updated_by) values (${i.key}, ${tx.json(i.value as never)}, ${s.staffId}) on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`;
        await audit(tx, s, 'setting.set', { type: 'setting', id: i.key }, { reason: i.reason, before: b?.value ?? null, after: i.value });
        clearSettingsCache(i.key);
        return { message: 'Saved. Other processes pick it up within 30 seconds.' };
      }),
  }),
  'banner.set': a({ perm: 'system.banner', schema: z.object({ text: z.string().max(200).default(''), tone: z.enum(['info', 'warn', 'risk']).default('warn') }), run: (s, i) => withAdmin(async (tx) => { await tx`insert into platform_settings (key, value, updated_by) values ('status.banner', ${tx.json(i.text ? { text: i.text, tone: i.tone, at: new Date().toISOString() } : null)}, ${s.staffId}) on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`; await audit(tx, s, 'banner.set', { type: 'setting', id: 'status.banner' }, { after: i }); }) }),
  'ops.restore_drill': a({ perm: 'system.read', schema: z.object({ result: z.enum(['passed', 'failed']), notes: z.string().max(500).optional() }), run: (s, i) => withAdmin(async (tx) => { await tx`insert into platform_settings (key, value, updated_by) values ('ops.restore_drill', ${tx.json({ at: new Date().toISOString(), result: i.result, notes: i.notes ?? null, by: s.email })}, ${s.staffId}) on conflict (key) do update set value = excluded.value, updated_at = now()`; await audit(tx, s, 'ops.restore_drill', { type: 'setting', id: 'ops.restore_drill' }, { after: i }); }) }),

  /* ── Privacy ── */
  'privacy.create': a({ perm: 'privacy.manage', schema: z.object({ kind: z.enum(DataRequestKind), requesterEmail: z.string().email(), workspaceId: uuid.optional(), notes: z.string().max(1000).optional() }), run: (s, i) => withAdmin(async (tx) => { const [r] = await tx`insert into data_requests (kind, requester_email, workspace_id, notes, due_at) values (${i.kind}, ${i.requesterEmail}, ${i.workspaceId ?? null}, ${i.notes ?? null}, now() + interval '45 days') returning id`; await audit(tx, s, 'privacy.create', { type: 'data_request', id: r!.id as string }, { workspaceId: i.workspaceId ?? null }); }) }),
  'privacy.update': a({ perm: 'privacy.manage', schema: z.object({ id: uuid, status: z.enum(['in_progress', 'completed', 'rejected']), notes: z.string().max(1000).optional() }), run: (s, i) => withAdmin(async (tx) => { await tx`update data_requests set status = ${i.status}, notes = coalesce(${i.notes ?? null}, notes), completed_at = case when ${i.status} in ('completed','rejected') then now() end where id = ${i.id}`; await audit(tx, s, 'privacy.update', { type: 'data_request', id: i.id }, { after: i }); }) }),
  'privacy.erase_reviews': a({
    perm: 'privacy.manage',
    reauth: true,
    schema: z.object({ workspaceId: uuid, phrase: z.string().min(4).max(200), reason }),
    run: (s, i) =>
      withAdmin(async (tx) => {
        await assertBreakGlass(tx, s, i.workspaceId, 'erase a person’s review text', true);
        const del = await tx`delete from customer_signals where workspace_id = ${i.workspaceId} and text ilike ${'%' + i.phrase.replace(/[%_]/g, '') + '%'} returning id`;
        await audit(tx, s, 'privacy.erase_reviews', { type: 'workspace', id: i.workspaceId }, { workspaceId: i.workspaceId, reason: i.reason, after: { deleted: del.length } });
        return { message: `Deleted ${del.length} review snippets. Themes refresh on the next clustering run.` };
      }),
  }),

  /* ── Taxonomy ── */
  'taxonomy.version': a({ perm: 'taxonomy.manage', reauth: true, schema: z.object({ spec: z.record(z.string(), z.unknown()), reason }), run: (s, i) => withAdmin(async (tx) => { const [v] = await tx`select coalesce(max(version), 0) + 1 as v from taxonomy_versions`; await tx`insert into taxonomy_versions (version, spec) values (${v!.v}, ${tx.json({ ...i.spec, changeReason: i.reason, by: s.email } as never)})`; await audit(tx, s, 'taxonomy.version', { type: 'taxonomy', id: String(v!.v) }, { reason: i.reason, after: i.spec }); return { message: `Taxonomy v${v!.v} recorded. Existing genomes keep their version until remapped.` }; }) }),

  /* ── Staff ── */
  // Invite staff: the account starts with no roles; the requested roles go through four-eyes like any role
  // change (plan 05 §0.5, §23), so one SUPER_ADMIN can't mint another privileged account alone.
  'staff.create': a({
    perm: 'staff.manage',
    reauth: true,
    schema: z.object({ email: z.string().email(), name: z.string().min(2), password: z.string().min(14), roles: z.string(), reason }),
    run: async (s, i) => {
      const roles = parseRoles(i.roles);
      if (!roles.length) throw new DomainError('INVALID', `Pick at least one role (${StaffRole.join(', ')}).`);
      const r = await createStaff({ email: i.email, name: i.name, password: i.password, roles: [] });
      await withAdmin((tx) => audit(tx, s, 'staff.create', { type: 'staff', id: r.staffId }, { reason: i.reason, after: { email: i.email, requestedRoles: roles } }));
      const grant = await requestOrExecute(s, 'staff.roles', { staffId: r.staffId, roles }, i.reason);
      const pending = grant.status === 'pending' ? ` Roles (${roles.join(', ')}) are pending approval by another SUPER_ADMIN (approval ${grant.approvalId.slice(0, 8)}).` : '';
      return { status: grant.status, approvalId: grant.status === 'pending' ? grant.approvalId : null, message: `Created without roles.${pending} Give them this authenticator secret once, in person: ${r.totpSecret}` };
    },
  }),
  'staff.roles': a({ perm: 'staff.manage', reauth: true, schema: z.object({ staffId: uuid, roles: z.string(), reason }), run: (s, i) => requestOrExecute(s, 'staff.roles', { staffId: i.staffId, roles: parseRoles(i.roles) }, i.reason) }),
  'staff.deprovision': a({ perm: 'staff.manage', reauth: true, schema: z.object({ staffId: uuid, reason }), run: (s, i) => withAdmin(async (tx) => { if (i.staffId === s.staffId) throw new DomainError('CONFLICT', 'You can’t deprovision yourself.'); await deprovisionStaff(tx, i.staffId); await audit(tx, s, 'staff.deprovision', { type: 'staff', id: i.staffId }, { reason: i.reason }); }) }),
  'staff.confirm_roles': a({ perm: 'staff.manage', schema: z.object({ staffId: uuid }), run: (s, i) => withAdmin(async (tx) => { await tx`update staff_users set roles_confirmed_at = now() where id = ${i.staffId}`; await audit(tx, s, 'staff.confirm_roles', { type: 'staff', id: i.staffId }); }) }),
} as const;

export type ActionName = keyof typeof ACTIONS;
