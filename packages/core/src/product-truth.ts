import type { Tx } from '@arkiv/db';
import { DomainError, type DataState } from '@arkiv/shared';
import { assertCan } from './authz';
import type { TenantContext } from './context';
import { actorString } from './context';
import { emit } from './events';

/**
 * ProductTruthService (§15–16, §33): atomic, versioned facts with provenance. Raw observations are never
 * edited; merchant corrections become DECIDED facts that supersede. Conflicting material sources are marked
 * DISPUTED and shown to the merchant (§42).
 */

export type SourceType = 'product_page' | 'json_ld' | 'shopify' | 'photo_ocr' | 'vision' | 'merchant' | 'staff' | 'import';

/** Source precedence for display (higher wins) — never used to silently hide a material conflict. */
const PRECEDENCE: Record<SourceType, number> = { merchant: 100, staff: 90, shopify: 80, json_ld: 70, import: 60, product_page: 50, photo_ocr: 40, vision: 30 };

/** Keys where disagreement between sources is material and must be surfaced. */
const MATERIAL_KEYS = new Set(['name', 'price', 'size', 'category', 'ingredients', 'shade']);

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

const normValue = (f: { valueText?: string | null; valueNumber?: number | null; valueJson?: unknown }) =>
  f.valueNumber != null ? String(f.valueNumber) : f.valueText != null ? f.valueText.trim().toLowerCase().replace(/\s+/g, ' ') : JSON.stringify(f.valueJson ?? null);

export async function recordFacts(tx: Tx, ctx: TenantContext, skuId: string, facts: FactInput[]): Promise<{ recorded: number; disputes: string[] }> {
  const disputes: string[] = [];
  let recorded = 0;
  for (const f of facts) {
    if (f.valueText == null && f.valueNumber == null && f.valueJson == null) continue;
    if (f.state === 'DECIDED' && f.sourceType !== 'merchant' && f.sourceType !== 'staff')
      throw new DomainError('INVALID', 'Only merchant or staff decisions can be DECIDED');
    const existing = await tx`select * from product_facts where sku_id = ${skuId} and normalized_key = ${f.key} and status <> 'SUPERSEDED'`;
    const same = existing.find((e) => normValue(rowToFact(e)) === normValue(f) && e.source_type === f.sourceType);
    if (same) continue;
    const [row] = await tx`
      insert into product_facts (workspace_id, sku_id, fact_type, normalized_key, value_text, value_number, value_json,
        source_type, source_id, source_url, confidence, state, created_by)
      values (${ctx.workspaceId}, ${skuId}, ${f.factType ?? f.key}, ${f.key}, ${f.valueText ?? null}, ${f.valueNumber ?? null},
        ${f.valueJson === undefined ? null : tx.json(f.valueJson as never)}, ${f.sourceType}, ${f.sourceId ?? null},
        ${f.sourceUrl ?? null}, ${f.confidence ?? 1}, ${f.state}, ${actorString(ctx)})
      returning id`;
    recorded++;
    await emit(tx, ctx, 'PRODUCT_FACT_OBSERVED', { type: 'sku', id: skuId }, { key: f.key, source: f.sourceType, state: f.state, factId: row!.id });
    // Material conflict between different non-merchant sources → DISPUTED (both kept, merchant decides).
    const conflicting = existing.filter((e) => e.state !== 'DECIDED' && normValue(rowToFact(e)) !== normValue(f));
    if (MATERIAL_KEYS.has(f.key) && conflicting.length && f.state !== 'DECIDED') {
      await tx`update product_facts set status = 'DISPUTED' where id in ${tx([row!.id as string, ...conflicting.map((c) => c.id as string)])}`;
      await emit(tx, ctx, 'PRODUCT_CONFLICT_DETECTED', { type: 'sku', id: skuId }, { key: f.key });
      disputes.push(f.key);
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
  const prior = await tx`select id, source_type from product_facts where sku_id = ${skuId} and normalized_key = ${key} and status <> 'SUPERSEDED'`;
  const [row] = await tx`
    insert into product_facts (workspace_id, sku_id, fact_type, normalized_key, value_text, value_number, value_json,
      source_type, state, merchant_confirmed, created_by, supersedes_fact_id)
    values (${ctx.workspaceId}, ${skuId}, ${key}, ${key}, ${value.text ?? null}, ${value.number ?? null},
      ${value.json === undefined ? null : tx.json(value.json as never)}, 'merchant', 'DECIDED', true, ${actorString(ctx)},
      ${(prior[0]?.id as string) ?? null})
    returning id`;
  const nonShopify = prior.filter((p) => p.source_type !== 'shopify').map((p) => p.id as string);
  if (nonShopify.length) await tx`update product_facts set status = 'SUPERSEDED', valid_to = now() where id in ${tx(nonShopify)}`;
  const shopify = prior.filter((p) => p.source_type === 'shopify').map((p) => p.id as string);
  if (shopify.length) await tx`update product_facts set status = 'DISPUTED' where id in ${tx(shopify)}`;
  if (key === 'name' && value.text) await tx`update skus set name = ${value.text} where id = ${skuId}`;
  await emit(tx, ctx, 'PRODUCT_FACT_CHANGED', { type: 'sku', id: skuId }, { key, factId: row!.id, decided: true });
  return row!.id as string;
}

/** Confirm an observed fact without changing it (becomes merchant-confirmed, still OBSERVED). */
export async function confirmFact(tx: Tx, ctx: TenantContext, factId: string) {
  if (ctx.actor.kind === 'user' || ctx.actor.kind === 'provisional') assertCan(ctx, 'sku.edit');
  const [f] = await tx`update product_facts set merchant_confirmed = true where id = ${factId} returning sku_id, normalized_key`;
  if (!f) throw new DomainError('NOT_FOUND', 'Fact not found');
  await emit(tx, ctx, 'PRODUCT_FACT_CHANGED', { type: 'sku', id: f.sku_id as string }, { key: f.normalized_key, confirmed: true });
}

/**
 * Current view per key: DECIDED wins; otherwise highest-precedence ACTIVE; DISPUTED keys are returned with
 * all candidates and `disputed: true` so the UI can ask the merchant.
 */
export async function currentFacts(tx: Tx, skuId: string) {
  const rows = (await tx`select * from product_facts where sku_id = ${skuId} and status <> 'SUPERSEDED' order by observed_at`).map(rowToFact);
  const byKey = new Map<string, Fact[]>();
  for (const f of rows) byKey.set(f.key, [...(byKey.get(f.key) ?? []), f]);
  const out: Record<string, { value: Fact; candidates: Fact[]; disputed: boolean }> = {};
  for (const [key, facts] of byKey) {
    const decided = facts.filter((f) => f.state === 'DECIDED').at(-1);
    const best = decided ?? [...facts].sort((a, b) => PRECEDENCE[b.sourceType] - PRECEDENCE[a.sourceType] || b.confidence - a.confidence)[0]!;
    out[key] = { value: best, candidates: facts, disputed: !decided && facts.some((f) => f.status === 'DISPUTED') };
  }
  return out;
}

export const factText = (facts: Awaited<ReturnType<typeof currentFacts>>, key: string) =>
  facts[key]?.value.valueText ?? (facts[key]?.value.valueNumber != null ? String(facts[key]!.value.valueNumber) : null);
