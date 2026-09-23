import type { Tx } from '@arkiv/db';
import { DomainError, OFFER_RULES, PRICES, type Micros, type OfferType } from '@arkiv/shared';
import type { TenantContext } from './context';
import { emit } from './events';
import { assignVariant } from './flags';

/**
 * Offer Engine (standard §5, §7; plan 04 L8–L10; plan 05 §6). Deterministic and experimentable — never
 * LLM-priced. Offer definitions are versioned: staff never edit a live price, they add a new version, and the
 * engine resolves the latest active version of a type whose eligibility rule matches the workspace.
 * Hard rules enforced here:
 *  - The TASTE offer is issued at most once per workspace (DB unique index) and never reissued after expiry.
 *  - The window is server-side; refreshes/devices see the same expires_at.
 *  - The anchor ("regular $29") must be the price we actually charge today (plan 04 §3, 16 CFR 233.1).
 */

export interface PriceQuote {
  kind: 'taste' | 'standalone';
  offerId: string | null;
  priceMicros: Micros;
  referencePriceMicros: Micros | null;
  expiresAt: string | null;
  status: 'active' | 'expired' | 'none';
  bonus: Record<string, unknown>;
  /** The offer definition (version) this price comes from. */
  definitionCode?: string | null;
  /** Stripe Price to charge, when the definition has one and the quoted price is the definition's price. */
  stripePriceId?: string | null;
}

// ───────────── Eligibility rules (JSON logic) ─────────────

/** Facts an eligibility rule can read. Keys match case- and separator-insensitively (never_purchased = neverPurchased). */
export interface OfferFacts {
  never_purchased: boolean;
  new_workspace: boolean;
  workspace_age_days: number;
  state: string;
  plan: string | null;
  source_page: string | null;
}

const OPS = new Set(['and', 'or', '!', '!!', '==', '===', '!=', '!==', '<', '<=', '>', '>=', 'in', 'var', 'if']);
const norm = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, '');

function lookup(facts: Record<string, unknown>, name: unknown): unknown {
  const want = norm(String(name));
  for (const [k, v] of Object.entries(facts)) if (norm(k) === want) return v;
  return undefined;
}

/**
 * A small JSON-logic evaluator (and/or/!/!!, comparisons, in, var, if). A plain object whose keys aren't
 * operators is shorthand for "every fact equals its value" (an array value means "fact is one of these"):
 * `{"never_purchased": true, "source_page": ["texture", "fatigue"]}`. `{}` matches everyone.
 */
export function evalEligibility(rule: unknown, facts: Record<string, unknown>): boolean {
  return !!evaluate(rule, facts);
}

function evaluate(rule: unknown, facts: Record<string, unknown>): unknown {
  if (Array.isArray(rule)) return rule.map((r) => evaluate(r, facts));
  if (rule === null || typeof rule !== 'object') return rule;
  const entries = Object.entries(rule as Record<string, unknown>);
  if (!entries.length) return true;
  if (entries.length === 1 && OPS.has(entries[0]![0])) {
    const [op, raw] = entries[0]!;
    const args = Array.isArray(raw) ? raw : [raw];
    const v = (i: number) => evaluate(args[i], facts);
    switch (op) {
      case 'var':
        return lookup(facts, args[0]);
      case 'and':
        return args.every((a) => !!evaluate(a, facts));
      case 'or':
        return args.some((a) => !!evaluate(a, facts));
      case '!':
        return !v(0);
      case '!!':
        return !!v(0);
      case '==':
      case '===':
        return v(0) === v(1);
      case '!=':
      case '!==':
        return v(0) !== v(1);
      case '<':
        return Number(v(0)) < Number(v(1));
      case '<=':
        return Number(v(0)) <= Number(v(1));
      case '>':
        return Number(v(0)) > Number(v(1));
      case '>=':
        return Number(v(0)) >= Number(v(1));
      case 'in': {
        const hay = v(1);
        return Array.isArray(hay) ? hay.includes(v(0)) : typeof hay === 'string' && hay.includes(String(v(0)));
      }
      case 'if':
        return v(0) ? v(1) : v(2);
    }
  }
  // Shorthand: all facts match.
  return entries.every(([k, want]) => {
    const got = lookup(facts, k);
    return Array.isArray(want) ? want.includes(got) : got === want;
  });
}

/** Reject rules the engine can't evaluate (unknown operators, unknown facts) when staff save a definition. */
export function validateEligibility(rule: unknown): void {
  const known = new Set(['neverpurchased', 'newworkspace', 'workspaceagedays', 'state', 'plan', 'sourcepage']);
  const walk = (r: unknown): void => {
    if (Array.isArray(r)) return r.forEach(walk);
    if (r === null || typeof r !== 'object') return;
    const entries = Object.entries(r as Record<string, unknown>);
    if (entries.length === 1 && OPS.has(entries[0]![0])) {
      const [op, raw] = entries[0]!;
      if (op === 'var' && !known.has(norm(String(Array.isArray(raw) ? raw[0] : raw)))) throw new DomainError('INVALID', `Unknown fact in eligibility: ${String(raw)}`);
      return walk(raw);
    }
    for (const [k] of entries) {
      if (!known.has(norm(k))) throw new DomainError('INVALID', `Unknown eligibility key "${k}". Use JSON logic or facts: never_purchased, new_workspace, workspace_age_days, state, plan, source_page.`);
    }
  };
  walk(rule);
}

/** Workspaces younger than this count as "new" for eligibility rules. */
const NEW_WORKSPACE_DAYS = 30;

export async function offerFacts(tx: Tx, overrides: Partial<OfferFacts> = {}): Promise<OfferFacts> {
  const [w] = await tx`select state, plan_code, created_at from workspaces limit 1`;
  const ageDays = w ? (Date.now() - new Date(w.created_at as string).getTime()) / 86400_000 : 0;
  return {
    never_purchased: !(await hasPurchased(tx)),
    new_workspace: ageDays <= NEW_WORKSPACE_DAYS,
    workspace_age_days: Math.floor(ageDays),
    state: (w?.state as string) ?? 'PROVISIONAL',
    plan: (w?.plan_code as string) ?? null,
    source_page: null,
    ...overrides,
  };
}

// ───────────── Definitions ─────────────

async function definition(tx: Tx, code: string) {
  const [d] = await tx`select * from offer_definitions where code = ${code}`;
  return d ?? null;
}

/** The definition the engine uses for a type: the latest active version whose eligibility matches. */
export async function resolveDefinition(tx: Tx, type: OfferType, facts: OfferFacts): Promise<Record<string, unknown> | null> {
  const defs = await tx`select * from offer_definitions where type = ${type} and active order by version desc, created_at desc`;
  return defs.find((d) => evalEligibility(d.eligibility, facts as unknown as Record<string, unknown>)) ?? null;
}

/**
 * Honest anchoring: a strike-through reference is shown only if it is the price the engine would actually
 * charge for its type right now (a superseded or paused version is not).
 */
async function liveAnchor(tx: Tx, referenceCode: string | null, facts: OfferFacts): Promise<Micros | null> {
  if (!referenceCode) return null;
  const ref = await definition(tx, referenceCode);
  if (!ref || !ref.active) return null;
  const current = await resolveDefinition(tx, ref.type as OfferType, facts);
  return current?.code === ref.code ? Number(ref.price_micros) : null;
}

/** Has this workspace ever paid for anything? Taste is for first production only. */
async function hasPurchased(tx: Tx): Promise<boolean> {
  const [p] = await tx`select 1 from purchases where status in ('paid','refunded') limit 1`;
  const [s] = await tx`select 1 from subscriptions limit 1`;
  return !!p || !!s;
}

/**
 * Issue the Taste offer when the qualifying storyboard is ready (standard §5: the clock starts at
 * STORYBOARD_READY, never earlier). Idempotent: returns the existing offer if one was ever issued.
 */
export async function issueTasteOffer(tx: Tx, ctx: TenantContext, projectId: string, overrides: Partial<OfferFacts> = {}): Promise<PriceQuote> {
  const [existing] = await tx`select * from offers where type = 'TASTE'`;
  if (existing) return quoteFromOffer(tx, existing);
  const facts = await offerFacts(tx, overrides);
  if (!facts.never_purchased) return standaloneQuote(tx, facts); // Taste is an intro price, whatever a rule says.
  const def = await resolveDefinition(tx, 'TASTE', facts);
  if (!def) return standaloneQuote(tx, facts);
  const code = def.code as string;
  const ref = await liveAnchor(tx, def.reference_code as string | null, facts);
  const exp = def.experiment as { key: string; variants: { key: string; weight: number; windowMinutes?: number; priceMicros?: number }[] } | null;
  let window = Number(def.window_minutes ?? OFFER_RULES.TASTE_WINDOW_MINUTES);
  let price = Number(def.price_micros);
  let variant: string | null = null;
  if (exp?.variants?.length) {
    variant = assignVariant(exp.key, ctx.workspaceId, exp.variants);
    const v = exp.variants.find((x) => x.key === variant)!;
    window = v.windowMinutes ?? window;
    price = v.priceMicros ?? price;
  }
  const [o] = await tx`
    insert into offers (workspace_id, definition_code, type, project_id, price_micros, reference_price_micros, starts_at,
      expires_at, bonus, variant)
    values (${ctx.workspaceId}, ${code}, 'TASTE', ${projectId}, ${price}, ${ref}, now(),
      now() + make_interval(mins => ${window}), ${tx.json(def.bonus as never)}, ${variant})
    on conflict do nothing
    returning *`;
  const offer = o ?? (await tx`select * from offers where type = 'TASTE'`)[0];
  if (o) {
    await emit(tx, ctx, 'OFFER_ISSUED', { type: 'offer', id: o.id as string }, {
      code,
      version: Number(def.version),
      priceMicros: price,
      expiresAt: o.expires_at,
      variant,
    });
  }
  return quoteFromOffer(tx, offer!);
}

async function quoteFromOffer(tx: Tx, o: Record<string, unknown>): Promise<PriceQuote> {
  const expired = o.status !== 'active' || (o.expires_at && new Date(o.expires_at as string) <= new Date());
  const def = await definition(tx, o.definition_code as string);
  return {
    kind: 'taste',
    offerId: o.id as string,
    priceMicros: Number(o.price_micros),
    referencePriceMicros: o.reference_price_micros == null ? null : Number(o.reference_price_micros),
    expiresAt: o.expires_at ? new Date(o.expires_at as string).toISOString() : null,
    status: expired ? 'expired' : 'active',
    bonus: (o.bonus as Record<string, unknown>) ?? {},
    definitionCode: (o.definition_code as string) ?? null,
    stripePriceId: def?.stripe_price_id && Number(def.price_micros) === Number(o.price_micros) ? (def.stripe_price_id as string) : null,
  };
}

function quoteFromDefinition(def: Record<string, unknown>): PriceQuote {
  return {
    kind: 'standalone',
    offerId: null,
    priceMicros: Number(def.price_micros),
    referencePriceMicros: null,
    expiresAt: null,
    status: 'none',
    bonus: (def.bonus as Record<string, unknown>) ?? {},
    definitionCode: def.code as string,
    stripePriceId: (def.stripe_price_id as string) ?? null,
  };
}

async function standaloneQuote(tx: Tx, facts?: OfferFacts): Promise<PriceQuote> {
  const def = await resolveDefinition(tx, 'STANDALONE', facts ?? (await offerFacts(tx)));
  if (def) return quoteFromDefinition(def);
  return { kind: 'standalone', offerId: null, priceMicros: PRICES.STANDALONE, referencePriceMicros: null, expiresAt: null, status: 'none', bonus: {}, definitionCode: null, stripePriceId: null };
}

/**
 * What would the customer pay to produce this project right now? After the Taste offer is over, its
 * definition's next-eligible-offer policy (`{"next": "<code>"}`) names what follows, if that version is
 * active; otherwise the current standalone price applies.
 */
export async function currentQuote(tx: Tx): Promise<PriceQuote> {
  const [o] = await tx`select * from offers where type = 'TASTE'`;
  if (o) {
    const q = await quoteFromOffer(tx, o);
    if (q.status === 'active' && o.status === 'active') return q;
    const def = await definition(tx, o.definition_code as string);
    const next = (def?.next_offer_policy as { next?: string } | null)?.next;
    if (next) {
      const n = await definition(tx, next);
      if (n?.active && n.type === 'STANDALONE') return quoteFromDefinition(n);
    }
  }
  return standaloneQuote(tx);
}

/** Mark the Taste offer redeemed once payment is confirmed. */
export async function redeemOffer(tx: Tx, ctx: TenantContext, offerId: string) {
  const [o] = await tx`update offers set status = 'redeemed' where id = ${offerId} and status in ('active','expired') returning id`;
  if (o) await emit(tx, ctx, 'OFFER_REDEEMED', { type: 'offer', id: offerId }, {});
}

/** Sweep: flip expired offers (display is already time-based; this keeps the table truthful). */
export async function expireOffers(tx: Tx): Promise<number> {
  const r = await tx`update offers set status = 'expired' where status = 'active' and expires_at is not null
                     and expires_at <= now() returning id, workspace_id`;
  return r.count;
}

/** Stripe Checkout session expiry (plan 02 B5): Stripe's minimum is 30 min; the offer itself is never extended. */
export function checkoutSessionExpiry(quote: PriceQuote, now = new Date()): Date {
  const min = new Date(now.getTime() + OFFER_RULES.STRIPE_MIN_SESSION_MINUTES * 60_000 + 30_000);
  if (!quote.expiresAt) return new Date(now.getTime() + 24 * 3600_000 - 60_000);
  const exp = new Date(quote.expiresAt);
  return exp > min ? exp : min;
}

export function assertQuoteMatches(quote: PriceQuote, expectedMicros: Micros) {
  if (quote.priceMicros !== expectedMicros)
    throw new DomainError('CONFLICT', 'The price changed. Please review the updated price.', { priceMicros: quote.priceMicros });
}
