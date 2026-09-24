import { withAdmin, type Tx } from '@arkiv/db';
import { append, audit, stopForRefund, type Staff, type TenantContext } from '@arkiv/core';
import { sendEmail } from '@arkiv/email';
import { DomainError, env, formatUsd, type RefundReason } from '@arkiv/shared';
import { billingGateway } from './gateway';

/**
 * Refund tool (plan 05 §7): choose payment → amount → reason code → customer note. One idempotent operation
 * writes the Stripe refund, a `refunds` mirror row and a CREDIT_REFUNDED ledger entry:
 *   1. a pending mirror row keyed by the request's idempotency key is committed first (a replay finds it);
 *   2. Stripe is called with the same idempotency key (a retried call returns the same refund);
 *   3. the mirror row, the purchase's refunded amount and the ledger entry are written in one transaction.
 * Stripe's charge.refunded webhook then finds the refund already recorded; refunds made elsewhere (Stripe
 * dashboard, duplicate-payment auto-refund) go through the same bookkeeping from the webhook.
 */

export interface RefundRequest {
  workspaceId: string;
  /** A one-time purchase (Taste / Standalone)… */
  purchaseId?: string | null;
  /** …or a subscription payment: the stored invoice.paid Stripe event. */
  invoiceEventId?: string | null;
  amountMicros: number;
  reasonCode: RefundReason;
  customerNote?: string | null;
  /** Makes the request idempotent across retries and the four-eyes approval. */
  nonce: string;
  reason: string;
}

interface Payment {
  purchaseId: string | null;
  invoiceId: string | null;
  paymentIntentId: string;
  amountMicros: number;
  refundedMicros: number;
  description: string;
}

const centsToMicros = (c: number) => Math.round(c * 10_000);

/** payment_intent of a stored invoice.paid event (older API versions inline it; newer ones list payments). */
function invoicePayment(payload: unknown): { invoiceId: string; paymentIntentId: string | null; amountMicros: number } {
  const inv = (payload as { data?: { object?: Record<string, unknown> } })?.data?.object ?? {};
  const pi = (inv.payment_intent as string | undefined) ?? ((inv.payments as { data?: { payment?: { payment_intent?: string } }[] } | undefined)?.data?.[0]?.payment?.payment_intent ?? null);
  return { invoiceId: String(inv.id ?? ''), paymentIntentId: pi, amountMicros: centsToMicros(Number(inv.amount_paid ?? 0)) };
}

async function loadPayment(tx: Tx, r: RefundRequest): Promise<Payment> {
  const ws = r.workspaceId;
  if (r.purchaseId) {
    const [pu] = await tx`select * from purchases where id = ${r.purchaseId} and workspace_id = ${ws} for update`;
    if (!pu || !['paid', 'refunded'].includes(pu.status as string) || !pu.stripe_payment_intent_id) throw new DomainError('CONFLICT', 'Only paid purchases with a payment can be refunded');
    return { purchaseId: pu.id as string, invoiceId: null, paymentIntentId: pu.stripe_payment_intent_id as string, amountMicros: Number(pu.amount_micros), refundedMicros: Number(pu.refunded_micros), description: pu.kind === 'taste' ? '15-second ad · intro price' : '15-second ad' };
  }
  if (r.invoiceEventId) {
    const [e] = await tx`select payload from stripe_events where id = ${r.invoiceEventId} and workspace_id = ${ws} and type = 'invoice.paid' for update`;
    if (!e) throw new DomainError('NOT_FOUND', 'Subscription payment not found');
    const inv = invoicePayment(e.payload);
    if (!inv.paymentIntentId || inv.amountMicros <= 0) throw new DomainError('CONFLICT', 'This invoice has no refundable payment on record.');
    const [done] = await tx`select coalesce(sum(amount_micros), 0)::bigint as n from refunds where workspace_id = ${ws} and payment_intent_id = ${inv.paymentIntentId} and status = 'succeeded'`;
    return { purchaseId: null, invoiceId: inv.invoiceId, paymentIntentId: inv.paymentIntentId, amountMicros: inv.amountMicros, refundedMicros: Number(done!.n), description: 'Subscription payment' };
  }
  throw new DomainError('INVALID', 'Choose a purchase or a subscription payment to refund.');
}

/**
 * Record a refund that Stripe has confirmed: mirror row → purchase refunded amount → CREDIT_REFUNDED. Idempotent
 * per mirror row. A purchase refunded in full also gives back its credit if that credit was never used or
 * reserved (plan 02 B9: delivered work stays accessible; unused entitlement is withdrawn).
 */
export async function applySucceededRefund(tx: Tx, ctx: Pick<TenantContext, 'workspaceId' | 'actor'>, refundRowId: string, stripeRefundId: string | null) {
  const ws = ctx.workspaceId;
  const [row] = await tx`select * from refunds where id = ${refundRowId} and workspace_id = ${ws} for update`;
  if (!row) throw new DomainError('NOT_FOUND', 'Refund not found');
  if (row.status === 'succeeded') return { replayed: true, revoked: false };
  await tx`update refunds set status = 'succeeded', stripe_refund_id = coalesce(${stripeRefundId}, stripe_refund_id), completed_at = now() where id = ${row.id}`;
  let unit: 'taste' | 'standalone' | 'creative_test' = 'creative_test';
  let amount = 0;
  let projectId: string | null = null;
  if (row.purchase_id) {
    const [pu] = await tx`update purchases set refunded_micros = refunded_micros + ${row.amount_micros},
                            status = case when refunded_micros + ${row.amount_micros} >= amount_micros then 'refunded' else status end,
                            refunded_at = case when refunded_micros + ${row.amount_micros} >= amount_micros then coalesce(refunded_at, now()) else refunded_at end
                          where id = ${row.purchase_id} and workspace_id = ${ws} returning *`;
    if (pu) {
      unit = pu.kind as 'taste' | 'standalone';
      projectId = (pu.project_id as string) ?? null;
      if (pu.status === 'refunded') {
        const [granted] = await tx`select 1 from ledger_entries where workspace_id = ${ws} and type = 'CREDIT_GRANTED' and unit = ${unit} and reference = ${pu.stripe_checkout_session_id as string}`;
        const [used] = await tx`select 1 from ledger_entries where workspace_id = ${ws} and project_id = ${projectId} and type = 'CREDIT_CONSUMED'`;
        const [reserved] = await tx`select 1 from cost_authorizations where workspace_id = ${ws} and project_id = ${projectId} and status = 'active'`;
        const [already] = await tx`select 1 from ledger_entries where workspace_id = ${ws} and project_id = ${projectId} and type = 'CREDIT_REFUNDED' and amount < 0`;
        if (granted && !used && !reserved && !already) amount = -1;
      }
    }
  }
  await append(tx, ctx, {
    type: 'CREDIT_REFUNDED',
    unit,
    amount,
    projectId,
    reference: (stripeRefundId ?? row.stripe_refund_id ?? row.idempotency_key) as string,
    reason: `${row.reason_code as string}: ${formatUsd(Number(row.amount_micros))} refunded${amount < 0 ? ' before use (credit withdrawn)' : ''}`,
    idempotencyKey: `refund:${row.id}`,
  });
  // Paid in full back while its ad isn't delivered: production stops and the project ends REFUNDED (a running
  // production stops at its next checkpoint and withdraws the credit it held then).
  if (projectId && row.purchase_id && unit !== 'creative_test') {
    const [pu] = await tx`select status from purchases where id = ${row.purchase_id} and workspace_id = ${ws}`;
    if (pu?.status === 'refunded') await stopForRefund(tx, ctx, projectId, row.purchase_id as string);
  }
  return { replayed: false, revoked: amount < 0 };
}

/** Console refund (four-eyes above $200 is enforced by requestOrExecute before this runs). */
export async function refundPayment(r: RefundRequest, who: { requester: Staff; approver: Staff }) {
  const ws = r.workspaceId;
  if (!Number.isFinite(r.amountMicros) || r.amountMicros <= 0) throw new DomainError('INVALID', 'Enter an amount to refund.');
  const idem = `refund:${r.purchaseId ?? r.invoiceEventId}:${r.nonce}`;
  const row = await withAdmin(async (tx) => {
    const [existing] = await tx`select * from refunds where workspace_id = ${ws} and idempotency_key = ${idem}`;
    if (existing) return existing;
    const pay = await loadPayment(tx, r);
    const [pending] = await tx`select coalesce(sum(amount_micros), 0)::bigint as n from refunds where workspace_id = ${ws} and payment_intent_id = ${pay.paymentIntentId} and status = 'pending'`;
    const refundable = pay.amountMicros - pay.refundedMicros - Number(pending!.n);
    if (r.amountMicros > refundable) throw new DomainError('CONFLICT', `Only ${formatUsd(Math.max(0, refundable))} of this payment can still be refunded.`);
    const [ins] = await tx`insert into refunds (workspace_id, purchase_id, invoice_id, payment_intent_id, amount_micros, reason_code, customer_note, idempotency_key, requested_by, approved_by)
                           values (${ws}, ${pay.purchaseId}, ${pay.invoiceId}, ${pay.paymentIntentId}, ${r.amountMicros}, ${r.reasonCode}, ${r.customerNote?.trim() || null}, ${idem},
                                   ${who.requester.staffId}, ${who.approver.staffId}) returning *`;
    return { ...ins!, description: pay.description };
  });
  if (row.status === 'succeeded') return { replayed: true, refundId: row.stripe_refund_id as string, amountMicros: Number(row.amount_micros) };
  if (row.status === 'failed') throw new DomainError('CONFLICT', `This refund already failed (${row.error as string}). Start a new one.`);

  let stripeRefundId: string;
  try {
    stripeRefundId = await billingGateway().refund(row.payment_intent_id as string, Math.round(Number(row.amount_micros) / 10_000), idem);
  } catch (e) {
    await withAdmin((tx) => tx`update refunds set status = 'failed', error = ${(e as Error).message.slice(0, 300)}, completed_at = now() where id = ${row.id}`);
    throw e;
  }
  const ctx = { workspaceId: ws, actor: { kind: 'staff' as const, id: who.approver.staffId } };
  const applied = await withAdmin(async (tx) => {
    const res = await applySucceededRefund(tx, ctx, row.id as string, stripeRefundId);
    await audit(tx, who.approver, 'billing.refunded', { type: row.purchase_id ? 'purchase' : 'invoice', id: (row.purchase_id ?? row.invoice_id) as string }, {
      workspaceId: ws,
      reason: r.reason,
      after: { amountMicros: Number(row.amount_micros), refundId: stripeRefundId, reasonCode: r.reasonCode, customerNote: r.customerNote ?? null, creditWithdrawn: res.revoked },
    });
    return res;
  });
  // The customer hears about it from us, with the note staff wrote (transactional, idempotent per recipient).
  const owners = await withAdmin((tx) => tx`select u.email from memberships m join users u on u.id = m.user_id where m.workspace_id = ${ws} and m.role = 'OWNER' and u.deleted_at is null`);
  const [w] = await withAdmin((tx) => tx`select slug from workspaces where id = ${ws}`);
  for (const o of owners) {
    await sendEmail(
      'refund_issued',
      o.email as string,
      { amount: formatUsd(Number(row.amount_micros)), description: String((row as { description?: string }).description ?? 'Your payment'), note: r.customerNote?.trim() || null, url: `${env().APP_URL}/w/${w?.slug as string}/settings/billing` },
      { idempotencyKey: `refund-mail:${row.id}:${o.email}`, workspaceId: ws },
    ).catch(() => {});
  }
  return { refundId: stripeRefundId, amountMicros: Number(row.amount_micros), creditWithdrawn: applied.revoked };
}

/**
 * Webhook side (charge.refunded): record whatever part of the charge's refunded total isn't already on file —
 * a refund made in the Stripe dashboard, or one whose console transaction hasn't committed yet is skipped
 * because its pending mirror row already accounts for it.
 */
export async function recordChargeRefund(tx: Tx, ctx: TenantContext, charge: { id: string; payment_intent: string | null; amount_refunded?: number | null; refunded?: boolean | null }) {
  const ws = ctx.workspaceId;
  const pi = charge.payment_intent ?? '';
  if (!pi) return null;
  const [pu] = await tx`select id, amount_micros from purchases where workspace_id = ${ws} and stripe_payment_intent_id = ${pi} for update`;
  const total = charge.amount_refunded != null ? centsToMicros(Number(charge.amount_refunded)) : pu && charge.refunded !== false ? Number(pu.amount_micros) : 0;
  const [known] = await tx`select coalesce(sum(amount_micros), 0)::bigint as n from refunds where workspace_id = ${ws} and payment_intent_id = ${pi} and status in ('pending','succeeded')`;
  const delta = total - Number(known!.n);
  if (delta <= 0) return null;
  const [row] = await tx`insert into refunds (workspace_id, purchase_id, payment_intent_id, amount_micros, reason_code, customer_note, idempotency_key)
                         values (${ws}, ${pu?.id ?? null}, ${pi}, ${delta}, 'other', ${'Refunded outside the console (Stripe)'}, ${`charge:${charge.id}:${total}`})
                         on conflict (workspace_id, idempotency_key) do nothing returning id`;
  if (!row) return null;
  return applySucceededRefund(tx, ctx, row.id as string, null);
}
