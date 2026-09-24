import type { Tx } from '@arkiv/db';
import { DomainError, type DataState } from '@arkiv/shared';
import { assertCan } from './authz';
import type { TenantContext } from './context';
import { actorString } from './context';
import { emit } from './events';
import { onMaterialProductChange } from './experiment-state';

/**
 * ProductTruthService (§15–16, §33): atomic, versioned facts with provenance. Raw observations are never
 * edited; merchant corrections become DECIDED facts that supersede. Conflicting material sources are marked
 * DISPUTED and shown to the merchant (§42).
 */

export type SourceType = 'product_page' | 'json_ld' | 'shopify' | 'photo_ocr' | 'vision' | 'merchant' | 'staff' | 'import';

/** Source precedence for display (higher wins) — never used to silently hide a material conflict. */
const PRECEDENCE: Record<SourceType, number> = { merchant: 100, staff: 90, shopify: 80, json_ld: 70, import: 60, product_page: 50, photo_ocr: 40, vision: 30 };

/** Keys where disagreement between sources is material and must be surfaced. */
const MATERIAL_KEYS = new Set(['name', 'price', 'size', 'category', 'ingredients', 'key_ingredients', 'shade']);

export interface FactInput {
  key: string;
  factType?: string;
  valueText?: string | null;
  valueNumber?: number | null;
  valueJson?: unknown;
  sourceType: SourceType;
  sourceId?: string | null;
  sourceUrl?: string | null;
  confidence?: number;
  state: DataState;
}

export interface Fact {
  id: string;
  key: string;
  valueText: string | null;
  valueNumber: number | null;
  valueJson: unknown;
  sourceType: SourceType;
  sourceUrl: string | null;
  confidence: number;
  state: DataState;
  status: 'ACTIVE' | 'SUPERSEDED' | 'DISPUTED';
  observedAt: string;
  merchantConfirmed: boolean;
}

const rowToFact = (r: Record<string, unknown>): Fact => ({
  id: r.id as string,
  key: r.normalized_key as string,
  valueText: (r.value_text as string) ?? null,
  valueNumber: r.value_number == null ? null : Number(r.value_number),
  valueJson: r.value_json ?? null,
  sourceType: r.source_type as SourceType,
  sourceUrl: (r.source_url as string) ?? null,
  confidence: Number(r.confidence),
  state: r.state as DataState,
  status: r.status as Fact['status'],
  observedAt: new Date(r.observed_at as string).toISOString(),
  merchantConfirmed: !!r.merchant_confirmed,
});

/** The value an event records for a fact (§36: events can rebuild product truth). */
const factValue = (f: { valueText?: string | null; valueNumber?: number | null; valueJson?: unknown }) => ({
  text: f.valueText ?? null,
  number: f.valueNumber ?? null,
  json: f.valueJson === undefined ? null : f.valueJson,
});

const normValue = (f: { valueText?: string | null; valueNumber?: number | null; valueJson?: unknown }) =>
  f.valueNumber != null ? String(f.valueNumber) : f.valueText != null ? f.valueText.trim().toLowerCase().replace(/\s+/g, ' ') : JSON.stringify(f.valueJson ?? null);

type Valued = { valueText?: string | null; valueNumber?: number | null; valueJson?: unknown };

/** Millilitres or grams per unit, for comparing pack sizes written differently ("30 ml" = "1 fl oz"). */
const SIZE_UNITS: Record<string, { dim: 'vol' | 'mass'; per: number }> = {
  ml: { dim: 'vol', per: 1 }, mls: { dim: 'vol', per: 1 }, millilitre: { dim: 'vol', per: 1 }, milliliter: { dim: 'vol', per: 1 },
  millilitres: { dim: 'vol', per: 1 }, milliliters: { dim: 'vol', per: 1 }, cl: { dim: 'vol', per: 10 }, l: { dim: 'vol', per: 1000 },
  floz: { dim: 'vol', per: 29.5735 }, g: { dim: 'mass', per: 1 }, gr: { dim: 'mass', per: 1 }, gram: { dim: 'mass', per: 1 },
  grams: { dim: 'mass', per: 1 }, kg: { dim: 'mass', per: 1000 }, mg: { dim: 'mass', per: 0.001 }, oz: { dim: 'mass', per: 28.3495 },
};

/** Every quantity a size text states ("30 ml / 1.0 fl. oz" → two readings of one pack), in base units. */
export function parseSizes(text: string): { dim: 'vol' | 'mass'; amount: number }[] {
  const out: { dim: 'vol' | 'mass'; amount: number }[] = [];
  const t = text.toLowerCase().replace(/fl\.?\s*oz\.?|fluid\s+ounces?/g, 'floz').replace(/(\d),(\d)/g, '$1.$2');
  for (const m of t.matchAll(/(\d+(?:\.\d+)?)\s*(ml|mls|millilit(?:re|er)s?|cl|l|floz|g|gr|grams?|kg|mg|oz)\b/g)) {
    const u = SIZE_UNITS[m[2]!];
    if (u) out.push({ dim: u.dim, amount: Number(m[1]) * u.per });
  }
  return out;
}

const nameTokens = (s: string) =>
  new Set(s.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').split(/[^a-z0-9%.]+/).map((w) => w.replace(/\.+$/, '')).filter(Boolean));

/**
 * Do two readings of a fact state the same thing? Exact after normalising, and for pack sizes the same quantity in
 * any unit (5% tolerance: "30 ml" vs "1 fl oz"), for names the same words give or take a brand prefix. Formatting
 * differences are not material discrepancies (§42); anything else is.
 */
export function sameValue(key: string, a: Valued, b: Valued): boolean {
  if (normValue(a) === normValue(b)) return true;
  if (a.valueNumber != null && b.valueNumber != null) return Math.abs(Number(a.valueNumber) - Number(b.valueNumber)) < 0.005;
  if (a.valueText == null || b.valueText == null) return false;
  if (key === 'size') {
    const x = parseSizes(a.valueText);
    const y = parseSizes(b.valueText);
    if (!x.length || !y.length) return false;
    return x.some((p) => y.some((q) => p.dim === q.dim && Math.abs(p.amount - q.amount) <= 0.05 * Math.max(p.amount, q.amount)));
  }
  if (key === 'name') {
    const x = nameTokens(a.valueText);
    const y = nameTokens(b.valueText);
    if (!x.size || !y.size) return false;
    const [small, big] = x.size <= y.size ? [x, y] : [y, x];
    const shared = [...small].filter((w) => big.has(w)).length;
    return shared === small.size || shared / new Set([...x, ...y]).size >= 0.75;
  }
  return false;
}

/**
 * Sources that are one source whatever record id carried the value: the Shopify product (any variant id), and the
 * product's own label as read by each analysis run (the id there is the run, kept for provenance).
 */
const WHOLE_SOURCES: ReadonlySet<SourceType> = new Set(['shopify', 'photo_ocr', 'vision']);

/**
 * Two observations come from the same source when they share a source type and, where both name one, the same
 * source record — so a store re-sync or a re-read label replaces that source's earlier reading.
 */
const sameSource = (e: Record<string, unknown>, f: FactInput) =>
  e.source_type === f.sourceType && (WHOLE_SOURCES.has(f.sourceType) || e.source_id == null || f.sourceId == null || e.source_id === f.sourceId);

/** Serialises every write to one fact key of one SKU (concurrent syncs, analyses and merchant decisions). */
const lockKey = (tx: Tx, skuId: string, key: string) => tx`select pg_advisory_xact_lock(hashtext(${`product_fact:${skuId}:${key}`}))`;

/**
 * Record source observations. A newer reading from the same source supersedes its earlier one (valid_to set, the
 * new row points at it, PRODUCT_FACT_CHANGED). Different sources that disagree on a material key are both kept and
 * marked DISPUTED for the merchant (§42) — and an observation that disagrees with the merchant's own decision is
 * marked too, so a later store change is never hidden behind the decision (§28).
 */
export async function recordFacts(tx: Tx, ctx: TenantContext, skuId: string, facts: FactInput[]): Promise<{ recorded: number; disputes: string[] }> {
  const disputes: string[] = [];
  let recorded = 0;
  for (const f of facts) {
    if (f.valueText == null && f.valueNumber == null && f.valueJson == null) continue;
    if (f.state === 'DECIDED' && f.sourceType !== 'merchant' && f.sourceType !== 'staff')
      throw new DomainError('INVALID', 'Only merchant or staff decisions can be DECIDED');
    await lockKey(tx, skuId, f.key);
    const existing = await tx`select * from product_facts where sku_id = ${skuId} and normalized_key = ${f.key} and status <> 'SUPERSEDED' order by observed_at`;
    const same = existing.find((e) => normValue(rowToFact(e)) === normValue(f) && e.source_type === f.sourceType);
    if (same) continue;
    // The same source's earlier reading is replaced, not disputed (§16 valid_from/valid_to, supersedes_fact_id).
    const replaced = f.state === 'DECIDED' ? [] : existing.filter((e) => e.state !== 'DECIDED' && sameSource(e, f));
    const [row] = await tx`
      insert into product_facts (workspace_id, sku_id, fact_type, normalized_key, value_text, value_number, value_json,
        source_type, source_id, source_url, confidence, state, created_by, supersedes_fact_id)
      values (${ctx.workspaceId}, ${skuId}, ${f.factType ?? f.key}, ${f.key}, ${f.valueText ?? null}, ${f.valueNumber ?? null},
        ${f.valueJson === undefined ? null : tx.json(f.valueJson as never)}, ${f.sourceType}, ${f.sourceId ?? null},
        ${f.sourceUrl ?? null}, ${f.confidence ?? 1}, ${f.state}, ${actorString(ctx)}, ${(replaced.at(-1)?.id as string) ?? null})
      returning id`;
    recorded++;
    const factId = row!.id as string;
    await emit(tx, ctx, 'PRODUCT_FACT_OBSERVED', { type: 'sku', id: skuId }, { key: f.key, source: f.sourceType, state: f.state, factId, value: factValue(f) }, { factId });
    if (replaced.length) {
      await tx`update product_facts set status = 'SUPERSEDED', valid_to = now() where id in ${tx(replaced.map((r) => r.id as string))}`;
      await emit(tx, ctx, 'PRODUCT_FACT_CHANGED', { type: 'sku', id: skuId }, { key: f.key, factId, source: f.sourceType, value: factValue(f), supersedes: replaced.map((r) => r.id) }, { factId });      // A new price is a context change for tests and learnings on this SKU (§21, §45).
      await onMaterialProductChange(tx, ctx, skuId, f.key);
    }
    if (!MATERIAL_KEYS.has(f.key) || f.state !== 'OBSERVED') continue;
    const rest = existing.filter((e) => !replaced.includes(e));
    // Material conflict between different sources' observations → DISPUTED (both kept, merchant decides).
    // Interpretations (INFERRED) never dispute a source; they are shown as the system's reading.
    const conflicting = rest.filter((e) => e.state === 'OBSERVED' && !sameValue(f.key, rowToFact(e), f));
    const decided = rest.filter((e) => e.state === 'DECIDED').at(-1);
    const vsMerchant = !!decided && !sameValue(f.key, rowToFact(decided), f);
    if (conflicting.length || vsMerchant) {
      await tx`update product_facts set status = 'DISPUTED' where id in ${tx([factId, ...conflicting.map((c) => c.id as string)])} and status <> 'DISPUTED'`;
      await emit(tx, ctx, 'PRODUCT_CONFLICT_DETECTED', { type: 'sku', id: skuId }, { key: f.key, factIds: [factId, ...conflicting.map((c) => c.id)], ...(vsMerchant ? { vs: 'merchant', decidedFactId: decided!.id } : {}) }, { factId });
      disputes.push(f.key);
    } else if (!decided) {
      // The replaced reading was what disagreed: once every remaining observation agrees, the dispute is over.
      const stale = rest.filter((e) => e.status === 'DISPUTED').map((e) => e.id as string);
      if (stale.length) await tx`update product_facts set status = 'ACTIVE' where id in ${tx(stale)}`;
    }
  }
  return { recorded, disputes };
}

/**
 * Merchant correction: a new DECIDED fact supersedes (but never edits) prior facts for the key.
 * When the prior value came from Shopify, the conflict stays visible rather than breaking source truth (§28).
 */
export async function decideFact(tx: Tx, ctx: TenantContext, skuId: string, key: string, value: { text?: string | null; number?: number | null; json?: unknown }) {
  if (ctx.actor.kind === 'user' || ctx.actor.kind === 'provisional') assertCan(ctx, 'sku.edit');
  await lockKey(tx, skuId, key);
  const prior = await tx`select id, source_type, state, value_text, value_number from product_facts where sku_id = ${skuId} and normalized_key = ${key} and status <> 'SUPERSEDED' order by observed_at desc`;
  const [row] = await tx`
    insert into product_facts (workspace_id, sku_id, fact_type, normalized_key, value_text, value_number, value_json,
      source_type, state, merchant_confirmed, created_by, supersedes_fact_id)
    values (${ctx.workspaceId}, ${skuId}, ${key}, ${key}, ${value.text ?? null}, ${value.number ?? null},
      ${value.json === undefined ? null : tx.json(value.json as never)}, 'merchant', 'DECIDED', true, ${actorString(ctx)},
      ${((prior.find((p) => p.state === 'DECIDED') ?? prior[0])?.id as string) ?? null})
    returning id`;
  const nonShopify = prior.filter((p) => p.source_type !== 'shopify').map((p) => p.id as string);
  if (nonShopify.length) await tx`update product_facts set status = 'SUPERSEDED', valid_to = now() where id in ${tx(nonShopify)}`;
  const shopify = prior.filter((p) => p.source_type === 'shopify').map((p) => p.id as string);
  if (shopify.length) await tx`update product_facts set status = 'DISPUTED' where id in ${tx(shopify)}`;
  if (key === 'name' && value.text) await tx`update skus set name = ${value.text} where id = ${skuId}`;
  await emit(tx, ctx, 'PRODUCT_FACT_CHANGED', { type: 'sku', id: skuId }, {
    key,
    factId: row!.id,
    decided: true,
    value: factValue({ valueText: value.text, valueNumber: value.number, valueJson: value.json }),
    supersedes: nonShopify,
    disputes: shopify,
  }, { factId: row!.id as string });
  const current = prior.find((p) => p.state === 'DECIDED') ?? prior[0];
  if (current && String(current.value_number != null ? Number(current.value_number) : (current.value_text ?? '')) !== String(value.number ?? value.text ?? '')) await onMaterialProductChange(tx, ctx, skuId, key);
  return row!.id as string;
}

/**
 * "Use the store's value": the merchant accepts a source observation that disagrees with their earlier decision.
 * The decision is superseded (never edited) and the observation becomes the current truth again.
 */
export async function acceptSourceFact(tx: Tx, ctx: TenantContext, skuId: string, factId: string) {
  if (ctx.actor.kind === 'user' || ctx.actor.kind === 'provisional') assertCan(ctx, 'sku.edit');
  const [f] = await tx`select normalized_key from product_facts where id = ${factId} and sku_id = ${skuId}`;
  if (!f) throw new DomainError('NOT_FOUND', 'Fact not found');
  const key = f.normalized_key as string;
  await lockKey(tx, skuId, key);
  const [cur] = await tx`select state, status, source_type, value_text, value_number, value_json from product_facts where id = ${factId}`;
  if (cur!.state !== 'OBSERVED' || cur!.status === 'SUPERSEDED') throw new DomainError('CONFLICT', 'That value has changed since — reload to see the latest.');
  const decided = await tx`select id from product_facts where sku_id = ${skuId} and normalized_key = ${key} and state = 'DECIDED' and status <> 'SUPERSEDED'`;
  if (decided.length) await tx`update product_facts set status = 'SUPERSEDED', valid_to = now() where id in ${tx(decided.map((d) => d.id as string))}`;
  if (cur!.status === 'DISPUTED') await tx`update product_facts set status = 'ACTIVE' where id = ${factId}`;
  if (key === 'name' && cur!.value_text) await tx`update skus set name = ${cur!.value_text as string} where id = ${skuId}`;
  await emit(tx, ctx, 'PRODUCT_FACT_CHANGED', { type: 'sku', id: skuId }, {
    key,
    factId,
    acceptedSource: cur!.source_type,
    value: factValue({ valueText: cur!.value_text as string | null, valueNumber: cur!.value_number == null ? null : Number(cur!.value_number), valueJson: cur!.value_json }),
    supersedes: decided.map((d) => d.id),
  }, { factId });
  if (decided.length) await onMaterialProductChange(tx, ctx, skuId, key);
}

/** Confirm an observed fact without changing it (becomes merchant-confirmed, still OBSERVED). */
export async function confirmFact(tx: Tx, ctx: TenantContext, factId: string) {
  if (ctx.actor.kind === 'user' || ctx.actor.kind === 'provisional') assertCan(ctx, 'sku.edit');
  const [f] = await tx`update product_facts set merchant_confirmed = true where id = ${factId} returning sku_id, normalized_key, value_text, value_number, value_json`;
  if (!f) throw new DomainError('NOT_FOUND', 'Fact not found');
  await emit(tx, ctx, 'PRODUCT_FACT_CHANGED', { type: 'sku', id: f.sku_id as string }, {
    key: f.normalized_key,
    factId,
    confirmed: true,
    value: factValue({ valueText: f.value_text as string | null, valueNumber: f.value_number == null ? null : Number(f.value_number), valueJson: f.value_json }),
  }, { factId });
}

/**
 * The merchant confirms what we observed (§13 "show what was observed versus what needs confirmation", §16
 * merchant_confirmed): the P4 "Looks right" confirms the facts shown. Only live facts of this SKU are confirmed
 * (anything else in the list is ignored); already-confirmed ones are left alone. Returns the facts confirmed now.
 */
export async function confirmFacts(tx: Tx, ctx: TenantContext, skuId: string, factIds: readonly string[]): Promise<string[]> {
  assertCan(ctx, 'sku.edit');
  if (!factIds.length) return [];
  const rows = await tx`select id from product_facts where sku_id = ${skuId} and id = any(${[...new Set(factIds)]}::uuid[])
                        and status <> 'SUPERSEDED' and not merchant_confirmed order by observed_at`;
  for (const r of rows) await confirmFact(tx, ctx, r.id as string);
  return rows.map((r) => r.id as string);
}

/** A source reading that disagrees with the merchant's decision (§28, §42: never hidden behind the decision). */
export interface SourceConflict {
  fact: Fact;
  /** Observed after the decision: the source changed since the merchant decided (ask: keep yours or use this). */
  newer: boolean;
}

/**
 * Current view per key: DECIDED wins; otherwise highest-precedence ACTIVE (newest on a tie); DISPUTED keys are
 * returned with all candidates and `disputed: true` so the UI can ask the merchant. When a decision exists, a
 * source observation that still disagrees with it on a material key is returned as `sourceConflict`.
 */
export async function currentFacts(tx: Tx, skuId: string) {
  const rows = (await tx`select * from product_facts where sku_id = ${skuId} and status <> 'SUPERSEDED' order by observed_at`).map(rowToFact);
  const byKey = new Map<string, Fact[]>();
  for (const f of rows) byKey.set(f.key, [...(byKey.get(f.key) ?? []), f]);
  const out: Record<string, { value: Fact; candidates: Fact[]; disputed: boolean; sourceConflict: SourceConflict | null }> = {};
  for (const [key, facts] of byKey) {
    const decided = facts.filter((f) => f.state === 'DECIDED').at(-1);
    const best =
      decided ?? [...facts].sort((a, b) => PRECEDENCE[b.sourceType] - PRECEDENCE[a.sourceType] || b.confidence - a.confidence || b.observedAt.localeCompare(a.observedAt))[0]!;
    let sourceConflict: SourceConflict | null = null;
    if (decided && MATERIAL_KEYS.has(key)) {
      const differing = facts
        .filter((f) => f.state === 'OBSERVED' && !sameValue(key, f, decided))
        .sort((a, b) => b.observedAt.localeCompare(a.observedAt) || PRECEDENCE[b.sourceType] - PRECEDENCE[a.sourceType]);
      if (differing[0]) sourceConflict = { fact: differing[0], newer: differing[0].observedAt > decided.observedAt };
    }
    out[key] = { value: best, candidates: facts, disputed: !decided && facts.some((f) => f.status === 'DISPUTED'), sourceConflict };
  }
  return out;
}

export const factText = (facts: Awaited<ReturnType<typeof currentFacts>>, key: string) =>
  facts[key]?.value.valueText ?? (facts[key]?.value.valueNumber != null ? String(facts[key]!.value.valueNumber) : null);
