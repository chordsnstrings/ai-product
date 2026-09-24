import { createHash } from 'node:crypto';
import { z } from 'zod';
import { withAdmin } from '@arkiv/db';
import { assertFreshReauth, deprovisionStaff, inviteStaff, resendStaffInvite, STAFF_INVITE_HOURS, removeStaffPasskey, requestMagicLink, revokeAllSessions, staffNetworkAllowed } from '@arkiv/auth';
import {
  deleteUser,
  actOnBehalf,
  addTenantNote,
  approveClaim,
  assertBreakGlass,
  confirmSkuExclusion,
  escalateBlockedPattern,
  keepClaimRestricted,
  requestClaimEvidence,
  resolveImpliedFlag,
  reviewAsset,
  assertStaff,
  audit,
  blockClaim,
  BREAK_GLASS_REASON_KINDS,
  BREAK_GLASS_REASON_LABEL,
  cancelProjectBeforeDispatch,
  cancelTenantPurge,
  claimMarket,
  classifyClaim,
  clearSettingsCache,
  decideApproval,
  decideFact,
  editScene,
  endBreakGlass,
  emit,
  enqueue,
  staffCtx,
  staffTenantCtx,
  evalDatasetFor,
  jobErrorClass,
  assertCandidatePrompt,
  assertContractTestsPass,
  addGoldenCase,
  retireGoldenCase,
  DATASETS,
  importAdSpend,
  importProviderInvoice,
  parseAdSpendCsv,
  parseProviderInvoiceCsv,
  publishLanding,
  resolveAlert,
  rollbackLanding,
  saveLandingDraft,
  setLandingStatus,
  setOfferExperiment,
  normalizeAllowKey,
  normalizeCidr,
  proposeTaxonomyChange,
  reviewTaxonomyProposal,
  TAXONOMY_FAMILIES,
  parseBannerAudience,
  describeAudience,
  QA_VERDICT_KEY,
  Queues,
  registerExecutor,
  requestOpsCommand,
  requestOrExecute,
  retryProjectProduction,
  retryProduction,
  scheduleTenantPurge,
  SETTING_DEFAULTS,
  setTenantFlags,
  staffApproveShopTransfer,
  setTenantHold,
  requestOwnershipTransfer,
  requestSkuTransfer,
  cancelOwnershipTransfer,
  OWNERSHIP_TRANSFER_HOURS,
  rotateInviteToken,
  startIntervention,
  startBreakGlass,
  suppressRiskFlag,
  validateEligibility,
  validateOfferBonus,
  type Permission,
  type SettingKey,
  RATE_PROVIDERS,
  RATE_UNITS,
  validateRateTable,
  notifyPriceChanges,
  PRICE_NOTICE_DAYS,
  schedulePlanPrice,
} from '@arkiv/core';
import { applySubscriptionCoupon, billingGateway, processStripeEvent, refundPayment, staffChangePlan, submitDisputeEvidence } from '@arkiv/billing';
import { canResendTemplate, isTemplateName, sendEmail, templateSamples, type TemplateName } from '@arkiv/email';
import { COST_LIMITS, DataRequestKind, DomainError, env, LandingPrimaryMetric, newId, PlanCode, RefundReason, StaffRole } from '@arkiv/shared';
import type { StaffUser } from './staff';
import { tenantFilters } from './tenants-query';

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

// Plan 04 §3 price change (four-eyes, FINANCE approves): the version is stored and every live subscriber of the plan
// is sent notice in the same transaction; the worker applies it at each subscriber's first renewal on/after the date.
registerExecutor('plan.price_schedule', async (p, { approver }) =>
  withAdmin(async (tx) => {
    const r = await schedulePlanPrice(tx, approver, { plan: p.plan as PlanCode, priceMicros: Number(p.priceMicros), stripePriceId: (p.stripePriceId as string | null) ?? null, effectiveFrom: new Date(p.effectiveFrom as string), reason: p.reason as string });
    const notices = await notifyPriceChanges(tx);
    return { ...r, notices: notices.length };
  }),
);

// §44 "Model price doubles": a paid production the Cost Governor refused at its class ceiling (rates rose after the
// customer paid, and re-planning within the ceiling wasn't enough) is honoured at a loss up to an approved amount.
registerExecutor('project.ceiling_override', async (p, { approver }) => {
  const ws = p.workspaceId as string;
  const projectId = p.projectId as string;
  await withAdmin(async (tx) => {
    const [pr] = await tx`select state, failure_code, ceiling_override_micros from projects where id = ${projectId} and workspace_id = ${ws} for update`;
    if (!pr) throw new DomainError('NOT_FOUND', 'Project not found');
    if (pr.state !== 'NEEDS_USER_ACTION' || pr.failure_code !== 'gate_blocked') throw new DomainError('CONFLICT', 'This production isn’t waiting on its cost ceiling.');
    await tx`update projects set ceiling_override_micros = ${Number(p.maxMicros)} where id = ${projectId} and workspace_id = ${ws}`;
    await audit(tx, approver, 'project.ceiling_override', { type: 'project', id: projectId }, { workspaceId: ws, reason: p.reason as string, before: { ceiling_override_micros: pr.ceiling_override_micros ?? null }, after: { ceiling_override_micros: Number(p.maxMicros) } });
    // The approved production runs again: it re-reserves through the Cost Governor, now under the override.
    await retryProduction(tx, await staffTenantCtx(tx, approver, ws), projectId);
  });
  return { message: 'Override applied; the production is queued again.' };
});

/** "support, ops" → ['SUPPORT','OPS']; unknown names are rejected rather than silently dropped. */
function parseRoles(raw: string): StaffRole[] {
  const roles = [...new Set(raw.split(',').map((r) => r.trim().toUpperCase()).filter(Boolean))];
  const unknown = roles.filter((r) => !(StaffRole as readonly string[]).includes(r));
  if (unknown.length) throw new DomainError('INVALID', `Unknown role ${unknown.join(', ')}. Roles: ${StaffRole.join(', ')}.`);
  return roles as StaffRole[];
}

/** Every routed call is priced before dispatch (Cost Governor): a candidate model needs a published rate. */
async function assertPublishedRate(task: string, model: string) {
  const [r] = await withAdmin((tx) => tx`select r.provider, exists (select 1 from provider_rate_tables t where t.provider = r.provider and t.model = ${model} and t.status = 'published' and t.effective_from <= now()) as priced
                                         from model_routes r where r.task = ${task}`);
  if (!r) throw new DomainError('NOT_FOUND', 'Unknown route');
  if (!r.priced) throw new DomainError('CONFLICT', `No published rate for ${r.provider as string}/${model}. Publish one first; calls can't be priced without it.`);
}

async function ownerEmails(workspaceId: string) {
  return withAdmin((tx) => tx`select u.email from memberships m join users u on u.id = m.user_id where m.workspace_id = ${workspaceId} and m.role in ('OWNER','ADMIN')`).then((r) => r.map((x) => x.email as string));
}

async function sendUserLoginLink(s: StaffUser, userId: string, why: string, verification: boolean) {
  const [u] = await withAdmin((tx) => tx`select email, email_verified_at, locked_at, deleted_at from users where id = ${userId}`);
  if (!u || u.deleted_at) throw new DomainError('NOT_FOUND', 'User not found');
  if (u.locked_at) throw new DomainError('CONFLICT', 'This account is locked. Unlock it first.');
  if (verification && u.email_verified_at) throw new DomainError('CONFLICT', 'This address is already verified. Send a sign-in link instead.');
  await requestMagicLink({ email: u.email as string, purpose: 'login' });
  await withAdmin((tx) => audit(tx, s, verification ? 'user.resend_verification' : 'user.send_login_link', { type: 'user', id: userId }, { reason: why }));
  return { message: verification ? 'Verification link sent; opening it confirms the address.' : 'Sign-in link sent to the user’s inbox (valid 15 minutes).' };
}

/** The invite email: a single-use link to the console's invite page (never stored in the email log). */
async function sendStaffInvite(s: StaffUser, email: string, name: string, token: string, inviteId: string) {
  await sendEmail('staff_invite', email, { name, inviterName: s.name, url: `${env().ADMIN_URL}/invite/${token}`, expiresIn: `${STAFF_INVITE_HOURS} hours` }, { idempotencyKey: `staff-invite:${inviteId}` });
}

/** An open data request of the given kinds, with the workspace it concerns (plan 05 §21 per-request tools). */
async function openDataRequest(tx: Parameters<Parameters<typeof withAdmin>[0]>[0], id: string, kinds: DataRequestKind[], workspaceId?: string) {
  const [r] = await tx`select kind, status, workspace_id from data_requests where id = ${id} for update`;
  if (!r) throw new DomainError('NOT_FOUND', 'Request not found');
  if (!['open', 'in_progress'].includes(r.status as string)) throw new DomainError('CONFLICT', 'This request is already closed.');
  if (!kinds.includes(r.kind as DataRequestKind)) throw new DomainError('CONFLICT', `This tool answers ${kinds.join(' / ')} requests, not ${r.kind as string}.`);
  if (!r.workspace_id) throw new DomainError('INVALID', 'Set the workspace on the request first.');
  if (workspaceId && r.workspace_id !== workspaceId) throw new DomainError('INVALID', 'That request is about a different workspace.');
  return { kind: r.kind as DataRequestKind, workspaceId: r.workspace_id as string };
}
async function noteDataRequest(tx: Parameters<Parameters<typeof withAdmin>[0]>[0], id: string, note: string) {
  await tx`update data_requests set status = 'in_progress', notes = concat_ws(' · ', notes, ${note}::text) where id = ${id}`;
}

/** Customer-app link inside the workspace (plan 02 M11): email buttons land on the page they name. */
export const appUrl = (slug: string, path: string) => `${env().APP_URL}/w/${slug}${path}`;
async function workspaceSlug(workspaceId: string) {
  const [w] = await withAdmin((tx) => tx`select slug from workspaces where id = ${workspaceId}`);
  if (!w) throw new DomainError('NOT_FOUND', 'Workspace not found');
  return w.slug as string;
}

/** Force the challenge and/or tighten rate limits for a normalised abuse key, until a time (plan 05 §15). */
async function setAbuseOverride(s: StaffUser, rawKey: string, set: { forceChallenge?: boolean; rateLimitFactor?: number }, days: number, why: string) {
  const key = normalizeAllowKey(rawKey);
  return withAdmin(async (tx) => {
    const [b] = await tx`select force_challenge, rate_limit_factor, until, reason from abuse_overrides where key = ${key} for update`;
    const [r] = await tx`insert into abuse_overrides (key, force_challenge, rate_limit_factor, reason, until, created_by)
                         values (${key}, ${set.forceChallenge ?? false}, ${set.rateLimitFactor ?? null}, ${why}, now() + make_interval(days => ${days}), ${s.staffId})
                         on conflict (key) do update set
                           force_challenge = abuse_overrides.force_challenge or excluded.force_challenge,
                           rate_limit_factor = coalesce(least(abuse_overrides.rate_limit_factor, excluded.rate_limit_factor), abuse_overrides.rate_limit_factor, excluded.rate_limit_factor),
                           reason = excluded.reason, until = greatest(abuse_overrides.until, excluded.until), created_by = excluded.created_by, updated_at = now()
                         returning force_challenge, rate_limit_factor, until`;
    await audit(tx, s, set.forceChallenge ? 'abuse.challenge' : 'abuse.tighten', { type: 'key', id: key }, { reason: why, before: b ?? null, after: r ?? null });
    return { message: `${key}: ${r!.force_challenge ? 'challenge forced' : 'no forced challenge'}${r!.rate_limit_factor != null ? `, limits at ${Math.round(Number(r!.rate_limit_factor) * 100)}%` : ''} until ${new Date(r!.until as string).toISOString().slice(0, 10)}.` };
  });
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
    schema: z.object({ workspaceId: uuid, reasonKind: z.enum(BREAK_GLASS_REASON_KINDS), reason: z.string().min(8), ticket: z.string().max(40).optional(), write: z.boolean().optional(), writeReason: z.string().optional() }),
    run: async (s, i) => {
      if (i.write) assertFreshReauth(s);
      const r = await startBreakGlass(s, i.workspaceId, i);
      const url = appUrl(await workspaceSlug(i.workspaceId), '/settings/access-log');
      for (const to of await ownerEmails(i.workspaceId)) {
        await sendEmail('staff_break_glass', to, { staffName: s.name, reason: `${BREAK_GLASS_REASON_LABEL[i.reasonKind]}${i.ticket ? ` #${i.ticket}` : ''}: ${i.reason}`, when: new Date().toUTCString(), url }, { idempotencyKey: `bg:${r.id}:${to}`, workspaceId: i.workspaceId }).catch(() => {});
      }
      return { ...r, message: `Access until ${new Date(r.expiresAt).toISOString().slice(11, 16)} UTC; the customer can see this in their access log.` };
    },
  }),
  'tenant.breakglass_end': a({ perm: 'breakglass.read', schema: z.object({ workspaceId: uuid }), run: (s, i) => endBreakGlass(s, i.workspaceId) }),
  /* Act on behalf (break-glass write, §0.3): each write runs the customer's own domain function with
     actor=staff:<id>, on_behalf_of=workspace:<id>, after a content.write audit row. */
  'tenant.fact_decide': a({
    perm: 'breakglass.write',
    reauth: true,
    schema: z.object({ workspaceId: uuid, skuId: uuid, key: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/, 'Fact keys look like size_ml'), value: z.string().trim().min(1).max(500), reason }),
    run: (s, i) =>
      withAdmin(async (tx) => {
        const ctx = await actOnBehalf(tx, s, i.workspaceId, `correct product fact ${i.key} on SKU ${i.skuId}`);
        const [sku] = await tx`select 1 from skus where id = ${i.skuId} and workspace_id = ${i.workspaceId}`;
        if (!sku) throw new DomainError('NOT_FOUND', 'SKU not found in this workspace');
        const before = await tx`select value_text, value_number, source_type, state from product_facts where workspace_id = ${i.workspaceId} and sku_id = ${i.skuId} and normalized_key = ${i.key} and status <> 'SUPERSEDED'`;
        const factId = await decideFact(tx, ctx, i.skuId, i.key, { text: i.value });
        await audit(tx, s, 'tenant.fact_decide', { type: 'sku', id: i.skuId }, { workspaceId: i.workspaceId, reason: i.reason, before: { [i.key]: before }, after: { [i.key]: i.value, factId } });
        return { message: `Saved on the customer’s behalf; the change shows as Arkiv support in their history.` };
      }),
  }),
  'tenant.scene_edit': a({
    perm: 'breakglass.write',
    reauth: true,
    schema: z.object({ workspaceId: uuid, sceneId: uuid, spokenLine: z.string().max(300).optional(), overlayText: z.string().max(120).optional(), reason }),
    run: (s, i) =>
      withAdmin(async (tx) => {
        const ctx = await actOnBehalf(tx, s, i.workspaceId, `edit storyboard scene ${i.sceneId}`);
        const [before] = await tx`select spoken_line, overlay_text from scenes where id = ${i.sceneId} and workspace_id = ${i.workspaceId}`;
        if (!before) throw new DomainError('NOT_FOUND', 'Scene not found in this workspace');
        await editScene(tx, ctx, i.sceneId, { spokenLine: i.spokenLine, overlayText: i.overlayText }); // reads and writes by the verified scene id
        await audit(tx, s, 'tenant.scene_edit', { type: 'scene', id: i.sceneId }, { workspaceId: i.workspaceId, reason: i.reason, before, after: { spoken_line: i.spokenLine ?? before.spoken_line, overlay_text: i.overlayText ?? before.overlay_text } });
        return { message: 'Scene updated on the customer’s behalf (claims-checked like their own edits).' };
      }),
  }),
  /* §2.3 "Transfer SKU to workspace": with the owner's written consent, one job copies the SKU's product truth
     and assets into the target workspace with new ids (break-glass write on the source, audited on both sides). */
  'tenant.sku_transfer': a({
    perm: 'breakglass.write',
    reauth: true,
    schema: z.object({ workspaceId: uuid, skuId: uuid, toWorkspaceId: uuid, consentRef: z.string().trim().min(4, 'Reference the owner’s written consent (ticket or email)').max(200), reason }),
    run: async (s, i) => {
      const r = await requestSkuTransfer(s, { fromWorkspaceId: i.workspaceId, skuId: i.skuId, toWorkspaceId: i.toWorkspaceId, consentRef: i.consentRef, reason: i.reason });
      return { transferId: r.transferId, message: 'Transfer queued. The SKU, its facts, claims, evidence, fingerprint and files are copied with new ids; the original is archived.' };
    },
  }),
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
        await enqueue(tx, i.workspaceId, Queues.exportWorkspace, { requestedBy: { kind: 'staff', id: s.staffId }, requestedAt: new Date().toISOString() }, { singletonKey: `export:${i.workspaceId}` });
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
  /* §2.2 Members: 🔐 transfer ownership "with written reason + customer email confirmation". Staff file the
     request; the current owner confirms from the emailed link (signed in), and only then do the roles change. */
  'tenant.transfer_owner': a({
    perm: 'tenant.state',
    reauth: true,
    schema: z.object({ workspaceId: uuid, userId: uuid, reason }),
    run: async (s, i) => {
      const r = await requestOwnershipTransfer(s, i.workspaceId, i.userId, i.reason);
      const url = `${env().APP_URL}/ownership/${r.token}`;
      const newOwner = r.newOwner.name ? `${r.newOwner.name} (${r.newOwner.email})` : r.newOwner.email;
      let sent = 0;
      for (const to of r.notify) {
        const res = await sendEmail('ownership_transfer_confirm', to, { workspaceName: r.workspaceName, newOwner, reason: i.reason, url, expiresIn: `${OWNERSHIP_TRANSFER_HOURS} hours` }, { idempotencyKey: `owner-transfer:${r.transferId}:${to}`, workspaceId: i.workspaceId }).catch(() => null);
        if (res && res.status !== 'suppressed') sent++;
      }
      if (!sent) throw new DomainError('UNAVAILABLE', 'The confirmation email could not be sent to any owner. The request stays pending; withdraw it or try again.');
      return { transferId: r.transferId, message: `Confirmation emailed to ${sent} owner${sent === 1 ? '' : 's'}. Nothing changes until an owner confirms (link valid ${OWNERSHIP_TRANSFER_HOURS} hours).` };
    },
  }),
  'tenant.transfer_owner_cancel': a({ perm: 'tenant.state', schema: z.object({ workspaceId: uuid, transferId: uuid, reason }), run: (s, i) => cancelOwnershipTransfer(s, i.workspaceId, i.transferId, i.reason).then(() => ({ message: 'Request withdrawn; the emailed link no longer works.' })) }),
  /* §2.2 Members: resend a pending invite with a fresh link (the previous link stops working). */
  'tenant.invite_resend': a({
    perm: 'tenant.flags',
    schema: z.object({ workspaceId: uuid, inviteId: uuid }),
    run: async (s, i) => {
      const r = await withAdmin(async (tx) => {
        const inv = await rotateInviteToken(tx, i.workspaceId, i.inviteId);
        await audit(tx, s, 'tenant.invite_resend', { type: 'invite', id: i.inviteId }, { workspaceId: i.workspaceId, after: { role: inv.role, expires: '7 days' } });
        return inv;
      });
      const res = await sendEmail('invite', r.email, { url: `${env().APP_URL}/invite/${r.token}`, workspaceName: r.workspaceName, inviterName: r.inviterName, role: r.role }, { idempotencyKey: `invite:${i.inviteId}:${createHash('sha256').update(r.token).digest('hex').slice(0, 16)}`, workspaceId: i.workspaceId });
      return { message: res.status === 'suppressed' ? 'New link issued, but the address is suppressed (bounce/complaint); unsuppress it first.' : 'Invite resent with a new link; it expires in 7 days.' };
    },
  }),
  'tenant.invite_revoke': a({ perm: 'tenant.flags', schema: z.object({ workspaceId: uuid, inviteId: uuid }), run: (s, i) => withAdmin(async (tx) => { const [b] = await tx`select email, role, expires_at, revoked_at, accepted_at from invites where id = ${i.inviteId} and workspace_id = ${i.workspaceId} for update`; if (!b) throw new DomainError('NOT_FOUND', 'Invite not found'); await tx`update invites set revoked_at = now() where id = ${i.inviteId} and workspace_id = ${i.workspaceId}`; await audit(tx, s, 'tenant.invite_revoke', { type: 'invite', id: i.inviteId }, { workspaceId: i.workspaceId, before: { revoked_at: b.revoked_at, accepted_at: b.accepted_at }, after: { revoked_at: 'now' } }); }) }),
  'tenant.integration_sync': a({ perm: 'integrations.manage', schema: z.object({ workspaceId: uuid, integrationId: uuid }), run: (s, i) => withAdmin(async (tx) => { await enqueue(tx, i.workspaceId, Queues.syncIntegration, { integrationId: i.integrationId, full: true }, { singletonKey: `sync:${i.integrationId}` }); await audit(tx, s, 'integration.resync', { type: 'integration', id: i.integrationId }, { workspaceId: i.workspaceId }); }) }),
  // §2.2 Integrations: pause/resume sync, or mark a connection degraded (the customer sees it needs attention and
  // freshness reflects it, like a connector-detected degradation).
  'tenant.integration_status': a({
    perm: 'integrations.manage',
    schema: z.object({ workspaceId: uuid, integrationId: uuid, status: z.enum(['active', 'paused', 'degraded']), reason }),
    run: (s, i) =>
      withAdmin(async (tx) => {
        const [b] = await tx`select status, provider from integrations where id = ${i.integrationId} and workspace_id = ${i.workspaceId} for update`;
        if (!b) throw new DomainError('NOT_FOUND', 'Integration not found');
        if (b.status === 'disconnected' || b.status === 'revoked') throw new DomainError('CONFLICT', `This connection is ${b.status as string}; only the customer can reconnect it.`);
        if (b.status === i.status) return { message: `Already ${i.status}.` };
        await tx`update integrations set status = ${i.status} where id = ${i.integrationId} and workspace_id = ${i.workspaceId}`;
        if (i.status === 'degraded') {
          const ctx = staffCtx(s, i.workspaceId);
          await emit(tx, ctx, 'INTEGRATION_DEGRADED', { type: 'integration', id: i.integrationId }, { kind: 'staff', reason: i.reason });
          await emit(tx, ctx, 'DATA_FRESHNESS_CHANGED', { type: 'integration', id: i.integrationId }, { status: 'degraded' });
        }
        await audit(tx, s, 'integration.status', { type: 'integration', id: i.integrationId }, { workspaceId: i.workspaceId, reason: i.reason, before: { status: b.status }, after: { status: i.status } });
        return { message: `${b.provider as string} connection ${i.status === 'degraded' ? 'marked degraded' : i.status === 'paused' ? 'paused' : 'resumed'}.` };
      }),
  }),
  /* §2.2 Risk / §17: start the flag's intervention playbook (email + in-app notice; never a discount). */
  'intervention.start': a({
    perm: 'tenant.flags',
    schema: z.object({ workspaceId: uuid, flagId: uuid, email: z.boolean().optional(), notice: z.boolean().optional(), note: z.string().max(500).optional() }),
    run: (s, i) => startIntervention(s, i.workspaceId, i.flagId, { email: i.email, notice: i.notice, note: i.note ?? null }),
  }),
  'tenant.risk_suppress': a({
    perm: 'tenant.flags',
    schema: z.object({ workspaceId: uuid, flagId: uuid, reason, days: z.number().int().min(1).max(180).default(30) }),
    run: async (s, i) => {
      const r = await suppressRiskFlag(s, i.workspaceId, i.flagId, i.reason, i.days);
      return { message: `Suppressed until ${new Date(r.suppressedUntil).toDateString()}.` };
    },
  }),
  /* Tenant list (§2.1): saved views per staff member; bulk tag, audited per workspace. */
  'view.save': a({
    perm: 'tenant.read',
    schema: z.object({ module: z.literal('tenants'), name: z.string().trim().min(1).max(60), query: z.record(z.string(), z.string().max(200)) }),
    run: (s, i) =>
      withAdmin(async (tx) => {
        const query = tenantFilters(i.query);
        const [v] = await tx`insert into staff_saved_views (staff_id, module, name, query) values (${s.staffId}, ${i.module}, ${i.name}, ${tx.json(query)})
                             on conflict (staff_id, module, name) do update set query = excluded.query returning id`;
        return { id: v!.id, message: `Saved “${i.name}”.` };
      }),
  }),
  'view.delete': a({ perm: 'tenant.read', schema: z.object({ id: uuid }), run: (s, i) => withAdmin(async (tx) => { const del = await tx`delete from staff_saved_views where id = ${i.id} and staff_id = ${s.staffId} returning id`; if (!del.length) throw new DomainError('NOT_FOUND', 'Saved view not found'); }) }),
  'tenant.bulk_tag': a({
    perm: 'tenant.flags',
    schema: z.object({ workspaceIds: z.array(uuid).min(1).max(200), tag: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/, 'Tags are lowercase letters, digits, - and _'), mode: z.enum(['add', 'remove']).default('add') }),
    run: (s, i) =>
      withAdmin(async (tx) => {
        const rows = await tx`select id, tags from workspaces where id in ${tx([...new Set(i.workspaceIds)])} for update`;
        let changed = 0;
        for (const w of rows) {
          const before = (w.tags as string[]) ?? [];
          const after = i.mode === 'add' ? [...new Set([...before, i.tag])] : before.filter((t) => t !== i.tag);
          if (after.length === before.length && after.every((t, n) => t === before[n])) continue;
          await tx`update workspaces set tags = ${after} where id = ${w.id}`;
          await audit(tx, s, 'tenant.bulk_tag', { type: 'workspace', id: w.id as string }, { workspaceId: w.id as string, before: { tags: before }, after: { tags: after } });
          changed++;
        }
        return { message: `${i.mode === 'add' ? 'Tagged' : 'Untagged'} ${changed} of ${rows.length} tenant${rows.length === 1 ? '' : 's'} “${i.tag}”.` };
      }),
  }),
  /* Experiments & jobs tab (§2.2): retry a failed production within entitlement; cancel before dispatch. */
  'tenant.project_retry': a({ perm: 'jobs.manage', schema: z.object({ workspaceId: uuid, projectId: uuid, reason }), run: (s, i) => retryProjectProduction(s, i.workspaceId, i.projectId, i.reason) }),
  'tenant.project_cancel': a({ perm: 'jobs.manage', schema: z.object({ workspaceId: uuid, projectId: uuid, reason }), run: (s, i) => cancelProjectBeforeDispatch(s, i.workspaceId, i.projectId, i.reason) }),

  /* ── Users ── */
  'user.lock': a({ perm: 'users.lock', reauth: true, schema: z.object({ userId: uuid, reason }), run: (s, i) => withAdmin(async (tx) => { const [b] = await tx`select locked_at, locked_reason from users where id = ${i.userId} for update`; if (!b) throw new DomainError('NOT_FOUND', 'User not found'); await tx`update users set locked_at = now(), locked_reason = ${i.reason} where id = ${i.userId}`; const ended = await tx`update sessions set revoked_at = now() where user_id = ${i.userId} and revoked_at is null returning id`; await audit(tx, s, 'user.lock', { type: 'user', id: i.userId }, { reason: i.reason, before: b, after: { locked: true, sessionsRevoked: ended.length } }); }) }),
  'user.unlock': a({ perm: 'users.lock', reauth: true, schema: z.object({ userId: uuid, reason }), run: (s, i) => withAdmin(async (tx) => { const [b] = await tx`select locked_at, locked_reason from users where id = ${i.userId} for update`; if (!b) throw new DomainError('NOT_FOUND', 'User not found'); await tx`update users set locked_at = null, locked_reason = null where id = ${i.userId}`; await audit(tx, s, 'user.unlock', { type: 'user', id: i.userId }, { reason: i.reason, before: b, after: { locked_at: null, locked_reason: null } }); }) }),
  /* §3 Users "resend verification, trigger password reset email": sign-in is passwordless, so both send the user a
     fresh single-use sign-in link (opening it verifies the address). Staff never see or set a credential; the link
     goes only to the user's own inbox, under the normal per-address rate limit. */
  'user.resend_verification': a({ perm: 'users.read', schema: z.object({ userId: uuid, reason }), run: (s, i) => sendUserLoginLink(s, i.userId, i.reason, true) }),
  'user.send_login_link': a({ perm: 'users.read', schema: z.object({ userId: uuid, reason }), run: (s, i) => sendUserLoginLink(s, i.userId, i.reason, false) }),
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
        // Minted when the refund form renders: a double submit or retried request reuses it and replays.
        requestId: uuid.optional(),
        reason,
      })
      .refine((x) => !!x.purchaseId !== !!x.invoiceEventId, 'Choose exactly one payment to refund'),
    // The nonce keys the Stripe refund and its mirror row, so a replay (retried click, re-run approval) never refunds twice.
    run: (s, i) => requestOrExecute(s, 'billing.refund', { workspaceId: i.workspaceId, purchaseId: i.purchaseId ?? null, invoiceEventId: i.invoiceEventId ?? null, amountMicros: Math.round(i.amount * 1e6), reasonCode: i.reasonCode, customerNote: i.customerNote ?? null, nonce: i.requestId ?? newId() }, i.reason),
  }),
  /* §2.2 Billing "apply coupon": FINANCE applies a Stripe coupon to the tenant's subscription (a deliberate,
     reasoned discount — retention playbooks never discount). */
  'billing.apply_coupon': a({
    perm: 'billing.manage',
    schema: z.object({ workspaceId: uuid, coupon: z.string().trim().regex(/^[A-Za-z0-9_-]{2,64}$/, 'Coupon ids are letters, digits, - and _'), reason }),
    run: (s, i) =>
      withAdmin(async (tx) => {
        const ctx = await staffTenantCtx(tx, s, i.workspaceId);
        const r = await applySubscriptionCoupon(tx, ctx, i.coupon);
        await audit(tx, s, 'billing.apply_coupon', { type: 'subscription', id: r.subscriptionId }, { workspaceId: i.workspaceId, reason: i.reason, before: { coupon: r.previous }, after: { coupon: i.coupon } });
        return { message: `Coupon ${i.coupon} applied in Stripe; it shows on the next invoice.` };
      }),
  }),
  /* §2.2 Billing "change plan (customer consent recorded)": the customer asked support to change plan; the consent
     record names where they agreed, and the usual upgrade-now / downgrade-at-renewal rules apply. */
  'billing.change_plan': a({
    perm: 'billing.manage',
    reauth: true,
    schema: z.object({ workspaceId: uuid, plan: z.enum(['LAUNCH', 'GROWTH', 'SCALE']), consentRef: z.string().trim().min(4, 'Where did the customer agree? (ticket or email reference)').max(200), reason }),
    run: (s, i) =>
      withAdmin(async (tx) => {
        const ctx = await staffTenantCtx(tx, s, i.workspaceId);
        const r = await staffChangePlan(tx, ctx, i.plan, { reference: i.consentRef, staffId: s.staffId });
        await audit(tx, s, 'billing.change_plan', { type: 'workspace', id: i.workspaceId }, { workspaceId: i.workspaceId, reason: i.reason, after: { plan: i.plan, effective: r.effective, consentRecordId: r.consentRecordId, consentRef: i.consentRef } });
        return { message: r.effective === 'now' ? `Upgraded to ${i.plan.toLowerCase()} now (prorated${r.extraTests ? `, +${r.extraTests} tests this period` : ''}).` : r.effective === 'period_end' ? `Moves to ${i.plan.toLowerCase()} at the end of the current period.` : 'No change.' };
      }),
  }),
  'billing.stripe_assign': a({ perm: 'billing.unmatched', reauth: true, schema: z.object({ eventId: z.string(), workspaceId: uuid, reason }), run: (s, i) => requestOrExecute(s, 'stripe.assign', { eventId: i.eventId, workspaceId: i.workspaceId }, i.reason) }),
  'billing.stripe_ignore': a({ perm: 'billing.unmatched', schema: z.object({ eventId: z.string(), reason }), run: (s, i) => withAdmin(async (tx) => { const [b] = await tx`update stripe_events set status = 'ignored', error = ${i.reason}, processed_at = now() where id = ${i.eventId} and status = 'unmatched' returning id`; if (!b) throw new DomainError('CONFLICT', 'Event is not unmatched'); await audit(tx, s, 'stripe.ignored', { type: 'stripe_event', id: i.eventId }, { reason: i.reason, before: { status: 'unmatched' }, after: { status: 'ignored' } }); }) }),
  /* §7 Disputes: the auto-assembled evidence pack (delivery, exports, consent + IP, receipts) is submitted via Stripe. */
  'billing.dispute_submit': a({
    perm: 'billing.manage',
    reauth: true,
    schema: z.object({ workspaceId: uuid, disputeId: z.string().regex(/^(dp|du)_[A-Za-z0-9_]+$/, 'Dispute ids start with dp_'), note: z.string().max(2000).optional(), reason }),
    run: (s, i) =>
      withAdmin(async (tx) => {
        const r = await submitDisputeEvidence(tx, i.workspaceId, i.disputeId, s.staffId, i.note ?? null);
        await audit(tx, s, 'billing.dispute_submit', { type: 'stripe_dispute', id: i.disputeId }, { workspaceId: i.workspaceId, reason: i.reason, after: { fields: Object.keys(r.evidence), exports: r.pack.exports.length, deliveries: r.pack.deliveries.length } });
        return { message: 'Evidence submitted to Stripe; the dispute is under review.' };
      }),
  }),
  /* §7 Nightly Stripe reconciliation: run it now, or resolve an exception with a reason. */
  'billing.recon_run': a({ perm: 'billing.unmatched', schema: z.object({ reason: z.string().default('manual reconciliation run') }), run: (s, i) => requestOpsCommand(s, 'stripe.reconcile', {}, i.reason).then(() => ({ message: 'Reconciliation queued; results appear here in a minute.' })) }),
  'billing.recon_resolve': a({
    perm: 'billing.unmatched',
    schema: z.object({ id: uuid, reason }),
    run: (s, i) =>
      withAdmin(async (tx) => {
        const [b] = await tx`update stripe_recon_exceptions set resolved_at = now(), resolved_by = ${s.staffId}, resolution = ${i.reason} where id = ${i.id} and resolved_at is null returning kind, stripe_id, workspace_id`;
        if (!b) throw new DomainError('CONFLICT', 'Already resolved.');
        await audit(tx, s, 'billing.recon_resolve', { type: 'stripe_recon_exception', id: i.id }, { workspaceId: (b.workspace_id as string) ?? null, reason: i.reason, before: { kind: b.kind, stripeId: b.stripe_id, open: true }, after: { open: false } });
      }),
  }),
  'billing.portal': a({ perm: 'billing.read', schema: z.object({ workspaceId: uuid }), run: async (s, i) => { const [c] = await withAdmin((tx) => tx`select customer_id from stripe_customers where workspace_id = ${i.workspaceId}`); if (!c) throw new DomainError('NOT_FOUND', 'No Stripe customer'); await withAdmin((tx) => audit(tx, s, 'billing.open_stripe', { type: 'workspace', id: i.workspaceId }, { workspaceId: i.workspaceId })); return { url: billingGateway().live ? `https://dashboard.stripe.com/customers/${c.customer_id}` : `${env().ADMIN_URL}/billing?customer=${c.customer_id}` }; } }),

  /* ── Rates ── */
  'rates.propose': a({
    perm: 'rates.propose',
    schema: z.object({
      provider: z.enum(RATE_PROVIDERS),
      model: z.string().trim().min(2).max(80),
      unit: z.enum(RATE_UNITS),
      rates: z.record(z.string(), z.number()),
      sourceUrl: z.string().url().optional(),
      notes: z.string().max(500).optional(),
      // When the new price takes effect (plan 05 §9 "effective at a time"); publishing earlier keeps today's rate until then.
      effectiveFrom: z.string().datetime({ offset: true }).optional(),
    }),
    run: (s, i) =>
      withAdmin(async (tx) => {
        // The keys and units the Cost Governor reads, in micros (priceLine): a draft it can't price is refused here.
        const rates = validateRateTable(i);
        const [v] = await tx`select coalesce(max(version), 0) + 1 as v from provider_rate_tables where provider = ${i.provider} and model = ${i.model}`;
        const effective = i.effectiveFrom ? new Date(i.effectiveFrom) : new Date();
        const [r] = await tx`insert into provider_rate_tables (provider, model, version, unit, rates, effective_from, source_url, notes, status, created_by)
                             values (${i.provider}, ${i.model}, ${v!.v}, ${i.unit}, ${tx.json(rates)}, ${effective}, ${i.sourceUrl ?? null}, ${i.notes ?? null}, 'draft', ${s.staffId}) returning id`;
        await audit(tx, s, 'rates.proposed', { type: 'rate_table', id: r!.id as string }, { after: i });
        return { id: r!.id, message: `Draft v${v!.v} created (effective ${effective.toUTCString()}). Publishing needs a second approver.` };
      }),
  }),
  'rates.publish': a({ perm: 'rates.propose', reauth: true, schema: z.object({ rateTableId: uuid, reason }), run: (s, i) => requestOrExecute(s, 'rates.publish', { rateTableId: i.rateTableId }, i.reason) }),
  // §47 reporting currency: a new version of a currency's FX rate (USD per unit). Observations ingested from then on
  // convert with it; stored rows keep the rate they were converted with.
  'fx.set': a({
    perm: 'rates.propose',
    schema: z.object({ currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/), usdPerUnit: z.coerce.number().positive().max(100_000), source: z.string().trim().min(2).max(200), reason }),
    run: (s, i) =>
      withAdmin(async (tx) => {
        const [prev] = await tx`select usd_per_unit, version from fx_rates where currency = ${i.currency} order by version desc limit 1`;
        const version = Number(prev?.version ?? 0) + 1;
        const [r] = await tx`insert into fx_rates (currency, usd_per_unit, version, source, created_by) values (${i.currency}, ${i.usdPerUnit}, ${version}, ${i.source}, ${s.staffId}) returning id`;
        await audit(tx, s, 'fx.set', { type: 'fx_rate', id: r!.id as string }, { reason: i.reason, before: prev ? { usdPerUnit: Number(prev.usd_per_unit), version: prev.version } : null, after: { currency: i.currency, usdPerUnit: i.usdPerUnit, version } });
        return { message: `${i.currency} v${version}: 1 ${i.currency} = ${i.usdPerUnit} USD from today.` };
      }),
  }),

  /* ── Plan prices (plan 04 §3) ── */
  'plan.price_schedule': a({
    perm: 'billing.manage',
    reauth: true,
    schema: z.object({
      plan: z.enum(PlanCode),
      price: z.coerce.number().positive().max(10_000),
      stripePriceId: z.string().trim().regex(/^price_[A-Za-z0-9]+$/, 'Stripe price ids look like price_1Nx…').optional().or(z.literal('')),
      effectiveOn: z.string().date('Use a date like 2026-11-01'),
      reason,
    }),
    run: async (s, i) => {
      const effectiveFrom = new Date(`${i.effectiveOn}T00:00:00Z`);
      if (effectiveFrom.getTime() < Date.now() + PRICE_NOTICE_DAYS * 86400_000) throw new DomainError('INVALID', `Choose a date at least ${PRICE_NOTICE_DAYS} days from today, so every subscriber gets notice first.`);
      if (billingGateway().live && !i.stripePriceId) throw new DomainError('INVALID', 'Create the new price in Stripe first and paste its price id.');
      const r = await requestOrExecute(s, 'plan.price_schedule', { plan: i.plan, priceMicros: Math.round(i.price * 1_000_000), stripePriceId: i.stripePriceId || null, effectiveFrom: effectiveFrom.toISOString() }, i.reason);
      return { ...r, message: r.status === 'pending' ? 'Price change requested; it is scheduled (and subscribers are notified) once FINANCE approves.' : 'Price change scheduled; subscribers are notified.' };
    },
  }),

  /* ── Providers & routes ── */
  // Opening a circuit may carry staff's estimate of when it closes: customers whose ads are queued behind it see
  // it as the ETA (plan 03 P9 "plus an ETA if known"). Closing clears it.
  'route.circuit': a({
    perm: 'providers.circuit',
    schema: z.object({ task: z.string(), open: z.boolean(), reopenMinutes: z.coerce.number().int().min(1).max(7 * 24 * 60).optional(), reason }),
    run: (s, i) =>
      withAdmin(async (tx) => {
        const [b] = await tx`select circuit_open, circuit_until, circuit_auto, circuit_reason from model_routes where task = ${i.task}`;
        if (!b) throw new DomainError('NOT_FOUND', 'Unknown route');
        // A circuit staff open (or touch) is theirs: the breaker sweep no longer closes it on its own. Re-opening an
        // open circuit only updates its ETA; the error window restarts at every open/close.
        const [a0] = await tx`update model_routes set circuit_open = ${i.open}, circuit_auto = false,
                                circuit_reason = ${i.open ? i.reason : null},
                                circuit_changed_at = case when circuit_open is distinct from ${i.open} then now() else circuit_changed_at end,
                                circuit_until = ${i.open && i.reopenMinutes ? tx`now() + make_interval(mins => ${i.reopenMinutes})` : i.open ? tx`circuit_until` : null},
                                updated_at = now() where task = ${i.task} returning circuit_open, circuit_until, circuit_auto, circuit_reason`;
        await audit(tx, s, i.open ? 'route.circuit_open' : 'route.circuit_close', { type: 'route', id: i.task }, { reason: i.reason, before: b, after: a0 });
      }),
  }),
  /* §10 Provider registry: status, region, concurrency limit, per-request timeout and retry policy (the Model
     Gateway reads them on every call). Secret values are never shown or set here. */
  'provider.update': a({
    perm: 'providers.manage',
    reauth: true,
    schema: z.object({
      name: z.string().min(2).max(40),
      status: z.enum(['active', 'degraded', 'disabled']),
      region: z.string().trim().max(40).optional(),
      concurrencyLimit: z.number().int().min(1).max(500),
      timeoutMs: z.number().int().min(1000).max(3_600_000),
      retryAttempts: z.number().int().min(1).max(10),
      retryBackoffMs: z.number().int().min(0).max(60_000),
      notes: z.string().max(500).optional(),
      reason,
    }),
    run: (s, i) =>
      withAdmin(async (tx) => {
        const [b] = await tx`select status, region, concurrency_limit, timeout_ms, retry_attempts, retry_backoff_ms, notes from providers where name = ${i.name} for update`;
        if (!b) throw new DomainError('NOT_FOUND', 'Unknown provider');
        await tx`update providers set status = ${i.status}, region = ${i.region || null}, concurrency_limit = ${i.concurrencyLimit}, timeout_ms = ${i.timeoutMs},
                   retry_attempts = ${i.retryAttempts}, retry_backoff_ms = ${i.retryBackoffMs}, notes = coalesce(${i.notes ?? null}, notes), updated_by = ${s.staffId}, updated_at = now()
                 where name = ${i.name}`;
        await audit(tx, s, 'provider.update', { type: 'provider', id: i.name }, { reason: i.reason, before: b, after: { status: i.status, region: i.region ?? null, concurrency_limit: i.concurrencyLimit, timeout_ms: i.timeoutMs, retry_attempts: i.retryAttempts, retry_backoff_ms: i.retryBackoffMs } });
        return { message: i.status === 'disabled' ? `${i.name} disabled: calls are refused (approved fallbacks take over).` : `${i.name} updated; new calls use these settings.` };
      }),
  }),
  'route.update': a({
    perm: 'routes.manage',
    reauth: true,
    schema: z.object({ task: z.string(), rolloutPct: z.coerce.number().int().min(0).max(100), model: z.string().optional(), promptVersion: z.string().optional(), reason }),
    run: async (s, i) => {
      const [cur] = await withAdmin((tx) => tx`select * from model_routes where task = ${i.task}`);
      if (!cur) throw new DomainError('NOT_FOUND', 'Unknown route');
      if (i.rolloutPct === 0) {
        // Ending a canary is a rollback: never gated.
        return withAdmin(async (tx) => {
          await tx`update model_routes set canary = null, updated_at = now() where task = ${i.task}`;
          await audit(tx, s, 'route.canary_cleared', { type: 'route', id: i.task }, { reason: i.reason, before: { canary: cur.canary } });
          return { message: 'Canary ended; all traffic on the stable route.' };
        });
      }
      // Plan 05 §10: a passing golden-set eval for exactly this template × model within 7 days.
      const model = i.model || (cur.model as string);
      const promptVersion = i.promptVersion || (cur.prompt_version as string);
      // Git is the source of prompts (plan 05 §11): only a registered version of the route's template can go live.
      assertCandidatePrompt(cur.prompt_version as string, promptVersion);
      const dataset = evalDatasetFor(i.task);
      if (!dataset) throw new DomainError('CONFLICT', `No golden dataset covers ${i.task} yet. Add one (plan 05 §11) before changing this route.`);
      const [ev] = await withAdmin((tx) => tx`select id from eval_runs where task = ${i.task} and model = ${model} and prompt_version = ${promptVersion} and dataset = ${dataset}
                                                 and status = 'passed' and created_at > now() - interval '7 days' limit 1`);
      if (!ev) throw new DomainError('CONFLICT', `Run a passing ${dataset} eval for ${i.task} · ${model} · ${promptVersion} (within 7 days) before changing this route.`);
      // Every routed call is priced before dispatch (Cost Governor), so the candidate model needs a published rate.
      const [rate] = await withAdmin((tx) => tx`select 1 from provider_rate_tables where provider = ${cur.provider as string} and model = ${model} and status = 'published' and effective_from <= now() limit 1`);
      if (!rate) throw new DomainError('CONFLICT', `No published rate for ${cur.provider as string}/${model}. Publish one first; calls can't be priced without it.`);
      if (i.rolloutPct >= 100) return requestOrExecute(s, 'route.promote', { task: i.task, rolloutPct: i.rolloutPct, model, promptVersion }, i.reason);
      return withAdmin(async (tx) => {
        const prev = cur.canary as { model?: string; promptVersion?: string; startedAt?: string } | null;
        // Moving the same candidate from 5% to 25% keeps its comparison window; a new candidate starts afresh.
        const sameCandidate = prev && prev.model === model && prev.promptVersion === promptVersion;
        const canary = { model, promptVersion, pct: i.rolloutPct, startedAt: sameCandidate && prev.startedAt ? prev.startedAt : new Date().toISOString(), evalRunId: ev.id };
        await tx`update model_routes set canary = ${tx.json(canary)}, updated_at = now() where task = ${i.task}`;
        await audit(tx, s, 'route.canary', { type: 'route', id: i.task }, { reason: i.reason, before: cur, after: canary });
        return { message: `Canary at ${i.rolloutPct}%. It rolls back automatically if QA first-pass or claim-block rates regress.` };
      });
    },
  }),
  // §48 "pin where possible": the exact provider version a route sends (empty clears the pin). Pinning to what is
  // live freezes behaviour, so it needs no eval; any change of model still goes through route.update.
  'route.pin': a({
    perm: 'routes.manage',
    reauth: true,
    schema: z.object({ task: z.string(), version: z.string().trim().max(120).optional(), reason }),
    run: (s, i) =>
      withAdmin(async (tx) => {
        const [b] = await tx`select pinned_model_version from model_routes where task = ${i.task}`;
        if (!b) throw new DomainError('NOT_FOUND', 'Unknown route');
        const version = i.version || null;
        await tx`update model_routes set pinned_model_version = ${version}, updated_at = now() where task = ${i.task}`;
        await audit(tx, s, 'route.pin', { type: 'route', id: i.task }, { reason: i.reason, before: b, after: { pinned_model_version: version } });
        return { message: version ? `Pinned ${i.task} to ${version}.` : `Unpinned ${i.task}.` };
      }),
  }),
  // §44 / plan 05 §10: the route the gateway fails over to when this one's circuit is open or its provider is down.
  // Only a route of the same kind, priced on a published rate, that doesn't fall back to this one.
  'route.fallback': a({
    perm: 'routes.manage',
    reauth: true,
    schema: z.object({ task: z.string(), fallbackTask: z.string().optional(), reason }),
    run: (s, i) =>
      withAdmin(async (tx) => {
        const [cur] = await tx`select fallback_task from model_routes where task = ${i.task}`;
        if (!cur) throw new DomainError('NOT_FOUND', 'Unknown route');
        const fb = i.fallbackTask || null;
        if (fb) {
          const [f] = await tx`select task, provider, model, fallback_task from model_routes where task = ${fb}`;
          if (!f) throw new DomainError('NOT_FOUND', 'Unknown fallback route');
          if (fb === i.task) throw new DomainError('INVALID', 'A route can’t be its own fallback.');
          if (fb.split('.')[0] !== i.task.split('.')[0]) throw new DomainError('INVALID', `${fb} does a different kind of work than ${i.task}.`);
          if (f.fallback_task === i.task) throw new DomainError('INVALID', `${fb} already falls back to ${i.task}.`);
          const [rate] = await tx`select 1 from provider_rate_tables where provider = ${f.provider as string} and model = ${f.model as string} and status = 'published' and effective_from <= now() limit 1`;
          if (!rate) throw new DomainError('CONFLICT', `No published rate for ${f.provider as string}/${f.model as string}; calls on it can’t be priced.`);
        }
        await tx`update model_routes set fallback_task = ${fb}, updated_at = now() where task = ${i.task}`;
        await audit(tx, s, 'route.fallback', { type: 'route', id: i.task }, { reason: i.reason, before: cur, after: { fallback_task: fb } });
        return { message: fb ? `${i.task} now fails over to ${fb}.` : `${i.task} queues on outage (no fallback).` };
      }),
  }),
  // A dataset alone runs the rules baseline; with a task, the run is recorded for that template × model and is
  // what route.update requires before a change (plan 05 §10–11).
  'eval.run': a({
    perm: 'evals.run',
    schema: z.object({ dataset: z.string().optional(), task: z.string().optional(), model: z.string().optional(), promptVersion: z.string().optional(), reason: z.string().default('manual eval run') }),
    run: async (s, i) => {
      let task: string;
      let model: string;
      let promptVersion: string;
      let dataset: string;
      // A model dataset picked on its own runs on its route's live template × model.
      const routeTask = i.task || (i.dataset ? DATASETS[i.dataset]?.task : undefined);
      if (routeTask) {
        const [route] = await withAdmin((tx) => tx`select model, prompt_version from model_routes where task = ${routeTask}`);
        if (!route) throw new DomainError('NOT_FOUND', 'Unknown route');
        const ds = evalDatasetFor(routeTask);
        if (!ds) throw new DomainError('CONFLICT', `No golden dataset covers ${routeTask} yet.`);
        if (i.dataset && i.dataset !== ds) throw new DomainError('INVALID', `${routeTask} is gated by the ${ds} dataset.`);
        [task, model, promptVersion, dataset] = [routeTask, i.model || (route.model as string), i.promptVersion || (route.prompt_version as string), ds];
        assertCandidatePrompt(route.prompt_version as string, promptVersion);
        // Model runs are priced before dispatch like any call: the candidate needs a published rate.
        if (DATASETS[ds]?.kind === 'model') await assertPublishedRate(routeTask, model);
      } else {
        if (!i.dataset || !DATASETS[i.dataset]) throw new DomainError('INVALID', 'Unknown dataset');
        [task, model, promptVersion, dataset] = [i.dataset, 'deterministic', 'rules', i.dataset];
      }
      const [r] = await withAdmin((tx) => tx`insert into eval_runs (task, prompt_version, model, dataset, status, created_by) values (${task}, ${promptVersion}, ${model}, ${dataset}, 'queued', ${s.staffId}) returning id`);
      await requestOpsCommand(s, 'eval.run', { dataset, evalRunId: r!.id, task, model, promptVersion }, i.reason);
      return { message: `Eval queued for ${task} · ${model} · ${promptVersion}; results appear in a few seconds.` };
    },
  }),

  /* Golden datasets (plan 05 §11): a synthetic reproduction, or — under break-glass, with the tenant's explicit
     consent — a case from a production failure (QA disagreement, claims decision). */
  'golden.add': a({
    perm: 'golden.add',
    schema: z.object({
      dataset: z.string(),
      input: z.string().trim().min(1).max(4000),
      expected: z.string().trim().min(1).max(60),
      note: z.string().max(500).optional(),
      source: z.enum(['synthetic', 'production']),
      workspaceId: uuid.optional(),
      consentRef: z.string().max(200).optional(),
      projectId: uuid.optional(),
      claimId: uuid.optional(),
    }),
    run: (s, i) =>
      withAdmin(async (tx) => {
        const origin = { ...(i.projectId ? { projectId: i.projectId } : {}), ...(i.claimId ? { claimId: i.claimId } : {}) };
        const id = await addGoldenCase(tx, s, { ...i, origin });
        return { id, message: `Added to ${i.dataset}. The next eval of that dataset includes it.` };
      }),
  }),
  'golden.retire': a({ perm: 'golden.add', schema: z.object({ id: uuid, reason }), run: (s, i) => withAdmin((tx) => retireGoldenCase(tx, s, i.id, i.reason)) }),

  /* ── Jobs ── */
  // SUPPORT may retry no-spend queues only; requestOpsCommand enforces the queue check.
  // A spending queue's retry needs the fresh estimate the operator saw (confirmEstimateMicros), or, when the job never
  // reached an authorization, an explicit confirmSpend; requestOpsCommand re-prices at current rates and checks.
  'job.retry': a({
    perm: 'jobs.retry_nospend',
    schema: z.object({ queue: z.string(), jobId: z.string(), workspaceId: uuid.optional(), confirmEstimateMicros: z.coerce.number().int().min(0).optional(), confirmSpend: z.boolean().optional(), reason }),
    run: (s, i) => requestOpsCommand(s, 'job.retry', i, i.reason).then(() => ({ message: 'Retry queued' })),
  }),
  // §12 "bulk retry by error class": the failed jobs of one no-spend queue whose error has this class.
  'job.bulk_retry': a({
    perm: 'jobs.manage',
    reauth: true,
    schema: z.object({ queue: z.string(), errorClass: z.string().min(1).max(120), reason }),
    run: async (s, i) => {
      const failed = await withAdmin((tx) =>
        tx.savepoint((sp) => sp`select id, output from pgboss.job where name = ${i.queue} and state = 'failed' order by completed_on desc limit 1000`).catch(() => {
          throw new DomainError('UNAVAILABLE', 'Queue tables aren’t visible yet — the worker grants read access when it starts.');
        }),
      );
      const jobIds = failed.filter((j) => jobErrorClass(j.output) === i.errorClass).map((j) => j.id as string).slice(0, 500);
      if (!jobIds.length) throw new DomainError('NOT_FOUND', 'No failed jobs of that class on this queue.');
      await requestOpsCommand(s, 'job.bulk_retry', { queue: i.queue, errorClass: i.errorClass, jobIds }, i.reason);
      return { message: `Retry of ${jobIds.length} job${jobIds.length === 1 ? '' : 's'} queued (held workspaces are skipped).` };
    },
  }),
  // §44: request the ceiling override for a paid production stopped at its class ceiling (FINANCE approves).
  'project.ceiling_override': a({
    perm: 'jobs.manage',
    reauth: true,
    schema: z.object({ workspaceId: uuid, projectId: uuid, maxUsd: z.coerce.number().positive().max((COST_LIMITS.CREATIVE_TEST_CEILING / 1_000_000) * 3), reason }),
    run: async (s, i) => {
      const maxMicros = Math.round(i.maxUsd * 1_000_000);
      if (maxMicros <= COST_LIMITS.CREATIVE_TEST_CEILING) throw new DomainError('INVALID', `An override is above the standard ceiling (${(COST_LIMITS.CREATIVE_TEST_CEILING / 1_000_000).toFixed(2)} USD).`);
      const [pr] = await withAdmin((tx) => tx`select state, failure_code from projects where id = ${i.projectId} and workspace_id = ${i.workspaceId}`);
      if (!pr || pr.state !== 'NEEDS_USER_ACTION' || pr.failure_code !== 'gate_blocked') throw new DomainError('CONFLICT', 'This production isn’t waiting on its cost ceiling.');
      const r = await requestOrExecute(s, 'project.ceiling_override', { workspaceId: i.workspaceId, projectId: i.projectId, maxMicros }, i.reason);
      return { ...r, message: r.status === 'pending' ? 'Override requested; production retries once FINANCE approves.' : 'Override applied; production retries.' };
    },
  }),
  'job.cancel': a({ perm: 'jobs.manage', schema: z.object({ queue: z.string(), jobId: z.string(), workspaceId: uuid.optional(), reason }), run: (s, i) => requestOpsCommand(s, 'job.cancel', i, i.reason).then(() => ({ message: 'Cancel queued' })) }),
  'dlq.requeue': a({ perm: 'jobs.manage', reauth: true, schema: z.object({ queue: z.string(), limit: z.number().int().min(1).max(1000).default(100), reason }), run: (s, i) => requestOpsCommand(s, 'dlq.requeue', { queue: i.queue, limit: i.limit }, i.reason).then(() => ({ message: 'Redrive queued' })) }),

  /* §16 platform app status (Meta app review, TikTok app, Shopify listing): recorded by staff, shown on the page. */
  'integration.app_status': a({
    perm: 'integrations.manage',
    schema: z.object({ provider: z.enum(['meta', 'tiktok', 'shopify']), status: z.enum(['unknown', 'in_review', 'approved', 'live', 'rejected', 'suspended', 'action_required']), note: z.string().max(300).optional() }),
    run: (s, i) =>
      withAdmin(async (tx) => {
        const [b] = await tx`select value from platform_settings where key = 'integrations.app_status' for update`;
        const before = ((b?.value as Record<string, unknown> | null) ?? {}) as Record<string, unknown>;
        const after = { ...before, [i.provider]: { status: i.status, note: i.note ?? null, updatedAt: new Date().toISOString(), by: s.email } };
        await tx`insert into platform_settings (key, value, updated_by) values ('integrations.app_status', ${tx.json(after as never)}, ${s.staffId})
                 on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`;
        await audit(tx, s, 'integration.app_status', { type: 'setting', id: 'integrations.app_status' }, { before: before[i.provider] ?? null, after: after[i.provider] });
      }),
  }),
  /* Plan 02 §3 layer 8: a store transfer the current owner hasn't answered in 14 days, with the requester's Shopify OAuth as proof. */
  'integration.shop_transfer_approve': a({
    perm: 'integrations.manage',
    reauth: true,
    schema: z.object({ requestId: uuid, reason }),
    run: (s, i) =>
      withAdmin(async (tx) => {
        const r = await staffApproveShopTransfer(tx, s, i.requestId, i.reason);
        await audit(tx, s, 'integration.shop_transfer_approve', { type: 'shop_transfer', id: i.requestId }, { workspaceId: r.fromWorkspaceId, reason: i.reason, before: { status: 'pending', workspaceId: r.fromWorkspaceId }, after: { status: 'approved', shop: r.shop, toWorkspaceId: r.toWorkspaceId } });
        return { message: `${r.shop} released. The requesting workspace can connect it now.` };
      }),
  }),
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
    schema: z.object({
      workspaceId: uuid,
      claimId: uuid,
      decision: z.enum(['approve', 'block', 'unblock', 'keep_restricted', 'request_evidence', 'approve_without_evidence']),
      wording: z.string().max(200).optional(),
      qualifier: z.string().max(200).optional(),
      platforms: z.string().default('TIKTOK,META'),
      markets: z.string().optional(),
      /** Comma-separated claim_evidence ids the approval rests on (default: every qualifying file). */
      evidenceIds: z.string().optional(),
      reason,
    }),
    run: async (s, i) => {
      if (i.decision === 'unblock') return requestOrExecute(s, 'claim.unblock', { workspaceId: i.workspaceId, claimId: i.claimId }, i.reason);
      if (i.decision === 'keep_restricted' || i.decision === 'request_evidence') {
        // §14: the claim stays restricted either way; "request more evidence" emails the brand what we need.
        const r = await withAdmin((tx) => (i.decision === 'keep_restricted' ? keepClaimRestricted : requestClaimEvidence)(tx, s, i.workspaceId, i.claimId, i.reason));
        const url = appUrl(await workspaceSlug(i.workspaceId), `/products/${r.skuId}/claims`);
        for (const to of await ownerEmails(i.workspaceId)) {
          if (i.decision === 'request_evidence') await sendEmail('claim_evidence_request', to, { claim: r.claim, productName: r.productName, note: i.reason, url }, { idempotencyKey: `claimev:${i.claimId}:${newId()}:${to}`, workspaceId: i.workspaceId }).catch(() => {});
          else await sendEmail('claim_review_result', to, { claim: r.claim, outcome: `Kept restricted: ${i.reason}`, url }, { idempotencyKey: `claimrev:${i.claimId}:keep:${to}`, workspaceId: i.workspaceId }).catch(() => {});
        }
        return { message: i.decision === 'request_evidence' ? 'Evidence requested; the brand has been emailed. The claim stays restricted meanwhile.' : 'Kept restricted; the brand sees the reason in its Claims Vault.' };
      }
      const evidenceIds = (i.evidenceIds ?? '').split(',').map((x) => x.trim()).filter(Boolean);
      if (evidenceIds.some((x) => !uuid.safeParse(x).success)) throw new DomainError('INVALID', 'Evidence ids must be UUIDs.');
      // A high-risk claim approved without qualifying evidence needs a second compliance reviewer (§43, four-eyes).
      if (i.decision === 'approve_without_evidence')
        return requestOrExecute(s, 'claim.approve_override', { workspaceId: i.workspaceId, claimId: i.claimId, wording: i.wording ?? null, qualifier: i.qualifier ?? null, platforms: i.platforms, markets: i.markets ?? null }, i.reason);
      return withAdmin(async (tx) => {
        const [owned] = await tx`select 1 from claims where id = ${i.claimId} and workspace_id = ${i.workspaceId}`;
        if (!owned) throw new DomainError('NOT_FOUND', 'Claim not found');
        const ctx = { workspaceId: i.workspaceId, workspaceState: 'ACTIVE_PAID' as const, role: 'OWNER' as const, actor: { kind: 'staff' as const, id: s.staffId }, requestId: newId() };
        if (i.decision === 'block') await blockClaim(tx, ctx, i.claimId, i.reason);
        else {
          // Market defaults to the brand's (Brand Brain), never silently to US (§43); platforms are normalised by approveClaim.
          const [cl] = await tx`select sku_id from claims where id = ${i.claimId} and workspace_id = ${i.workspaceId}`;
          if (!cl) throw new DomainError('NOT_FOUND', 'Claim not found');
          const markets = i.markets?.trim() ? i.markets.split(',').map((m) => m.trim()).filter(Boolean) : [await claimMarket(tx, cl.sku_id as string)];
          await approveClaim(tx, ctx, i.claimId, { markets, platforms: i.platforms.split(',').map((p) => p.trim()).filter(Boolean), qualifier: i.qualifier ?? null, wording: i.wording, evidenceIds: evidenceIds.length ? evidenceIds : null });
        }
        await audit(tx, s, `claim.${i.decision}`, { type: 'claim', id: i.claimId }, { workspaceId: i.workspaceId, reason: i.reason, after: { wording: i.wording, qualifier: i.qualifier, evidenceIds } });
        const [c] = await tx`select c.preferred_wording, c.sku_id, w.slug from claims c join workspaces w on w.id = c.workspace_id where c.id = ${i.claimId} and c.workspace_id = ${i.workspaceId}`;
        // "Open Claims Vault" lands on this SKU's claims page.
        const url = c ? appUrl(c.slug as string, `/products/${c.sku_id as string}/claims`) : `${env().APP_URL}/app`;
        for (const to of await ownerEmails(i.workspaceId)) await sendEmail('claim_review_result', to, { claim: c?.preferred_wording as string, outcome: i.decision === 'block' ? `Blocked: ${i.reason}` : 'Approved for use', url }, { idempotencyKey: `claimrev:${i.claimId}:${i.decision}:${to}`, workspaceId: i.workspaceId }).catch(() => {});
      });
    },
  }),
  /* §14 queues: implied-claim flags, repeated blocked claims, drug/OTC hits, before/after and minors media. */
  'implied_flag.resolve': a({
    perm: 'claims.review',
    schema: z.object({ workspaceId: uuid, projectId: uuid, verdict: z.enum(['confirmed', 'dismissed']), reason }),
    run: (s, i) => withAdmin((tx) => resolveImpliedFlag(tx, s, i.workspaceId, i.projectId, i.verdict, i.reason)).then(() => ({ message: i.verdict === 'confirmed' ? 'Confirmed: follow up with the brand before this ad runs.' : 'Dismissed as a false positive.' })),
  }),
  'blocked_pattern.escalate': a({
    perm: 'claims.review',
    schema: z.object({ workspaceId: uuid, reason }),
    run: async (s, i) => {
      const r = await withAdmin((tx) => escalateBlockedPattern(tx, s, i.workspaceId, i.reason));
      const [w] = await withAdmin((tx) => tx`select name, slug from workspaces where id = ${i.workspaceId}`);
      for (const to of await ownerEmails(i.workspaceId)) {
        await sendEmail('claims_guidance', to, { workspaceName: (w?.name as string) ?? 'your workspace', blocked: r.blocked, examples: r.examples, url: appUrl(w!.slug as string, '/products') }, { idempotencyKey: `claims-guidance:${i.workspaceId}:${new Date().toISOString().slice(0, 10)}:${to}`, workspaceId: i.workspaceId }).catch(() => {});
      }
      return { message: `Escalated; guidance sent to the brand’s owners (${r.blocked} blocked claims in 30 days).` };
    },
  }),
  'sku.confirm_exclusion': a({
    perm: 'claims.review',
    schema: z.object({ workspaceId: uuid, skuId: uuid, reason }),
    run: async (s, i) => {
      const r = await withAdmin((tx) => confirmSkuExclusion(tx, s, i.workspaceId, i.skuId, i.reason));
      const url = appUrl(await workspaceSlug(i.workspaceId), '/products');
      for (const to of await ownerEmails(i.workspaceId)) await sendEmail('sku_out_of_scope', to, { productName: r.productName, reason: r.reason, url }, { idempotencyKey: `out-of-scope:${i.skuId}:${to}`, workspaceId: i.workspaceId }).catch(() => {});
      return { message: 'Exclusion confirmed; the owner was told the product is outside V1 scope.' };
    },
  }),
  'asset.review': a({
    perm: 'claims.review',
    schema: z.object({ workspaceId: uuid, assetId: uuid, verdict: z.enum(['approved', 'rejected']), permissionRef: z.string().trim().max(200).optional(), reason }),
    run: async (s, i) => {
      const r = await withAdmin(async (tx) => {
        // Looking at the media is looking at tenant content: break-glass first (plan 05 §0.3).
        await assertBreakGlass(tx, s, i.workspaceId, `media review ${i.assetId}`);
        return reviewAsset(tx, s, i.workspaceId, i.assetId, i.verdict, i.reason, { permissionRef: i.permissionRef });
      });
      const url = appUrl(await workspaceSlug(i.workspaceId), r.skuId ? `/products/${r.skuId}` : '/products');
      const note = i.verdict === 'approved' ? 'Our team checked it and it can be used in your ads.' : 'Our team checked it: it shows a before/after comparison or a person who may be under 18, which we can’t use in ads. Your other photos are unaffected.';
      for (const to of await ownerEmails(i.workspaceId)) await sendEmail('media_review_result', to, { productName: r.productName, outcome: i.verdict, note, url }, { idempotencyKey: `media-review:${i.assetId}:${to}`, workspaceId: i.workspaceId }).catch(() => {});
      return { message: i.verdict === 'approved' ? 'Approved: the media can be used.' : 'Rejected: it is never used in production.' };
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
        const [b] = await tx`select reason, until from abuse_allowlist where key = ${key}`;
        await tx`insert into abuse_allowlist (key, reason, until, created_by) values (${key}, ${i.reason}, now() + make_interval(days => ${i.days}), ${s.staffId}) on conflict (key) do update set reason = excluded.reason, until = excluded.until, created_by = excluded.created_by`;
        await audit(tx, s, 'abuse.allowlist', { type: 'key', id: key }, { reason: i.reason, before: b ?? null, after: { days: i.days } });
        return { message: `Allowlisted ${key} for ${i.days} days.` };
      }),
  }),
  'abuse.allowlist_remove': a({ perm: 'abuse.manage', schema: z.object({ key: z.string().min(3), reason }), run: (s, i) => withAdmin(async (tx) => { const [b] = await tx`delete from abuse_allowlist where key = ${i.key} returning reason, until, created_by`; await audit(tx, s, 'abuse.allowlist_remove', { type: 'key', id: i.key }, { reason: i.reason, before: b ?? null, after: null }); }) }),
  'rights.create': a({ perm: 'abuse.manage', schema: z.object({ complainant: z.string().min(2), detail: z.string().min(5), workspaceId: uuid.optional(), assetId: uuid.optional() }), run: (s, i) => withAdmin(async (tx) => { const [c] = await tx`insert into rights_cases (complainant, detail, workspace_id, asset_id, created_by) values (${i.complainant}, ${i.detail}, ${i.workspaceId ?? null}, ${i.assetId ?? null}, ${s.staffId}) returning id`; await audit(tx, s, 'rights.create', { type: 'rights_case', id: c!.id as string }, { workspaceId: i.workspaceId ?? null }); }) }),
  'rights.update': a({
    perm: 'abuse.manage',
    schema: z.object({ id: uuid, status: z.enum(['frozen', 'resolved_kept', 'resolved_removed']), resolution: z.string().max(1000).optional() }),
    run: (s, i) =>
      withAdmin(async (tx) => {
        const [b] = await tx`select status, resolution, asset_id, workspace_id from rights_cases where id = ${i.id} for update`;
        if (!b) throw new DomainError('NOT_FOUND', 'Case not found');
        if (String(b.status).startsWith('resolved')) throw new DomainError('CONFLICT', 'This case is already resolved.');
        await tx`update rights_cases set status = ${i.status}, resolution = ${i.resolution ?? null}, resolved_at = case when ${i.status} like 'resolved%' then now() end where id = ${i.id}`;
        // Freezing (or removing) makes the asset unavailable for new production (vision.ts usableAssetIds); a case
        // resolved as kept lifts the freeze. The attested expiry date is left as it was.
        if (b.asset_id && b.workspace_id) {
          if (i.status === 'resolved_kept') await tx`update assets set rights_frozen_at = null where id = ${b.asset_id} and workspace_id = ${b.workspace_id}`;
          else await tx`update assets set rights_frozen_at = coalesce(rights_frozen_at, now()) where id = ${b.asset_id} and workspace_id = ${b.workspace_id}`;
        }
        await audit(tx, s, `rights.${i.status}`, { type: 'rights_case', id: i.id }, { workspaceId: (b.workspace_id as string) ?? null, reason: i.resolution ?? null, before: { status: b.status, resolution: b.resolution }, after: { status: i.status, resolution: i.resolution ?? null } });
      }),
  }),
  /* §15 enforcement: every action is time-boxed and audited; "suspend" is tenant.hold (🔐) from the same page. */
  'abuse.challenge': a({
    perm: 'abuse.manage',
    schema: z.object({ key: z.string().min(3), days: z.number().int().min(1).max(30).default(7), reason }),
    run: (s, i) => setAbuseOverride(s, i.key, { forceChallenge: true }, i.days, i.reason),
  }),
  'abuse.tighten': a({
    perm: 'abuse.manage',
    schema: z.object({ key: z.string().min(3), factor: z.number().min(0.05).max(0.9).default(0.25), days: z.number().int().min(1).max(30).default(7), reason }),
    run: (s, i) => setAbuseOverride(s, i.key, { rateLimitFactor: i.factor }, i.days, i.reason),
  }),
  'abuse.override_remove': a({
    perm: 'abuse.manage',
    schema: z.object({ key: z.string().min(3), reason }),
    run: (s, i) =>
      withAdmin(async (tx) => {
        const [b] = await tx`delete from abuse_overrides where key = ${i.key} returning force_challenge, rate_limit_factor, until, reason`;
        if (!b) throw new DomainError('NOT_FOUND', 'No enforcement on that key');
        await audit(tx, s, 'abuse.override_remove', { type: 'key', id: i.key }, { reason: i.reason, before: b, after: null });
      }),
  }),
  'abuse.block_ip': a({
    perm: 'abuse.manage',
    reauth: true,
    schema: z.object({ cidr: z.string().min(3).max(60), hours: z.number().int().min(1).max(24 * 30).default(24), reason }),
    run: (s, i) =>
      withAdmin(async (tx) => {
        const cidr = normalizeCidr(i.cidr);
        const [b] = await tx`insert into ip_blocks (cidr, reason, until, created_by) values (network(${cidr}::inet), ${i.reason}, now() + make_interval(hours => ${i.hours}), ${s.staffId}) returning id, cidr::text as cidr, until`;
        await audit(tx, s, 'abuse.block_ip', { type: 'ip_block', id: b!.id as string }, { reason: i.reason, after: { cidr: b!.cidr, hours: i.hours } });
        return { message: `Blocked ${b!.cidr as string} until ${new Date(b!.until as string).toISOString().slice(0, 16).replace('T', ' ')} UTC.` };
      }),
  }),
  'abuse.unblock_ip': a({
    perm: 'abuse.manage',
    schema: z.object({ id: uuid, reason }),
    run: (s, i) =>
      withAdmin(async (tx) => {
        const [b] = await tx`update ip_blocks set lifted_at = now(), lifted_by = ${s.staffId} where id = ${i.id} and lifted_at is null returning cidr::text as cidr, until`;
        if (!b) throw new DomainError('NOT_FOUND', 'No active block with that id');
        await audit(tx, s, 'abuse.unblock_ip', { type: 'ip_block', id: i.id }, { reason: i.reason, before: b, after: { lifted: true } });
      }),
  }),

  /* ── Growth: landing pages, offers, testimonials ── */
  /* §5 Landing pages: structured blocks only. Save writes the versioned draft (lint runs); publish re-checks lint,
     example assets and testimonial consent before the draft becomes the live copy; rollback does the same. */
  'lp.save': a({
    perm: 'growth.manage',
    schema: z.object({
      slug: z.string().regex(/^[a-z0-9-]{2,40}$/, 'Slugs are 2–40 lowercase letters, digits and -'),
      archetype: z.string().min(2).max(40),
      content: z.record(z.string(), z.unknown()),
      variants: z.array(z.unknown()).max(5).default([]),
      utmMatch: z.string().max(400).default(''),
      primaryMetric: z.enum(LandingPrimaryMetric).optional(),
      minSample: z.number().int().min(100).max(100_000).optional(),
    }),
    run: (s, i) =>
      withAdmin(async (tx) => {
        const utm = [...new Set(i.utmMatch.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean))];
        const [cur] = await tx`select experiment from landing_pages where slug = ${i.slug}`;
        const base = { primaryMetric: 'upload_start', minSample: 400, ...((cur?.experiment as object) ?? {}) } as { primaryMetric: 'upload_start' | 'taste_cvr'; minSample: number };
        const experiment = i.primaryMetric || i.minSample ? { primaryMetric: i.primaryMetric ?? base.primaryMetric, minSample: i.minSample ?? base.minSample } : undefined;
        const r = await saveLandingDraft(tx, s, { slug: i.slug, archetype: i.archetype, content: i.content, variants: i.variants, utmMatch: utm, experiment });
        return { message: r.created ? 'Draft created. Preview it, then publish.' : `Draft v${r.version} saved. Review the changes and publish when ready.` };
      }),
  }),
  'lp.publish': a({ perm: 'growth.manage', schema: z.object({ slug: z.string() }), run: (s, i) => withAdmin(async (tx) => ({ message: `v${(await publishLanding(tx, s, i.slug)).version} is live.` })) }),
  'lp.status': a({
    perm: 'growth.manage',
    schema: z.object({ slug: z.string(), status: z.enum(['draft', 'live', 'paused']) }),
    // "live" is a publish: it runs the same checks (never a bypass of the lint).
    run: (s, i) => withAdmin(async (tx) => (i.status === 'live' ? { message: `v${(await publishLanding(tx, s, i.slug)).version} is live.` } : (await setLandingStatus(tx, s, i.slug, i.status), { message: i.status === 'paused' ? 'Paused: visitors are redirected to the default page with their UTMs.' : 'Moved back to draft.' }))),
  }),
  'lp.rollback': a({
    perm: 'growth.manage',
    schema: z.object({ slug: z.string(), version: z.number().int() }),
    run: (s, i) => withAdmin(async (tx) => { const r = await rollbackLanding(tx, s, i.slug, i.version); return { message: r.published ? `Rolled back: v${i.version} is live again as v${r.version}.` : `v${i.version} restored as draft v${r.version}.` }; }),
  }),
  /* §8 Provider invoice reconciliation: the monthly invoice CSV, matched to recorded provider cost. */
  'provider_invoice.import': a({
    perm: 'cogs.reconcile',
    schema: z.object({ provider: z.enum(['anthropic', 'byteplus', 'minimax']), csv: z.string().min(10).max(2_000_000), reason: z.string().max(200).optional() }),
    run: async (s, i) => {
      const lines = parseProviderInvoiceCsv(i.csv);
      const batchId = newId();
      return withAdmin(async (tx) => {
        const n = await importProviderInvoice(tx, i.provider, lines, { staffId: s.staffId, batchId });
        const total = lines.reduce((t, l) => t + l.amountMicros, 0);
        const months = [...new Set(lines.map((l) => l.period.slice(0, 7)))].sort();
        await audit(tx, s, 'provider_invoice.import', { type: 'provider_invoice', id: batchId }, { reason: i.reason ?? null, after: { provider: i.provider, lines: lines.length, stored: n, totalMicros: total, months } });
        return { message: `Imported ${n} ${i.provider} line${n === 1 ? '' : 's'} (${months.join(', ')}), $${(total / 1e6).toLocaleString('en-US', { maximumFractionDigits: 2 })} in total.` };
      });
    },
  }),
  /* §1 Pulse: platform alerts raised by sweeps and webhooks are acknowledged with what was done. */
  'alert.resolve': a({ perm: 'alerts.manage', schema: z.object({ id: uuid, reason }), run: (s, i) => withAdmin((tx) => resolveAlert(tx, s, i.id, i.reason)) }),
  /* §4 CAC: ad spend imported as CSV in V1 (date, source, campaign, ad id, spend in USD). */
  'adspend.import': a({
    perm: 'adspend.manage',
    schema: z.object({ csv: z.string().min(10).max(2_000_000), source: z.string().trim().max(40).optional(), reason: z.string().max(200).optional() }),
    run: async (s, i) => {
      const rows = parseAdSpendCsv(i.csv, i.source || null);
      const batchId = newId();
      return withAdmin(async (tx) => {
        const n = await importAdSpend(tx, rows, { staffId: s.staffId, batchId });
        const total = rows.reduce((t, r) => t + r.spendMicros, 0);
        const dates = rows.map((r) => r.date).sort();
        await audit(tx, s, 'adspend.import', { type: 'ad_spend_batch', id: batchId }, { reason: i.reason ?? null, after: { rows: rows.length, stored: n, totalMicros: total, from: dates[0], to: dates.at(-1) } });
        return { message: `Imported ${rows.length} rows (${dates[0]} → ${dates.at(-1)}), $${(total / 1e6).toLocaleString('en-US', { maximumFractionDigits: 2 })} in total.` };
      });
    },
  }),
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
        validateOfferBonus(i.bonus, i.type);
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
  'offer.active': a({
    perm: 'offers.manage',
    schema: z.object({ code: z.string(), active: z.boolean() }),
    run: (s, i) =>
      withAdmin(async (tx) => {
        if (!i.active) {
          const refs = await tx`select code from offer_definitions where reference_code = ${i.code} and active`;
          if (refs.length) throw new DomainError('CONFLICT', `Active offers anchor to this price: ${refs.map((r) => r.code).join(', ')}. Pause them first.`);
        }
        const [b] = await tx`select active, paused_reason, stripe_price_id, stripe_price_archived_at from offer_definitions where code = ${i.code} for update`;
        if (!b) throw new DomainError('NOT_FOUND', 'Offer not found');
        // §6: an offer whose Stripe Price was archived can't be charged; a new version with a live Price replaces it.
        if (i.active && b.stripe_price_archived_at) throw new DomainError('CONFLICT', `Its Stripe Price ${b.stripe_price_id as string} is archived. Restore it in Stripe or create a new version with a live Price.`);
        await tx`update offer_definitions set active = ${i.active}, paused_reason = case when ${i.active} then null else paused_reason end, updated_at = now() where code = ${i.code}`;
        await audit(tx, s, 'offer.active', { type: 'offer', id: i.code }, { before: { active: b.active, pausedReason: b.paused_reason }, after: { active: i.active } });
      }),
  }),
  /* §6 Experiments: variants (price, timer), allocation and guardrails; the guardrail sweep stops a degrading one. */
  'offer.experiment': a({
    perm: 'offers.manage',
    schema: z.object({ code: z.string(), experiment: z.record(z.string(), z.unknown()).nullable(), reason }),
    run: (s, i) =>
      withAdmin(async (tx) => {
        const exp = await setOfferExperiment(tx, s, i.code, i.experiment as never, i.reason);
        return { message: exp ? `Experiment ${exp.key} running on ${i.code} (${exp.variants.map((v) => `${v.key} ${v.weight}`).join(' / ')}).` : 'Experiment stopped; new offers use the base price and window.' };
      }),
  }),
  'testimonial.create': a({ perm: 'growth.manage', schema: z.object({ quote: z.string().min(10).max(400), personName: z.string().min(2), brandName: z.string().optional(), consentDocument: z.string().min(5), consentGivenAt: z.string() }), run: (s, i) => withAdmin(async (tx) => { const [t] = await tx`insert into testimonials (quote, person_name, brand_name, consent_document, consent_given_at) values (${i.quote}, ${i.personName}, ${i.brandName ?? null}, ${i.consentDocument}, ${i.consentGivenAt}) returning id`; await audit(tx, s, 'testimonial.create', { type: 'testimonial', id: t!.id as string }, { after: i }); }) }),
  'testimonial.revoke': a({ perm: 'growth.manage', schema: z.object({ id: uuid }), run: (s, i) => withAdmin(async (tx) => { const [b] = await tx`select revoked_at from testimonials where id = ${i.id} for update`; if (!b) throw new DomainError('NOT_FOUND', 'Testimonial not found'); await tx`update testimonials set revoked_at = now() where id = ${i.id}`; await audit(tx, s, 'testimonial.revoke', { type: 'testimonial', id: i.id }, { before: b, after: { revoked_at: 'now' } }); }) }),

  /* ── Email ── */
  // Pages send an opaque emailKey (sha256 of the address) so masked views never carry the address itself.
  'email.unsuppress': a({
    perm: 'email.manage',
    schema: z.object({ email: z.string().email().optional(), emailKey: z.string().regex(/^[0-9a-f]{64}$/).optional(), reason }).refine((x) => !!x.email !== !!x.emailKey, 'Give the address or its key'),
    run: (s, i) =>
      withAdmin(async (tx) => {
        const [before] = await tx`delete from email_suppressions
                                  where ${i.email ? tx`email = ${i.email.toLowerCase()}` : tx`encode(sha256(convert_to(lower(email::text), 'UTF8')), 'hex') = ${i.emailKey!}`}
                                  returning email, reason, stream, created_at`;
        if (!before) throw new DomainError('NOT_FOUND', 'That address isn’t suppressed.');
        // A deliverable address again: any Owner bounce banner for it is lifted (plan 05 §18).
        await tx`select email_owner_bounce(${before.email as string}, false)`;
        await audit(tx, s, 'email.unsuppress', { type: 'email', id: before.email as string }, { reason: i.reason, before });
      }),
  }),
  /* §2.2 Emails "Resend" (§0.2 SUPPORT "resend emails"): the same template and data to the same address, under a
     new idempotency key minted when the button renders (a double click sends once). Credential links (sign-in,
     invite, download, ownership) are never stored, so those are reissued by their own actions instead. */
  'email.resend': a({
    perm: 'email.manage',
    schema: z.object({ logId: uuid, requestId: uuid, reason }),
    run: async (s, i) => {
      const [row] = await withAdmin((tx) => tx`select id, workspace_id, to_email, template, status, data from email_log where id = ${i.logId}`);
      if (!row) throw new DomainError('NOT_FOUND', 'Email not found');
      if (!canResendTemplate(row.template as string)) throw new DomainError('CONFLICT', 'This email carried a single-use link. Use “Resend invite” or “Send login link” to issue a fresh one.');
      if (!row.data) throw new DomainError('CONFLICT', 'This email was sent before its content was recorded, so it can’t be resent.');
      const res = await sendEmail(row.template as TemplateName, row.to_email as string, row.data as never, { idempotencyKey: `resend:${i.logId}:${i.requestId}`, workspaceId: (row.workspace_id as string) ?? null });
      await withAdmin((tx) => audit(tx, s, 'email.resend', { type: 'email_log', id: i.logId }, { workspaceId: (row.workspace_id as string) ?? null, reason: i.reason, before: { template: row.template, status: row.status }, after: { outcome: res.status } }));
      const said = { sent: 'Resent.', logged: 'Resent (logged; no provider configured here).', duplicate: 'Already resent.', suppressed: 'Not sent: the address is suppressed. Unsuppress it first.', capped: 'Not sent: marketing frequency cap reached for this address.', paused: 'Not sent: marketing email is paused (complaint rate). Resume it on the Email page first.' }[res.status];
      return { status: res.status, message: said };
    },
  }),
  /* §18 preview with sample data and test-send to staff: every template, with its sample data, to the staff member. */
  'email.test': a({
    perm: 'email.read',
    schema: z.object({ template: z.string().refine(isTemplateName, 'Unknown template') }),
    run: async (s, i) => {
      const template = i.template as TemplateName;
      const r = await sendEmail(template, s.email, templateSamples(env().APP_URL)[template] as never, { idempotencyKey: `test:${template}:${newId()}` });
      return { message: r.status === 'sent' || r.status === 'logged' ? `Sent to ${s.email}` : `Not sent (${r.status}) to ${s.email}` };
    },
  }),
  /* §18 complaint-rate guard: marketing sends paused automatically; staff resume once the cause is dealt with. */
  'email.marketing_resume': a({
    perm: 'email.manage',
    schema: z.object({ reason }),
    run: (s, i) =>
      withAdmin(async (tx) => {
        const [b] = await tx`select value from platform_settings where key = 'email.marketing_paused' for update`;
        if (!b || b.value === null) throw new DomainError('CONFLICT', 'Marketing email is not paused.');
        await tx`update platform_settings set value = 'null'::jsonb, updated_by = ${s.staffId}, updated_at = now() where key = 'email.marketing_paused'`;
        await tx`update platform_alerts set resolved_at = now(), resolved_by = ${s.staffId}, resolution = ${i.reason} where kind = 'email.marketing_paused' and resolved_at is null`;
        await audit(tx, s, 'email.marketing_resume', { type: 'setting', id: 'email.marketing_paused' }, { reason: i.reason, before: b.value, after: null });
        return { message: 'Marketing email resumed.' };
      }),
  }),

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
        // An API-version switch needs a passing contract test run on that version first (plan 05 §16, standard §51).
        await assertContractTestsPass(tx, i.key, i.enabled && !b.enabled);
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
  /* §22 status banner: to every tenant, or a subset (plans, workspaces with a connector, listed workspaces). */
  'banner.set': a({
    perm: 'system.banner',
    schema: z.object({
      text: z.string().max(200).default(''),
      tone: z.enum(['info', 'warn', 'risk']).default('warn'),
      audience: z.enum(['all', 'plans', 'integration', 'workspaces']).default('all'),
      plans: z.string().max(200).optional(),
      provider: z.string().max(20).optional(),
      workspaceIds: z.string().max(20_000).optional(),
    }),
    run: (s, i) =>
      withAdmin(async (tx) => {
        const value = i.text ? { text: i.text, tone: i.tone, at: new Date().toISOString(), audience: parseBannerAudience(i) } : null;
        const [b] = await tx`select value from platform_settings where key = 'status.banner'`;
        // Clearing stores JSON null (the column is not null; tx.json(null) would be SQL NULL).
        await tx`insert into platform_settings (key, value, updated_by) values ('status.banner', ${value ? tx.json(value as never) : tx`'null'::jsonb`}, ${s.staffId}) on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`;
        await audit(tx, s, 'banner.set', { type: 'setting', id: 'status.banner' }, { before: b?.value ?? null, after: value });
        return { message: value ? `Published to ${describeAudience(value.audience)}.` : 'Banner cleared.' };
      }),
  }),
  'ops.restore_drill': a({ perm: 'system.read', schema: z.object({ result: z.enum(['passed', 'failed']), notes: z.string().max(500).optional() }), run: (s, i) => withAdmin(async (tx) => { await tx`insert into platform_settings (key, value, updated_by) values ('ops.restore_drill', ${tx.json({ at: new Date().toISOString(), result: i.result, notes: i.notes ?? null, by: s.email })}, ${s.staffId}) on conflict (key) do update set value = excluded.value, updated_at = now()`; await audit(tx, s, 'ops.restore_drill', { type: 'setting', id: 'ops.restore_drill' }, { after: i }); }) }),
  /* §22 backups: the last successful backup as checked by staff (when the DigitalOcean API isn't configured). */
  'ops.backup_check': a({
    perm: 'system.read',
    schema: z.object({ lastBackupAt: z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'Enter the backup time'), result: z.enum(['ok', 'missing', 'failed']), notes: z.string().max(500).optional() }),
    run: (s, i) =>
      withAdmin(async (tx) => {
        if (Date.parse(i.lastBackupAt) > Date.now() + 5 * 60_000) throw new DomainError('INVALID', 'The backup time is in the future.');
        const value = { at: new Date().toISOString(), lastBackupAt: new Date(i.lastBackupAt).toISOString(), result: i.result, notes: i.notes ?? null, by: s.email };
        await tx`insert into platform_settings (key, value, updated_by) values ('ops.backup_check', ${tx.json(value)}, ${s.staffId}) on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`;
        await audit(tx, s, 'ops.backup_check', { type: 'setting', id: 'ops.backup_check' }, { after: value });
      }),
  }),

  /* ── Privacy ── */
  'privacy.create': a({ perm: 'privacy.manage', schema: z.object({ kind: z.enum(DataRequestKind), requesterEmail: z.string().email(), workspaceId: uuid.optional(), notes: z.string().max(1000).optional() }), run: (s, i) => withAdmin(async (tx) => { const [r] = await tx`insert into data_requests (kind, requester_email, workspace_id, notes, due_at) values (${i.kind}, ${i.requesterEmail}, ${i.workspaceId ?? null}, ${i.notes ?? null}, now() + interval '45 days') returning id`; await audit(tx, s, 'privacy.create', { type: 'data_request', id: r!.id as string }, { workspaceId: i.workspaceId ?? null }); }) }),
  // Plan 02 §7 "Delete user" for a delete_user request: the requester's account leaves every workspace and is
  // anonymised; refused (with the workspaces named) while they are the last Owner of a live workspace.
  'privacy.delete_user': a({
    perm: 'privacy.manage',
    reauth: true,
    schema: z.object({ id: uuid, reason }),
    run: async (s, i) => {
      const [r] = await withAdmin((tx) => tx`select kind, status, requester_email from data_requests where id = ${i.id}`);
      if (!r) throw new DomainError('NOT_FOUND', 'Request not found');
      if (r.kind !== 'delete_user' || !['open', 'in_progress'].includes(r.status as string)) throw new DomainError('CONFLICT', 'Only an open account-deletion request can be carried out.');
      const [u] = await withAdmin((tx) => tx`select id from users where email = ${r.requester_email as string} and deleted_at is null`);
      const done = u ? await deleteUser(u.id as string, { by: 'staff' }) : { workspaces: 0 };
      await withAdmin(async (tx) => {
        const note = u ? `Account deleted (${done.workspaces} workspace memberships removed).` : 'No account with this email.';
        await tx`update data_requests set status = 'completed', completed_at = now(), notes = concat_ws(' · ', notes, ${note}::text) where id = ${i.id}`;
        await audit(tx, s, 'privacy.delete_user', { type: 'data_request', id: i.id }, { reason: i.reason, after: { userId: (u?.id as string) ?? null, ...done } });
      });
      return { message: u ? 'Account deleted.' : 'No account with this email — request completed.' };
    },
  }),
  'privacy.update': a({ perm: 'privacy.manage', schema: z.object({ id: uuid, status: z.enum(['in_progress', 'completed', 'rejected']), notes: z.string().max(1000).optional() }), run: (s, i) => withAdmin(async (tx) => { const [b] = await tx`select status, notes, workspace_id from data_requests where id = ${i.id} for update`; if (!b) throw new DomainError('NOT_FOUND', 'Request not found'); await tx`update data_requests set status = ${i.status}, notes = coalesce(${i.notes ?? null}, notes), completed_at = case when ${i.status} in ('completed','rejected') then now() end where id = ${i.id}`; await audit(tx, s, 'privacy.update', { type: 'data_request', id: i.id }, { workspaceId: (b.workspace_id as string) ?? null, before: { status: b.status, notes: b.notes }, after: { status: i.status, notes: i.notes ?? b.notes } }); }) }),
  // Plan 05 §21 tools, run from the request they answer: each one moves the request along and notes what was done.
  'privacy.run_export': a({
    perm: 'privacy.manage',
    reauth: true,
    schema: z.object({ id: uuid, reason: z.string().trim().max(500).optional() }),
    run: (s, i) =>
      withAdmin(async (tx) => {
        const r = await openDataRequest(tx, i.id, ['access', 'export']);
        await enqueue(tx, r.workspaceId, Queues.exportWorkspace, { requestedBy: { kind: 'staff', id: s.staffId }, requestedAt: new Date().toISOString(), dataRequestId: i.id }, { singletonKey: `export:${r.workspaceId}` });
        await noteDataRequest(tx, i.id, `Workspace export queued by ${s.name}; the download link goes to the workspace owners.`);
        await audit(tx, s, 'privacy.run_export', { type: 'data_request', id: i.id }, { workspaceId: r.workspaceId, reason: i.reason ?? null });
        return { message: 'Export queued; the request is now in progress.' };
      }),
  }),
  'privacy.schedule_purge': a({
    perm: 'privacy.manage',
    reauth: true,
    schema: z.object({ id: uuid, reason }),
    run: async (s, i) => {
      const r = await withAdmin((tx) => openDataRequest(tx, i.id, ['delete_workspace']));
      await scheduleTenantPurge(s, r.workspaceId, `data request ${i.id.slice(0, 8)}: ${i.reason}`);
      await withAdmin(async (tx) => {
        await noteDataRequest(tx, i.id, `Purge scheduled by ${s.name}; the purge certificate completes this request.`);
        await audit(tx, s, 'privacy.schedule_purge', { type: 'data_request', id: i.id }, { workspaceId: r.workspaceId, reason: i.reason });
      });
      return { message: 'Purge scheduled (grace period first); the request is now in progress.' };
    },
  }),
  // §21 "find and delete a specific person's review text across a tenant (break-glass + tenant notice)".
  'privacy.erase_reviews': a({
    perm: 'privacy.manage',
    reauth: true,
    schema: z.object({ workspaceId: uuid, phrase: z.string().min(4).max(200), requestId: uuid.optional(), reason }),
    run: async (s, i) => {
      const deleted = await withAdmin(async (tx) => {
        await assertBreakGlass(tx, s, i.workspaceId, 'erase a person’s review text', true);
        if (i.requestId) await openDataRequest(tx, i.requestId, ['delete_person_in_reviews'], i.workspaceId);
        const del = await tx`delete from customer_signals where workspace_id = ${i.workspaceId} and text ilike ${'%' + i.phrase.replace(/[%_\\]/g, '') + '%'} returning id`;
        await audit(tx, s, 'privacy.erase_reviews', { type: 'workspace', id: i.workspaceId }, { workspaceId: i.workspaceId, reason: i.reason, after: { deleted: del.length, requestId: i.requestId ?? null } });
        if (i.requestId) {
          await tx`update data_requests set status = 'completed', completed_at = now(), notes = concat_ws(' · ', notes, ${`Deleted ${del.length} review snippets (${s.name}); owners notified.`}::text) where id = ${i.requestId}`;
        }
        return del.length;
      });
      // The tenant is told what was removed from their workspace and why (never whose text it was).
      const [w] = await withAdmin((tx) => tx`select name from workspaces where id = ${i.workspaceId}`);
      const url = appUrl(await workspaceSlug(i.workspaceId), '/settings/access-log');
      const reference = i.requestId ? `Privacy request ${i.requestId.slice(0, 8)}` : i.reason.slice(0, 80);
      for (const to of await ownerEmails(i.workspaceId)) {
        await sendEmail('review_text_erased', to, { workspaceName: (w?.name as string) ?? 'your workspace', deleted, reference, url }, { idempotencyKey: `review-erase:${i.workspaceId}:${i.requestId ?? i.phrase}:${to}`, workspaceId: i.workspaceId }).catch(() => {});
      }
      return { message: `Deleted ${deleted} review snippets; the workspace owners were notified. Themes refresh on the next clustering run.` };
    },
  }),

  /* ── Taxonomy ── */
  /* §19 taxonomy: a proposal (add / rename / deprecate one value) → review by a second staff member → new version
     and, when genomes must move, a remap the worker applies. Nothing becomes canonical without review. */
  'taxonomy.propose': a({
    perm: 'taxonomy.manage',
    schema: z.object({ family: z.enum(TAXONOMY_FAMILIES), op: z.enum(['add', 'rename', 'deprecate']), value: z.string().trim().toUpperCase(), to: z.string().trim().toUpperCase().optional(), reason }),
    run: (s, i) => withAdmin(async (tx) => ({ id: await proposeTaxonomyChange(tx, s, { family: i.family, op: i.op, value: i.value, to: i.to || null, reason: i.reason }), message: 'Proposed. Another staff member reviews it before it becomes canonical.' })),
  }),
  'taxonomy.review': a({
    perm: 'taxonomy.manage',
    reauth: true,
    schema: z.object({ id: uuid, approve: z.boolean(), note: z.string().trim().min(4, 'A review note is required') }),
    run: (s, i) =>
      withAdmin(async (tx) => {
        const r = await reviewTaxonomyProposal(tx, s, i.id, i.approve, i.note);
        return { message: r.version ? `Taxonomy v${r.version} recorded.${r.remap ? ' Existing genomes are being remapped.' : ''}` : 'Proposal rejected.' };
      }),
  }),

  /* ── Staff ── */
  // Invite staff (§23): an emailed single-use link; the invitee sets their own password and enrols their
  // authenticator, so the inviter never holds either factor. The account starts without roles and the requested
  // roles go through four-eyes like any role change (§0.5), so one SUPER_ADMIN can't mint a privileged account alone.
  'staff.invite': a({
    perm: 'staff.manage',
    reauth: true,
    schema: z.object({ email: z.string().email(), name: z.string().trim().min(2).max(120), roles: z.string(), reason }),
    run: async (s, i) => {
      const roles = parseRoles(i.roles);
      if (!roles.length) throw new DomainError('INVALID', `Pick at least one role (${StaffRole.join(', ')}).`);
      const r = await withAdmin(async (tx) => {
        const inv = await inviteStaff(tx, { email: i.email, name: i.name, createdBy: s.staffId });
        await audit(tx, s, 'staff.invite', { type: 'staff', id: inv.staffId }, { reason: i.reason, after: { email: i.email.toLowerCase(), requestedRoles: roles, expiresAt: inv.expiresAt.toISOString() } });
        return inv;
      });
      await sendStaffInvite(s, i.email, i.name, r.token, r.inviteId);
      const grant = await requestOrExecute(s, 'staff.roles', { staffId: r.staffId, roles }, i.reason);
      const pending = grant.status === 'pending' ? ` Roles (${roles.join(', ')}) are pending approval by another SUPER_ADMIN (approval ${grant.approvalId.slice(0, 8)}).` : '';
      return { status: grant.status, approvalId: grant.status === 'pending' ? grant.approvalId : null, message: `Invite emailed to ${i.email} (valid ${STAFF_INVITE_HOURS} hours).${pending}` };
    },
  }),
  'staff.invite_resend': a({
    perm: 'staff.manage',
    reauth: true,
    schema: z.object({ staffId: uuid, reason: z.string().trim().max(500).optional() }),
    run: async (s, i) => {
      const r = await withAdmin(async (tx) => {
        const inv = await resendStaffInvite(tx, i.staffId, s.staffId);
        const [u] = await tx`select name from staff_users where id = ${i.staffId}`;
        await audit(tx, s, 'staff.invite_resend', { type: 'staff', id: i.staffId }, { reason: i.reason ?? null, after: { expiresAt: inv.expiresAt.toISOString() } });
        return { ...inv, name: u!.name as string };
      });
      await sendStaffInvite(s, r.email, r.name, r.token, r.inviteId);
      return { message: `New invite link emailed to ${r.email}; earlier links no longer work.` };
    },
  }),
  'staff.roles': a({ perm: 'staff.manage', reauth: true, schema: z.object({ staffId: uuid, roles: z.string(), reason }), run: (s, i) => requestOrExecute(s, 'staff.roles', { staffId: i.staffId, roles: parseRoles(i.roles) }, i.reason) }),
  'staff.deprovision': a({ perm: 'staff.manage', reauth: true, schema: z.object({ staffId: uuid, reason }), run: (s, i) => withAdmin(async (tx) => { if (i.staffId === s.staffId) throw new DomainError('CONFLICT', 'You can’t deprovision yourself.'); const [b] = await tx`select email, roles, active from staff_users where id = ${i.staffId}`; if (!b) throw new DomainError('NOT_FOUND', 'Staff member not found'); await deprovisionStaff(tx, i.staffId); await audit(tx, s, 'staff.deprovision', { type: 'staff', id: i.staffId }, { reason: i.reason, before: b, after: { active: false } }); }) }),
  'staff.confirm_roles': a({ perm: 'staff.manage', schema: z.object({ staffId: uuid }), run: (s, i) => withAdmin(async (tx) => { if (i.staffId === s.staffId) throw new DomainError('CONFLICT', 'Another SUPER_ADMIN confirms your roles (quarterly access review).'); const [b] = await tx`select roles, roles_confirmed_at from staff_users where id = ${i.staffId}`; await tx`update staff_users set roles_confirmed_at = now() where id = ${i.staffId}`; await audit(tx, s, 'staff.confirm_roles', { type: 'staff', id: i.staffId }, { before: b ?? null, after: { roles_confirmed_at: 'now' } }); }) }),
  // §23 "require passkey": the staff member must already have one, or they'd be locked out.
  'staff.require_passkey': a({
    perm: 'staff.manage',
    reauth: true,
    schema: z.object({ staffId: uuid, required: z.boolean(), reason }),
    run: (s, i) =>
      withAdmin(async (tx) => {
        const [u] = await tx`select require_passkey, (select count(*)::int from staff_passkeys where staff_id = ${i.staffId}) as passkeys from staff_users where id = ${i.staffId} for update`;
        if (!u) throw new DomainError('NOT_FOUND', 'Staff member not found');
        if (i.required && Number(u.passkeys) === 0) throw new DomainError('CONFLICT', 'They have no passkey yet. Ask them to add one under Passkeys first.');
        await tx`update staff_users set require_passkey = ${i.required} where id = ${i.staffId}`;
        await audit(tx, s, 'staff.require_passkey', { type: 'staff', id: i.staffId }, { reason: i.reason, before: { require_passkey: u.require_passkey }, after: { require_passkey: i.required } });
        return { message: i.required ? 'Passkey required: authenticator codes no longer work for this account.' : 'Passkey no longer required.' };
      }),
  }),
  // §0.1 IP allowlist per staff role. Refuses a change that would lock the acting staff member out.
  'staff.ip_policy': a({
    perm: 'staff.manage',
    reauth: true,
    schema: z.object({ role: z.enum(StaffRole), enabled: z.boolean(), cidrs: z.string().max(2000).default(''), reason }),
    run: (s, i) =>
      withAdmin(async (tx) => {
        const cidrs = [...new Set(i.cidrs.split(/[\s,]+/).map((c) => c.trim()).filter(Boolean))];
        for (const c of cidrs) {
          const ok = await tx.savepoint((sp) => sp`select ${c}::cidr`).then(() => true, () => false);
          if (!ok) throw new DomainError('INVALID', `“${c}” isn’t a network. Use CIDR notation, e.g. 203.0.113.0/24.`);
        }
        const [before] = await tx`select enabled, cidrs::text[] as cidrs from staff_role_ip_policies where role = ${i.role} for update`;
        await tx`insert into staff_role_ip_policies (role, enabled, cidrs, updated_by, updated_at) values (${i.role}, ${i.enabled}, ${cidrs}::cidr[], ${s.staffId}, now())
                 on conflict (role) do update set enabled = excluded.enabled, cidrs = excluded.cidrs, updated_by = excluded.updated_by, updated_at = now()`;
        if (!(await staffNetworkAllowed(tx, { id: s.staffId, roles: s.roles }, s.ip))) {
          throw new DomainError('CONFLICT', `This would lock you out: your current address (${s.ip ?? 'unknown'}) isn’t in the networks your roles allow.`);
        }
        await audit(tx, s, 'staff.ip_policy', { type: 'staff_role', id: i.role }, { reason: i.reason, before: before ?? null, after: { enabled: i.enabled, cidrs } });
        return { message: i.enabled && cidrs.length ? `${i.role}: sign-in and every request limited to ${cidrs.length} network${cidrs.length === 1 ? '' : 's'}.` : `${i.role}: ${i.enabled ? 'on, but not enforced until a network is listed' : 'off'}.` };
      }),
  }),

  /* ── Your own account ── */
  'account.passkey_remove': a({
    perm: 'account.self',
    reauth: true,
    schema: z.object({ passkeyId: uuid }),
    run: (s, i) =>
      withAdmin(async (tx) => {
        const name = await removeStaffPasskey(tx, s.staffId, i.passkeyId);
        await audit(tx, s, 'staff.passkey_removed', { type: 'staff', id: s.staffId }, { before: { passkeyId: i.passkeyId, name } });
        return { message: `Removed “${name}”.` };
      }),
  }),
} as const;

export type ActionName = keyof typeof ACTIONS;
