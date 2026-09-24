import type { Tx } from '@arkiv/db';
import { DomainError, formatUsd } from '@arkiv/shared';
import { billingGateway, type DisputeEvidence } from './gateway';

/**
 * Dispute evidence (plan 05 §7 "Disputes: evidence pack auto-assembled (delivery timestamps, export logs, ToS
 * acceptance, IP), submitted via Stripe"). Assembled from what we recorded when the customer bought and used the
 * product: the payment, the finished ad's delivery, every export (download) with who made it, the consent records
 * with their IP, and the receipt email. Runs as staff (admin_rw sees every tenant), so every query is tied to the
 * dispute's own workspace.
 */

export interface EvidencePack {
  disputeId: string;
  workspaceId: string;
  amountCents: number;
  reason: string | null;
  status: string;
  dueBy: string | null;
  payment: { kind: 'one_off' | 'subscription' | 'unknown'; reference: string | null; paidAt: string | null; description: string };
  deliveries: { at: string; what: string }[];
  exports: { at: string; assetId: string; by: string }[];
  consents: { at: string; kind: string; version: string; ip: string | null; userAgent: string | null; text: string }[];
  receipts: { at: string; template: string; status: string }[];
  customer: { name: string | null; email: string | null; ip: string | null };
  evidence: DisputeEvidence;
}

const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);
const line = (at: string | null, text: string) => `${at ? at.replace('T', ' ').slice(0, 19) + ' UTC' : '—'}  ${text}`;

export async function assembleDisputeEvidence(tx: Tx, workspaceId: string, disputeId: string): Promise<EvidencePack> {
  const [d] = await tx`select * from stripe_disputes where id = ${disputeId} and workspace_id = ${workspaceId}`;
  if (!d) throw new DomainError('NOT_FOUND', 'Dispute not found for this workspace');
  const pi = (d.payment_intent_id as string) ?? null;
  const [purchase] = pi ? await tx`select id, kind, project_id, amount_micros, paid_at, created_by from purchases where workspace_id = ${workspaceId} and stripe_payment_intent_id = ${pi}` : [];
  const [invoice] = !purchase && pi ? await tx`select id, period_start, period_end, amount_paid_cents, stripe_created_at from stripe_invoices where workspace_id = ${workspaceId} and payment_intent_id = ${pi}` : [];
  const [w] = await tx`select name, created_at from workspaces where id = ${workspaceId}`;
  // The buyer: who started the checkout, else the workspace owner.
  const buyerId = purchase?.created_by && String(purchase.created_by).startsWith('user:') ? String(purchase.created_by).slice(5) : null;
  const [buyer] = buyerId
    ? await tx`select u.id, u.email, u.name from users u join memberships m on m.user_id = u.id and m.workspace_id = ${workspaceId} where u.id = ${buyerId}`
    : await tx`select u.id, u.email, u.name from memberships m join users u on u.id = m.user_id where m.workspace_id = ${workspaceId} and m.role = 'OWNER' order by m.created_at limit 1`;
  const paidAt = iso(purchase?.paid_at ?? invoice?.stripe_created_at);

  // Delivery: the finished ad (one-off) or every ad delivered during the paid period (subscription).
  const from = invoice?.period_start ?? purchase?.paid_at ?? null;
  const to = invoice?.period_end ?? null;
  const deliveries = await tx`
    select e.at, e.subject_id, e.type from events e
    where e.workspace_id = ${workspaceId} and e.type = 'COMPOSITION_COMPLETED'
      and (${purchase?.project_id ?? null}::uuid is null or e.subject_id = ${purchase?.project_id ?? null})
      and (${from}::timestamptz is null or e.at >= ${from}) and (${to}::timestamptz is null or e.at <= ${to})
    order by e.at limit 50`;
  const exports = await tx`
    select e.at, e.subject_id, e.actor from events e left join assets a on a.id = e.subject_id and a.workspace_id = e.workspace_id
    where e.workspace_id = ${workspaceId} and e.type = 'ASSET_EXPORTED'
      and (${purchase?.project_id ?? null}::text is null or a.lineage->>'projectId' = ${purchase?.project_id ?? null})
      and (${from}::timestamptz is null or e.at >= ${from}) and (${to}::timestamptz is null or e.at <= ${to})
    order by e.at limit 100`;
  const consents = await tx`select created_at, kind, text_version, text_snapshot, host(ip) as ip, user_agent from consent_records
                            where workspace_id = ${workspaceId} order by created_at desc limit 10`;
  const receipts = await tx`select created_at, template, status from email_log where workspace_id = ${workspaceId}
                            and template in ('receipt', 'subscription_started', 'asset_ready') order by created_at limit 20`;
  // The IP the buyer used around the purchase: their consent (subscriptions), else their session at that time.
  const [session] = buyer
    ? await tx`select host(ip) as ip from sessions where user_id = ${buyer.id} and ip is not null
               order by abs(extract(epoch from (created_at - coalesce(${paidAt}::timestamptz, now())))) limit 1`
    : [];
  const ip = (consents.find((c) => c.ip)?.ip as string) ?? (session?.ip as string) ?? null;

  const description = purchase
    ? `${purchase.kind === 'taste' ? 'Intro' : 'One-off'} purchase of one finished 15-second video ad (${formatUsd(Number(purchase.amount_micros))}) for the customer's own skincare product, made with Arkiv (ad testing software).`
    : invoice
      ? `Monthly Arkiv subscription (${formatUsd(Number(invoice.amount_paid_cents) * 10_000)}), for the period ${iso(invoice.period_start)?.slice(0, 10) ?? '?'} to ${iso(invoice.period_end)?.slice(0, 10) ?? '?'}: Creative Tests (finished video ads) for the customer's skincare products.`
      : 'Arkiv purchase (the payment could not be matched to a recorded purchase).';
  const deliveryLines = deliveries.map((e) => ({ at: iso(e.at)!, what: `Finished ad delivered (project ${String(e.subject_id).slice(0, 8)})` }));
  const exportLines = exports.map((e) => ({ at: iso(e.at)!, assetId: e.subject_id as string, by: String(e.actor) }));
  const consentLines = consents.map((c) => ({ at: iso(c.created_at)!, kind: c.kind as string, version: c.text_version as string, ip: (c.ip as string) ?? null, userAgent: (c.user_agent as string) ?? null, text: String(c.text_snapshot).slice(0, 400) }));
  const receiptLines = receipts.map((r) => ({ at: iso(r.created_at)!, template: r.template as string, status: r.status as string }));

  const accessLog = [
    ...deliveryLines.map((x) => line(x.at, x.what)),
    ...exportLines.map((x) => line(x.at, `Downloaded ad file ${x.assetId.slice(0, 8)} (${x.by.startsWith('user:') ? 'signed-in customer' : x.by})`)),
  ].sort();
  const evidence: DisputeEvidence = {
    product_description: description,
    ...(buyer?.email ? { customer_email_address: buyer.email as string } : {}),
    ...(buyer?.name ? { customer_name: buyer.name as string } : {}),
    ...(ip ? { customer_purchase_ip: ip } : {}),
    ...(deliveryLines[0] ? { service_date: deliveryLines[0].at.slice(0, 10) } : {}),
    access_activity_log: (accessLog.length ? accessLog.join('\n') : 'No delivery or download recorded.').slice(0, 20_000),
    refund_policy_disclosure: 'Quality guarantee shown at checkout: if the ad fails our product-accuracy check, the customer is refunded automatically. Refunds can also be requested from support.',
    uncategorized_text: [
      `Workspace “${w?.name as string}” created ${iso(w?.created_at)?.slice(0, 10) ?? '?'}; payment ${paidAt ? `captured ${paidAt.slice(0, 16).replace('T', ' ')} UTC` : 'not found in our records'}.`,
      consentLines.length
        ? `Terms accepted: ${consentLines.map((c) => `${c.kind} ${c.version} at ${c.at.slice(0, 16).replace('T', ' ')} UTC${c.ip ? ` from ${c.ip}` : ''}`).join('; ')}.`
        : 'No separate consent record on file for this purchase (one-off purchases accept the terms shown at checkout).',
      receiptLines.length ? `Emails sent: ${receiptLines.map((r) => `${r.template} (${r.status}) ${r.at.slice(0, 10)}`).join('; ')}.` : '',
    ]
      .filter(Boolean)
      .join('\n')
      .slice(0, 20_000),
  };
  return {
    disputeId,
    workspaceId,
    amountCents: Number(d.amount_cents),
    reason: (d.reason as string) ?? null,
    status: d.status as string,
    dueBy: iso(d.evidence_due_by),
    payment: { kind: purchase ? 'one_off' : invoice ? 'subscription' : 'unknown', reference: (purchase?.id as string) ?? (invoice?.id as string) ?? null, paidAt, description },
    deliveries: deliveryLines,
    exports: exportLines,
    consents: consentLines,
    receipts: receiptLines,
    customer: { name: (buyer?.name as string) ?? null, email: (buyer?.email as string) ?? null, ip },
    evidence,
  };
}

/** Dispute statuses that still accept evidence. */
export const DISPUTE_OPEN = ['needs_response', 'warning_needs_response'];

/**
 * Submit the assembled pack via Stripe (final) and record what was sent. One submission per dispute: Stripe accepts
 * a response once, and the idempotency key makes a retried click send the same one.
 */
export async function submitDisputeEvidence(tx: Tx, workspaceId: string, disputeId: string, staffId: string, note?: string | null) {
  const [d] = await tx`select status, evidence_due_by, evidence_submitted_at from stripe_disputes where id = ${disputeId} and workspace_id = ${workspaceId} for update`;
  if (!d) throw new DomainError('NOT_FOUND', 'Dispute not found for this workspace');
  if (d.evidence_submitted_at) throw new DomainError('CONFLICT', 'Evidence was already submitted for this dispute.');
  if (!DISPUTE_OPEN.includes(d.status as string)) throw new DomainError('CONFLICT', `This dispute is ${String(d.status).replace(/_/g, ' ')}; Stripe no longer accepts evidence.`);
  if (d.evidence_due_by && new Date(d.evidence_due_by as string) < new Date()) throw new DomainError('CONFLICT', 'The evidence deadline has passed.');
  const pack = await assembleDisputeEvidence(tx, workspaceId, disputeId);
  const evidence: DisputeEvidence = note?.trim() ? { ...pack.evidence, uncategorized_text: `${note.trim()}\n\n${pack.evidence.uncategorized_text ?? ''}`.slice(0, 20_000) } : pack.evidence;
  await billingGateway().submitDisputeEvidence(disputeId, evidence, `dispute-evidence:${disputeId}`);
  await tx`update stripe_disputes set evidence = ${tx.json(evidence as never)}, evidence_submitted_at = now(), evidence_submitted_by = ${staffId}, status = 'under_review', updated_at = now()
           where id = ${disputeId} and workspace_id = ${workspaceId}`;
  return { evidence, pack };
}
