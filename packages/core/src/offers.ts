import type { Tx } from '@arkiv/db';
import { DomainError, OFFER_RULES, PRICES, type Micros } from '@arkiv/shared';
import type { TenantContext } from './context';
import { emit } from './events';
import { assignVariantOrNull } from './flags';

/**
 * Offer Engine (standard §5, §7; plan 04 L8–L10). Deterministic and experimentable — never LLM-priced.
 * Hard rules enforced here:
 *  - The TASTE offer is issued at most once per workspace (DB unique index) and never reissued after expiry.
 *  - The window is server-side; refreshes/devices see the same expires_at.
 *  - The anchor ("regular $29") must reference a live, purchasable price (plan 04 §3, 16 CFR 233.1).
 */

export interface PriceQuote {
  kind: 'taste' | 'standalone';
  offerId: string | null;
  priceMicros: Micros;
  referencePriceMicros: Micros | null;
  expiresAt: string | null;
  status: 'active' | 'expired' | 'none';
  bonus: Record<string, unknown>;
}

async function definition(tx: Tx, code: string) {
  const [d] = await tx`select * from offer_definitions where code = ${code}`;
  return d ?? null;
}

async function assertAnchorIsLive(tx: Tx, referenceCode: string | null): Promise<Micros | null> {
  if (!referenceCode) return null;
  const ref = await definition(tx, referenceCode);
  if (!ref || !ref.active) {
    // Never show a strikethrough price we do not actually charge.
    return null;
  }
  return Number(ref.price_micros);
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
export async function issueTasteOffer(tx: Tx, ctx: TenantContext, projectId: string): Promise<PriceQuote> {
  const [existing] = await tx`select * from offers where type = 'TASTE'`;
  if (existing) return quoteFromOffer(existing);
  if (await hasPurchased(tx)) return standaloneQuote(tx);
  const def = await definition(tx, 'TASTE_19');
  if (!def || !def.active) return standaloneQuote(tx);
  const ref = await assertAnchorIsLive(tx, def.reference_code as string | null);
  const exp = def.experiment as { key: string; variants: { key: string; weight: number; windowMinutes?: number; priceMicros?: number }[] } | null;
  let window = Number(def.window_minutes ?? OFFER_RULES.TASTE_WINDOW_MINUTES);
  let price = Number(def.price_micros);
  let variant: string | null = null;
  variant = exp ? assignVariantOrNull(exp.key, ctx.workspaceId, exp.variants) : null;
  if (exp && variant) {
    const v = exp.variants.find((x) => x.key === variant)!;
    window = v.windowMinutes ?? window;
    price = v.priceMicros ?? price;
  }
  const [o] = await tx`
    insert into offers (workspace_id, definition_code, type, project_id, price_micros, reference_price_micros, starts_at,
      expires_at, bonus, variant)
    values (${ctx.workspaceId}, 'TASTE_19', 'TASTE', ${projectId}, ${price}, ${ref}, now(),
      now() + make_interval(mins => ${window}), ${tx.json(def.bonus)}, ${variant})
    on conflict do nothing
    returning *`;
  const offer = o ?? (await tx`select * from offers where type = 'TASTE'`)[0];
  if (o) {
    await emit(tx, ctx, 'OFFER_ISSUED', { type: 'offer', id: o.id as string }, {
      code: 'TASTE_19',
      priceMicros: price,
      expiresAt: o.expires_at,
      variant,
    });
  }
  return quoteFromOffer(offer!);
}

function quoteFromOffer(o: Record<string, unknown>): PriceQuote {
  const expired = o.status !== 'active' || (o.expires_at && new Date(o.expires_at as string) <= new Date());
  return {
    kind: 'taste',
    offerId: o.id as string,
    priceMicros: Number(o.price_micros),
    referencePriceMicros: o.reference_price_micros == null ? null : Number(o.reference_price_micros),
    expiresAt: o.expires_at ? new Date(o.expires_at as string).toISOString() : null,
    status: expired ? 'expired' : 'active',
    bonus: (o.bonus as Record<string, unknown>) ?? {},
  };
}

async function standaloneQuote(tx: Tx): Promise<PriceQuote> {
  const def = await definition(tx, 'STANDALONE_29');
  return {
    kind: 'standalone',
    offerId: null,
    priceMicros: def ? Number(def.price_micros) : PRICES.STANDALONE,
    referencePriceMicros: null,
    expiresAt: null,
    status: 'none',
    bonus: {},
  };
}

/** What would the customer pay to produce this project right now? */
export async function currentQuote(tx: Tx): Promise<PriceQuote> {
  const [o] = await tx`select * from offers where type = 'TASTE'`;
  if (o) {
    const q = quoteFromOffer(o);
    if (q.status === 'active' && o.status === 'active') return q;
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
