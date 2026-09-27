import type { Tx } from '@arkiv/db';
import type { LineMapping } from './compliance';
import { currentFacts } from './product-truth';
import type { CheckResult } from './qa';

/**
 * Launch Gate 2 (standard §50): "every final factual statement can be traced to a ProductFact/Claim source or
 * explicit merchant decision". Each line an ad says or shows (spoken lines, overlays, hook, CTA) is mapped to what
 * backs it: an approved Claim ID (from the claims check), the ProductFact(s) its facts come from — a size, a
 * price, a percentage, an ingredient — with whether the merchant decided that fact, or nothing because it states
 * no fact ('descriptive'). A line that states a fact nothing backs is a hard claims failure: the ad stops for the
 * merchant to change the line or confirm the fact.
 */

export type StatementSource = { claimId: string } | { factId: string; key: string; merchantDecision: boolean };

export interface StatementEntry {
  text: string;
  /** The factual parts found in the line ("30 ml", "$24", "niacinamide"). */
  facts: string[];
  sources: StatementSource[];
  status: 'claim' | 'sourced' | 'descriptive' | 'unsourced';
  /** Factual parts nothing backs. */
  unsourced: string[];
}

export interface FactForStatements {
  id: string;
  key: string;
  valueText: string | null;
  valueNumber: number | null;
  merchantDecision: boolean;
}

/** Active ingredients and INCI names skincare lines commonly state (a named ingredient is a factual statement). */
const INGREDIENTS = [
  'niacinamide', 'hyaluronic acid', 'sodium hyaluronate', 'retinol', 'retinal', 'retinoid', 'bakuchiol', 'vitamin c', 'ascorbic acid', 'vitamin e', 'tocopherol',
  'salicylic acid', 'glycolic acid', 'lactic acid', 'mandelic acid', 'azelaic acid', 'bha', 'peptides?', 'ceramides?', 'squalane', 'panthenol',
  'centella', 'cica', 'snail mucin', 'zinc', 'caffeine', 'collagen', 'allantoin', 'urea', 'glycerin', 'shea butter', 'jojoba oil', 'rosehip oil', 'tranexamic acid',
  'arbutin', 'kojic acid', 'benzoyl peroxide', 'spf',
];
const INGREDIENT_RE = new RegExp(`\\b(${INGREDIENTS.join('|')})\\b`, 'gi');
/** A quantity with a unit (30 ml, 1.7 fl oz, 50g, 10%). */
const QUANTITY_RE = /(\d+(?:[.,]\d+)?)\s*(fl\.?\s*oz|ml|g|oz|%|percent)\b|(\d+(?:[.,]\d+)?)%/gi;
/** A price ($24, €19.99, 24 USD). */
const PRICE_RE = /(?:[$€£]\s?(\d+(?:[.,]\d{1,2})?))|(?:\b(\d+(?:[.,]\d{1,2})?)\s?(?:usd|eur|gbp)\b)/gi;

const num = (s: string) => Number(s.replace(',', '.'));
const unitOf = (u: string) => {
  const x = u.toLowerCase().replace(/\s+/g, '').replace('.', '');
  return x === 'percent' ? '%' : x === 'floz' ? 'floz' : x;
};
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ');

/** The factual parts of one line. */
export function factualParts(line: string): { kind: 'quantity' | 'price' | 'ingredient'; text: string; value?: number; unit?: string }[] {
  const out: { kind: 'quantity' | 'price' | 'ingredient'; text: string; value?: number; unit?: string }[] = [];
  for (const m of line.matchAll(PRICE_RE)) out.push({ kind: 'price', text: m[0].trim(), value: num(m[1] ?? m[2]!) });
  for (const m of line.matchAll(QUANTITY_RE)) {
    if (m[3]) out.push({ kind: 'quantity', text: m[0].trim(), value: num(m[3]), unit: '%' });
    else out.push({ kind: 'quantity', text: m[0].trim(), value: num(m[1]!), unit: unitOf(m[2]!) });
  }
  for (const m of line.matchAll(INGREDIENT_RE)) out.push({ kind: 'ingredient', text: m[0] });
  return out;
}

/** The facts that back one factual part (a matching size, price, percentage or named ingredient). */
function backing(part: ReturnType<typeof factualParts>[number], facts: readonly FactForStatements[]): FactForStatements[] {
  if (part.kind === 'price') return facts.filter((f) => f.key === 'price' && f.valueNumber != null && Math.abs(f.valueNumber - part.value!) < 0.005);
  if (part.kind === 'quantity') {
    return facts.filter((f) => {
      const text = norm(`${f.valueText ?? ''} ${f.valueNumber ?? ''}`);
      return factualParts(text).some((q) => q.kind === 'quantity' && q.unit === part.unit && Math.abs(q.value! - part.value!) < 1e-6);
    });
  }
  const word = norm(part.text).replace(/s$/, '');
  return facts.filter((f) => ['ingredients', 'key_ingredients', 'inci'].includes(f.key) && norm(f.valueText ?? '').includes(word));
}

/**
 * Map every line to its source. `claims` is the claims check's per-line mapping (line → Claim ID); a line an
 * approved claim covers is backed by that claim, whatever facts it names.
 */
export function mapStatements(lines: readonly string[], claims: readonly LineMapping[], facts: readonly FactForStatements[]): StatementEntry[] {
  const seen = new Set<string>();
  const out: StatementEntry[] = [];
  for (const raw of lines) {
    const text = raw.trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    const parts = factualParts(text);
    const claim = claims.find((m) => m.line === text && m.status === 'claim' && m.claimId);
    if (claim) {
      out.push({ text, facts: parts.map((p) => p.text), sources: [{ claimId: claim.claimId! }], status: 'claim', unsourced: [] });
      continue;
    }
    if (!parts.length) {
      out.push({ text, facts: [], sources: [], status: 'descriptive', unsourced: [] });
      continue;
    }
    const sources: StatementSource[] = [];
    const unsourced: string[] = [];
    for (const part of parts) {
      const b = backing(part, facts);
      if (!b.length) unsourced.push(part.text);
      for (const f of b) if (!sources.some((s) => 'factId' in s && s.factId === f.id)) sources.push({ factId: f.id, key: f.key, merchantDecision: f.merchantDecision });
    }
    out.push({ text, facts: parts.map((p) => p.text), sources, status: unsourced.length ? 'unsourced' : 'sourced', unsourced });
  }
  return out;
}

/** The SKU's current facts, as the statement map reads them (tenant or explicitly scoped transaction). */
export async function factsForStatements(tx: Tx, skuId: string): Promise<FactForStatements[]> {
  const current = await currentFacts(tx, skuId);
  return Object.values(current)
    .filter((c) => !c.disputed)
    .map((c) => ({ id: c.value.id, key: c.value.key, valueText: c.value.valueText, valueNumber: c.value.valueNumber, merchantDecision: c.value.state === 'DECIDED' || c.value.merchantConfirmed }));
}

/** The statement map as a QA check: a factual line nothing backs fails hard (Launch Gate 2). */
export function statementCheck(map: StatementEntry[]): CheckResult {
  const bad = map.filter((m) => m.status === 'unsourced');
  const factual = map.filter((m) => m.status === 'sourced' || m.status === 'claim').length;
  return {
    check: 'claims',
    pass: !bad.length,
    hard: bad.length > 0,
    detail: bad.length
      ? bad.map((b) => `“${b.text}”: ${b.unsourced.join(', ')} isn’t backed by a confirmed product fact or an approved claim`).join('; ')
      : `${factual} factual statement${factual === 1 ? '' : 's'} traced to product facts or approved claims`,
    data: {
      statementMap: map,
      violations: bad.map((b) => ({ text: b.text, reason: `States ${b.unsourced.join(', ')}, which isn’t backed by a confirmed product fact or an approved claim. Confirm the fact on the product page or change the line.` })),
      unmapped: [],
    },
  };
}
