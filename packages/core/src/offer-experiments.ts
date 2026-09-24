import { z } from 'zod';
import type { Tx } from '@arkiv/db';
import { DomainError } from '@arkiv/shared';
import { audit, type Staff } from './admin';
import { raiseAlert } from './alerts';
import { assertVariantWeights } from './flags';

/**
 * Offer experiments (plan 05 §6): variants of an offer definition (price, timer), their allocation, and guardrail
 * metrics that stop the experiment automatically when a variant degrades past its threshold. The engine assigns a
 * variant per workspace when it issues the offer (offers.ts); an offer already issued never changes. Only the
 * Taste offer is experimentable (the engine reads experiments when it issues that offer).
 */

const key = z.string().trim().regex(/^[a-z0-9][a-z0-9_.-]{2,39}$/, 'Keys are 3–40 lowercase letters, digits, . _ -');
const rate = z.number().min(0).max(1);

/**
 * The metric an experiment is judged on, registered before it starts (plan 04 L22 "pre-registered metrics"):
 *  - paid_conversion: offers paid ÷ offers issued (storyboard with the offer → paid Taste, the S7→S8 step);
 *  - checkout_rate: offers whose checkout was opened ÷ offers issued.
 */
export const OFFER_METRICS = ['paid_conversion', 'checkout_rate'] as const;
export type OfferMetric = (typeof OFFER_METRICS)[number];

export const OfferExperimentInput = z
  .object({
    key,
    /** Pre-registered: the metric the experiment is read on, and the offers each variant needs before it is read. */
    primaryMetric: z.enum(OFFER_METRICS).default('paid_conversion'),
    minSamplePerVariant: z.number().int().min(10).max(1_000_000).default(100),
    variants: z
      .array(
        z
          .object({
            key: z.string().trim().regex(/^[a-z0-9_-]{1,24}$/, 'Variant keys are lowercase letters, digits, - and _'),
            weight: z.number().finite().positive('Weights must be greater than 0'),
            priceMicros: z.number().int().min(1_000_000).max(1_000_000_000).optional(),
            windowMinutes: z.number().int().min(30).max(1440).optional(),
          })
          .strict(),
      )
      .min(2)
      .max(4),
    guardrails: z
      .object({
        /** Refunded share of paid offers, per variant. */
        maxRefundRate: rate.optional(),
        /** Disputed (chargeback) share of paid offers, per variant. */
        maxDisputeRate: rate.optional(),
        /** Share of workspaces offered the variant that opened a support ticket afterwards. */
        maxSupportRate: rate.optional(),
        /** Guardrails are judged only once a variant has this many paid (refund/dispute) or issued (support) offers. */
        minSample: z.number().int().min(5).max(100_000).default(30),
      })
      .strict()
      .refine((g) => g.maxRefundRate !== undefined || g.maxDisputeRate !== undefined || g.maxSupportRate !== undefined, 'Set at least one guardrail threshold.'),
  })
  .strict();
/** As stored: experiments started before pre-registration existed carry no metric (read as paid conversion). */
export type OfferExperiment = Omit<z.infer<typeof OfferExperimentInput>, 'primaryMetric' | 'minSamplePerVariant'> & {
  primaryMetric?: OfferMetric;
  minSamplePerVariant?: number;
  startedAt?: string;
  startedBy?: string;
};

export interface OfferVariantResult {
  variant: string;
  issued: number;
  redeemed: number;
  expired: number;
  /** Offers whose checkout was opened at least once. */
  checkoutStarted: number;
  paid: number;
  refunded: number;
  disputed: number;
  support: number;
  conversion: number | null;
  /** Checkout opened ÷ issued. */
  checkoutRate: number | null;
  /** Paid ÷ issued. */
  paidConversion: number | null;
  refundRate: number | null;
  disputeRate: number | null;
  supportRate: number | null;
}

/**
 * Per-variant results of one experiment of an offer definition. Staff/system roles see every tenant: every join is
 * tied to the offer's own workspace.
 */
export async function offerExperimentResults(tx: Tx, code: string, experimentKey: string): Promise<OfferVariantResult[]> {
  const rows = await tx`
    select o.variant,
      -- Distinct offers: an offer whose checkout was opened more than once has several purchase rows.
      count(distinct o.id)::int as issued,
      count(distinct o.id) filter (where o.status = 'redeemed')::int as redeemed,
      count(distinct o.id) filter (where o.status = 'expired')::int as expired,
      count(distinct o.id) filter (where p.id is not null)::int as checkout_started,
      count(distinct p.id) filter (where p.status in ('paid', 'refunded'))::int as paid,
      count(distinct p.id) filter (where p.status = 'refunded' or p.refunded_micros > 0)::int as refunded,
      count(distinct p.id) filter (where exists (select 1 from stripe_disputes d where d.workspace_id = p.workspace_id and d.payment_intent_id = p.stripe_payment_intent_id))::int as disputed,
      count(distinct o.workspace_id) filter (where exists (
        select 1 from break_glass_sessions b where b.workspace_id = o.workspace_id and b.started_at >= o.created_at and (b.reason_kind = 'ticket' or b.ticket is not null))
        or exists (select 1 from tenant_notes n where n.workspace_id = o.workspace_id and n.created_at >= o.created_at and n.sentiment = 'negative'))::int as support
    from offers o
    left join purchases p on p.workspace_id = o.workspace_id and p.offer_id = o.id
    where o.definition_code = ${code} and o.experiment_key = ${experimentKey} and o.variant is not null
    group by o.variant order by o.variant`;
  return rows.map((r) => {
    const n = (k: string) => Number(r[k]);
    const ratio = (a: number, b: number) => (b ? a / b : null);
    return {
      variant: r.variant as string,
      issued: n('issued'),
      redeemed: n('redeemed'),
      expired: n('expired'),
      checkoutStarted: n('checkout_started'),
      paid: n('paid'),
      refunded: n('refunded'),
      disputed: n('disputed'),
      support: n('support'),
      conversion: ratio(n('redeemed'), n('issued')),
      checkoutRate: ratio(n('checkout_started'), n('issued')),
      paidConversion: ratio(n('paid'), n('issued')),
      refundRate: ratio(n('refunded'), n('paid')),
      disputeRate: ratio(n('disputed'), n('paid')),
      supportRate: ratio(n('support'), n('issued')),
    };
  });
}

export interface OfferReadout {
  metric: OfferMetric;
  minSamplePerVariant: number;
  /** Every variant has reached its pre-registered sample. */
  ready: boolean;
  variants: { variant: string; n: number; value: number | null; diff: number | null; low: number | null; high: number | null }[];
  /** The variant ahead on the metric with a 95% interval against the first variant that excludes zero; null otherwise. */
  leader: string | null;
  note: string;
}

/**
 * Read an experiment on its pre-registered metric (plan 04 L22): nothing is called before every variant has its
 * minimum sample, and a difference counts only when its 95% interval (two proportions, normal approximation)
 * against the first variant excludes zero. Guardrails are judged separately (guardrailBreach).
 */
export function offerExperimentReadout(results: readonly OfferVariantResult[], exp: Pick<OfferExperiment, 'primaryMetric' | 'minSamplePerVariant' | 'variants'>): OfferReadout {
  const metric = exp.primaryMetric ?? 'paid_conversion';
  const minN = exp.minSamplePerVariant ?? 100;
  const byKey = new Map(results.map((r) => [r.variant, r]));
  const rows = exp.variants.map((v) => {
    const r = byKey.get(v.key);
    const n = r?.issued ?? 0;
    const x = r ? (metric === 'checkout_rate' ? r.checkoutStarted : r.paid) : 0;
    return { variant: v.key, n, x, value: n ? x / n : null };
  });
  const ready = rows.length > 1 && rows.every((r) => r.n >= minN);
  const base = rows[0]!;
  const variants = rows.map((r, i) => {
    if (i === 0 || !ready || r.value === null || base.value === null) return { variant: r.variant, n: r.n, value: r.value, diff: null, low: null, high: null };
    const diff = r.value - base.value;
    const se = Math.sqrt((r.value * (1 - r.value)) / r.n + (base.value * (1 - base.value)) / base.n);
    return { variant: r.variant, n: r.n, value: r.value, diff, low: diff - 1.96 * se, high: diff + 1.96 * se };
  });
  let leader: string | null = null;
  if (ready) {
    const better = variants.filter((v) => v.low !== null && v.low > 0).sort((a, b) => b.diff! - a.diff!);
    const worse = variants.filter((v) => v.high !== null && v.high < 0);
    if (better.length) leader = better[0]!.variant;
    else if (worse.length === variants.length - 1) leader = base.variant;
  }
  const short = rows.filter((r) => r.n < minN);
  const note = !ready
    ? `Collecting: ${short.map((r) => `${r.variant} ${r.n}/${minN}`).join(', ')} offers before ${metric.replace('_', ' ')} is read.`
    : leader
      ? `${leader} leads on ${metric.replace('_', ' ')} (95% interval excludes no difference).`
      : `No variant differs on ${metric.replace('_', ' ')} beyond noise yet.`;
  return { metric, minSamplePerVariant: minN, ready, variants, leader, note };
}

/** The first guardrail a variant breaches (judged only past the minimum sample), or null. */
export function guardrailBreach(results: readonly OfferVariantResult[], g: OfferExperiment['guardrails']): string | null {
  const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;
  for (const r of results) {
    if (r.paid >= g.minSample) {
      if (g.maxRefundRate !== undefined && r.refundRate !== null && r.refundRate > g.maxRefundRate) return `refund rate ${pct(r.refundRate)} on variant ${r.variant} (max ${pct(g.maxRefundRate)}, ${r.paid} paid)`;
      if (g.maxDisputeRate !== undefined && r.disputeRate !== null && r.disputeRate > g.maxDisputeRate) return `dispute rate ${pct(r.disputeRate)} on variant ${r.variant} (max ${pct(g.maxDisputeRate)}, ${r.paid} paid)`;
    }
    if (r.issued >= g.minSample && g.maxSupportRate !== undefined && r.supportRate !== null && r.supportRate > g.maxSupportRate) {
      return `support tickets from ${pct(r.supportRate)} of workspaces on variant ${r.variant} (max ${pct(g.maxSupportRate)}, ${r.issued} offered)`;
    }
  }
  return null;
}

type Def = Record<string, unknown>;
const historyOf = (d: Def) => (d.experiment_history as (OfferExperiment & { endedAt: string; endedBy: string; reason: string })[]) ?? [];

/**
 * Start, replace or end an offer's experiment. A new experiment needs a key never used on this offer (assignment
 * is a hash of the key, so a reused key would reshuffle workspaces), variant prices below the anchor it shows as
 * the regular price, and at least one guardrail. The experiment it replaces is kept in the history.
 */
export async function setOfferExperiment(tx: Tx, s: Staff, code: string, input: z.input<typeof OfferExperimentInput> | null, reason: string) {
  const [d] = await tx`select * from offer_definitions where code = ${code} for update`;
  if (!d) throw new DomainError('NOT_FOUND', 'Offer not found');
  const current = d.experiment as OfferExperiment | null;
  let next: OfferExperiment | null = null;
  if (input) {
    if (d.type !== 'TASTE') throw new DomainError('INVALID', 'Only the Taste offer runs experiments (the engine assigns variants when it issues it).');
    if (!d.active) throw new DomainError('CONFLICT', 'Activate the offer before experimenting on it.');
    const exp = OfferExperimentInput.parse(input);
    assertVariantWeights(exp.variants);
    const keys = exp.variants.map((v) => v.key);
    if (new Set(keys).size !== keys.length) throw new DomainError('INVALID', 'Variant keys must be unique.');
    const used = [current?.key, ...historyOf(d).map((h) => h.key)].filter(Boolean);
    if (used.includes(exp.key)) throw new DomainError('CONFLICT', `Experiment key “${exp.key}” was already used on ${code}; pick a new one.`);
    if (d.reference_code) {
      const [ref] = await tx`select price_micros from offer_definitions where code = ${d.reference_code}`;
      const high = exp.variants.find((v) => ref && (v.priceMicros ?? Number(d.price_micros)) >= Number(ref.price_micros));
      if (high) throw new DomainError('GATE_BLOCKED', `Variant ${high.key} must cost less than the regular price it is shown against (${d.reference_code as string}).`);
    }
    next = { ...exp, startedAt: new Date().toISOString(), startedBy: s.email };
  } else if (!current) throw new DomainError('CONFLICT', 'No experiment is running on this offer.');
  const ended = current ? [{ ...current, endedAt: new Date().toISOString(), endedBy: s.email, reason: input ? `replaced by ${next!.key}: ${reason}` : reason }] : [];
  await tx`update offer_definitions set experiment = ${next ? tx.json(next as never) : null}, experiment_history = experiment_history || ${tx.json(ended as never)}, updated_at = now() where code = ${code}`;
  await audit(tx, s, input ? 'offer.experiment_start' : 'offer.experiment_stop', { type: 'offer', id: code }, { reason, before: current, after: next });
  return next;
}

/**
 * Sweep (plan 05 §6 "Auto-stop if a guardrail degrades beyond a threshold"): stop every running experiment with a
 * breached guardrail. New offers go back to the definition's own price and window; offers already issued keep
 * theirs. Each stop is kept in the experiment history and raised as a Pulse alert.
 */
export async function sweepOfferGuardrails(tx: Tx): Promise<{ code: string; experiment: string; why: string }[]> {
  const defs = await tx`select code, experiment from offer_definitions where experiment is not null for update`;
  const stopped: { code: string; experiment: string; why: string }[] = [];
  for (const d of defs) {
    const exp = d.experiment as OfferExperiment;
    if (!exp?.guardrails) continue;
    const results = await offerExperimentResults(tx, d.code as string, exp.key);
    const why = guardrailBreach(results, { ...exp.guardrails, minSample: exp.guardrails.minSample ?? 30 });
    if (!why) continue;
    const entry = { ...exp, endedAt: new Date().toISOString(), endedBy: 'system:offer-guardrails', reason: `guardrail: ${why}`, results };
    await tx`update offer_definitions set experiment = null, experiment_history = experiment_history || ${tx.json([entry] as never)}, updated_at = now() where code = ${d.code}`;
    await raiseAlert(tx, {
      kind: 'offer.experiment_stopped',
      severity: 'risk',
      subject: { type: 'offer_experiment', id: `${d.code as string}:${exp.key}` },
      message: `${d.code as string}: experiment ${exp.key} stopped automatically — ${why}. New offers use the base price and window.`,
      details: { experiment: exp.key, why, results },
    });
    stopped.push({ code: d.code as string, experiment: exp.key, why });
  }
  return stopped;
}
