import { createHash } from 'node:crypto';
import { parseCsv as parseCsvWith } from './csv';
import { withTenant, type Tx } from '@arkiv/db';
import { DomainError } from '@arkiv/shared';
import { notePromptInjection } from './abuse';
import type { TenantContext } from './context';
import { authorize, settle } from './cost-governor';
import { emit } from './events';
import { ThemeSet } from './intel-schemas';
import { mockThemes } from './mock-intel';
import { llmJson, routedLines } from './model-gateway';

/**
 * Customer Language Engine (§18). Raw signals are imported with original text/source/time and never rewritten.
 * Personal data is minimized before storage (§48: redact emails/phones; hash author). Themes guide hooks and
 * objections — they never prove efficacy.
 */

export function redactPii(text: string): string {
  return text
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/(\+?\d[\d\s().-]{7,}\d)/g, '[phone]')
    .replace(/\b(\d{1,5}\s+[A-Za-z]+\s+(street|st|avenue|ave|road|rd|lane|ln|drive|dr))\b/gi, '[address]');
}

export interface SignalInput {
  text: string;
  source?: 'review' | 'qa' | 'comment' | 'support' | 'survey' | 'page';
  rating?: number | null;
  author?: string | null;
  observedAt?: string | null;
  sourceRef?: string | null;
}

export async function importSignals(tx: Tx, ctx: TenantContext, skuId: string, items: SignalInput[]) {
  if (items.length > 5000) throw new DomainError('INVALID', 'Import up to 5,000 reviews at a time.');
  let n = 0;
  for (const it of items) {
    const text = redactPii(it.text.trim()).slice(0, 4000);
    if (text.length < 3) continue;
    const ref = it.sourceRef ?? createHash('sha1').update(text).digest('hex').slice(0, 16);
    const dup = await tx`select 1 from customer_signals where sku_id = ${skuId} and source_ref = ${ref} limit 1`;
    if (dup.length) continue;
    await tx`insert into customer_signals (workspace_id, sku_id, source, source_ref, text, rating, author_hash, observed_at)
             values (${ctx.workspaceId}, ${skuId}, ${it.source ?? 'review'}, ${ref}, ${text}, ${it.rating ?? null},
                     ${it.author ? createHash('sha256').update(it.author.toLowerCase()).digest('hex') : null}, ${it.observedAt ?? null})`;
    n++;
  }
  // Imported reviews are data, never instructions (§48); attempts to smuggle instructions in are recorded.
  if (n) await notePromptInjection(tx, { workspaceId: ctx.workspaceId, source: 'reviews', text: items.map((it) => it.text).join('\n'), subject: { type: 'sku', id: skuId } });
  return n;
}

/** RFC 4180 CSV (shared with the performance import, csv.ts). Review exports are comma-separated. */
export const parseCsv = (raw: string): string[][] => parseCsvWith(raw, ',');

/** "reviewer.name", "Review Content", "dateCreated", "review_body" → "reviewer name", "review content", "date created", "review body". */
const normHeader = (h: string) => h.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Column names used by the common review apps' exports (Judge.me, Yotpo, Okendo, Shopify Product Reviews, Stamped…),
// in order of preference.
const TEXT_COLS = ['body', 'review body', 'review content', 'content', 'review text', 'review', 'text', 'comment', 'comments', 'message', 'feedback'];
const TITLE_COLS = ['title', 'review title', 'headline', 'summary'];
const RATING_COLS = ['rating', 'review score', 'score', 'stars', 'star rating', 'review rating'];
const DATE_COLS = ['review date', 'date', 'created at', 'date created', 'created', 'submitted at', 'published at', 'review created at'];
const AUTHOR_COLS = ['reviewer name', 'author', 'name', 'display name', 'user name', 'customer name', 'reviewer', 'nickname', 'reviewer display name'];
/** Headers that mark the first line as a CSV header even when no review-text column is recognised. */
const KNOWN_HEADERS = new Set([...TEXT_COLS, ...TITLE_COLS, ...RATING_COLS, ...DATE_COLS, ...AUTHOR_COLS, 'email', 'reviewer email', 'user email', 'product id', 'product handle', 'product name', 'ip address', 'location', 'state', 'verified', 'reply']);

const pick = (cols: string[], names: string[]) => {
  for (const n of names) {
    const i = cols.indexOf(n);
    if (i >= 0) return i;
  }
  return -1;
};

/** A trailing sign-off ("— Sarah K.", "- Jo", "~ Maria L") is the reviewer's name, not review text. */
export const stripSignature = (t: string) => t.replace(/\s*(?:[—–~]|--?)\s*[A-Z][a-z]+(?:\s+[A-Z][a-z]*\.?)?\s*$/, '').trim();

/**
 * Parse a pasted review export. A CSV keeps only the review text (with its title), rating and date; the reviewer's
 * name is kept only to be hashed on import, and every other column (emails, IPs, locations…) is dropped. A CSV whose
 * review column cannot be found is refused rather than stored line by line with names and emails in it. Anything
 * else is one review per line.
 */
export function parseReviewPaste(raw: string): SignalInput[] {
  const rows = parseCsv(raw);
  const cols = (rows[0] ?? []).map(normHeader);
  const ti = pick(cols, TEXT_COLS);
  if (cols.length >= 2 && ti >= 0) {
    const hi = pick(cols, TITLE_COLS);
    const ri = pick(cols, RATING_COLS);
    const di = pick(cols, DATE_COLS);
    const ai = pick(cols, AUTHOR_COLS);
    return rows.slice(1).map((cells) => {
      const body = stripSignature((cells[ti] ?? '').trim());
      const title = hi >= 0 ? (cells[hi] ?? '').trim() : '';
      const date = di >= 0 ? (cells[di] ?? '').trim() : '';
      const rating = ri >= 0 ? Number(cells[ri]) : NaN;
      return {
        text: title && body && !body.toLowerCase().startsWith(title.toLowerCase()) ? `${title}. ${body}` : body || title,
        rating: Number.isFinite(rating) && rating > 0 ? rating : null,
        observedAt: date && !Number.isNaN(Date.parse(date)) ? new Date(date).toISOString() : null,
        author: ai >= 0 ? (cells[ai] ?? '').trim() || null : null,
        source: 'review' as const,
      };
    });
  }
  if (cols.length >= 3 && cols.filter((c) => KNOWN_HEADERS.has(c)).length >= 2) {
    throw new DomainError('INVALID', 'We couldn’t find the review text column in that export. Rename it to “body” or paste one review per line.');
  }
  return raw
    .split(/\r?\n/)
    .map((l) => stripSignature(l.trim()))
    .filter(Boolean)
    .map((l) => ({ text: l, source: 'review' as const }));
}

const DAY = 86_400_000;
/** Recency half-life of a signal's weight (§18 recency-weighted prevalence). */
const HALF_LIFE_DAYS = 120;
/** Weight of an undated signal: neutral, neither fresh nor stale. Undated signals never count toward a trend. */
const UNDATED_WEIGHT = 0.5;
/** Trend windows: the last 90 days against the 90 before, each needing this many dated signals. */
const TREND_WINDOW_DAYS = 90;
const TREND_MIN_SIGNALS = 5;

export interface ThemeMetrics {
  prevalence: number;
  sampleSize: number;
  trend: 'rising' | 'flat' | 'falling';
  relevance: number;
}

const OFF_PRODUCT = /\b(shipping|shipped|delivery|delivered|arrived|package|parcel|courier|customer service|support|refund|order(ed)?|website|checkout|tracking)\b/i;

/**
 * A theme's numbers from the signals it matches (§18): recency-weighted prevalence (Σ weight of matching signals /
 * Σ weight of all signals), its own sample size, a trend that compares the theme's share of the last 90 days with
 * the 90 before (flat when either window is too thin), and SKU relevance — lower when its snippets talk about the
 * order rather than the product, higher when they name the product or its ingredients.
 */
export function themeMetrics(
  signals: { text: string; observedAt: Date | string | null }[],
  matches: number[],
  opts: { now?: number; productTerms?: string[] } = {},
): ThemeMetrics {
  const now = opts.now ?? Date.now();
  const set = new Set(matches.filter((i) => i >= 0 && i < signals.length));
  const at = signals.map((s) => (s.observedAt ? new Date(s.observedAt).getTime() : null));
  const weight = at.map((t) => (t == null || Number.isNaN(t) ? UNDATED_WEIGHT : Math.pow(0.5, Math.max(0, now - t) / (HALF_LIFE_DAYS * DAY))));
  const total = weight.reduce((a, b) => a + b, 0);
  const hit = [...set].reduce((a, i) => a + weight[i]!, 0);
  const prevalence = total > 0 ? Math.min(1, hit / total) : 0;

  const window = (from: number, to: number) => {
    const idx = at.map((t, i) => (t != null && !Number.isNaN(t) && now - t >= from * DAY && now - t < to * DAY ? i : -1)).filter((i) => i >= 0);
    return { n: idx.length, share: idx.length ? idx.filter((i) => set.has(i)).length / idx.length : 0 };
  };
  const recent = window(0, TREND_WINDOW_DAYS);
  const prior = window(TREND_WINDOW_DAYS, 2 * TREND_WINDOW_DAYS);
  let trend: ThemeMetrics['trend'] = 'flat';
  if (recent.n >= TREND_MIN_SIGNALS && prior.n >= TREND_MIN_SIGNALS) {
    const delta = recent.share - prior.share;
    const threshold = Math.max(0.1, 0.25 * prior.share);
    trend = delta >= threshold ? 'rising' : delta <= -threshold ? 'falling' : 'flat';
  }

  const texts = [...set].map((i) => signals[i]!.text.toLowerCase());
  const terms = (opts.productTerms ?? []).map((t) => t.toLowerCase().trim()).filter((t) => t.length >= 4);
  const specific = texts.length ? texts.filter((t) => terms.some((w) => t.includes(w))).length / texts.length : 0;
  const offProduct = texts.length ? texts.filter((t) => OFF_PRODUCT.test(t)).length / texts.length : 0;
  const relevance = Math.round(Math.min(1, Math.max(0.1, 0.7 + 0.3 * specific - 0.6 * offProduct)) * 100) / 100;
  return { prevalence: Math.round(prevalence * 10_000) / 10_000, sampleSize: set.size, trend, relevance };
}

/** Words that tie a snippet to this SKU: its name, format and ingredients. */
async function productTerms(tx: Tx, skuId: string): Promise<string[]> {
  const rows = await tx`select normalized_key, value_text from product_facts where sku_id = ${skuId} and status <> 'SUPERSEDED'
                        and normalized_key in ('name', 'format', 'texture', 'key_ingredients', 'category') and value_text is not null`;
  const generic = new Set(['serum', 'cream', 'skincare', 'product', 'with', 'the', 'and', 'for', 'daily']);
  return [...new Set(rows.flatMap((r) => String(r.value_text).toLowerCase().split(/[^a-z0-9%]+/)).filter((w) => w.length >= 4 && !generic.has(w)))];
}

/** Cluster themes with recency-weighted prevalence and provenance snippets. */
export async function clusterThemes(ctx: TenantContext, skuId: string) {
  const ws = ctx.workspaceId;
  const signals = await withTenant(ws, (tx) => tx`select id, text, observed_at from customer_signals where sku_id = ${skuId}
                                                 order by observed_at desc nulls last limit 400`);
  if (signals.length < 3) return 0;
  const auth = await withTenant(ws, async (tx) =>
    authorize(tx, ctx, { purpose: 'storyboard', skuId, lines: await routedLines(tx, ws, [{ task: 'customer_language.themes', kind: 'llm', inputTokens: 30_000, outputTokens: 4_000 }]), idempotencyKey: `themes:${skuId}:${signals.length}:${new Date().toISOString().slice(0, 10)}` }),
  );
  try {
    const texts = signals.map((s) => s.text as string);
    const res = await llmJson({
      ctx,
      token: auth.token,
      task: 'customer_language.themes',
      subject: { type: 'sku', id: skuId },
      template: 'themes',
      content: [{ type: 'untrusted', sourceId: 'reviews', text: texts.map((t, i) => `[${i}] ${t}`).join('\n').slice(0, 100_000) }],
      schema: ThemeSet,
      mock: () => mockThemes(texts),
      effort: 'medium',
      maxTokens: 4000,
    });
    await withTenant(ws, async (tx) => {
      const terms = await productTerms(tx, skuId);
      const dated = signals.map((s) => ({ text: s.text as string, observedAt: (s.observed_at as Date | null) ?? null }));
      await tx`delete from customer_themes where sku_id = ${skuId}`;
      for (const t of res.data.themes) {
        const idx = t.snippetIndexes.filter((i) => i < signals.length);
        // Every signal the theme covers (the representatives are always among them).
        const m = themeMetrics(dated, [...new Set([...t.matchIndexes, ...idx])], { productTerms: terms });
        await tx`insert into customer_themes (workspace_id, sku_id, label, signal_type, prevalence, intensity, sentiment, sample_size, trend, relevance, snippet_ids)
                 values (${ws}, ${skuId}, ${t.label}, ${t.signalType}, ${m.prevalence}, ${t.intensity}, ${t.sentiment}, ${m.sampleSize},
                         ${m.trend}, ${m.relevance}, ${idx.map((i) => signals[i]!.id as string)})`;
      }
      await emit(tx, ctx, 'CUSTOMER_THEME_UPDATED', { type: 'sku', id: skuId }, { themes: res.data.themes.length, sample: signals.length });
      await settle(tx, ctx, auth.authorizationId, 'consumed');
    });
    return res.data.themes.length;
  } catch (e) {
    await withTenant(ws, (tx) => settle(tx, ctx, auth.authorizationId, 'consumed'));
    throw e;
  }
}

/** Themes free-text feedback usually falls into (cancellation reasons, plan 05 §17); first match wins. */
const FEEDBACK_THEMES: { theme: string; re: RegExp }[] = [
  { theme: 'Price / budget', re: /\b(price|pricing|expensive|cost|costs|afford|budget|money|cheaper|too much)\b/i },
  { theme: 'Results / performance', re: /\b(results?|roas|sales|conversions?|didn.?t (work|convert|perform)|no (lift|impact)|performance|ctr)\b/i },
  { theme: 'Creative quality', re: /\b(quality|looks? (fake|off|weird|ai)|fake|uncanny|wrong (product|label|colou?r)|artifacts?|blurry)\b/i },
  { theme: 'Not using it / no time', re: /\b(time|busy|didn.?t use|not using|haven.?t used|forgot|bandwidth)\b/i },
  { theme: 'Switching / in-house', re: /\b(switch(ing|ed)?|competitor|another (tool|app|platform)|agency|in.?house|freelancer)\b/i },
  { theme: 'Product or technical issues', re: /\b(bugs?|errors?|broken|slow|crash|integration|connect(ion)?|shopify|meta|tiktok)\b/i },
  { theme: 'Business paused / closing', re: /\b(clos(e|ing)|shut(ting)? down|paus(e|ing)|seasonal|sold|pivot|stopp?ed selling)\b/i },
];
const FEEDBACK_STOP = new Set(['the', 'and', 'for', 'but', 'not', 'too', 'was', 'are', 'you', 'your', 'our', 'with', 'this', 'that', 'just', 'have', 'had', 'will', 'from', 'more', 'very', 'really', 'dont', 'didnt', 'wasnt', 'would', 'could', 'also', 'much', 'some']);

/**
 * Cluster short free-text answers (the cancel flow's "anything else?") into themes, deterministically and without
 * model spend: known themes first, then the remaining answers grouped by the word most of them share. Each theme
 * keeps its count and a few verbatim examples.
 */
export function clusterFreeText(texts: string[], opts: { examples?: number } = {}): { theme: string; count: number; examples: string[] }[] {
  const keep = opts.examples ?? 3;
  const groups = new Map<string, string[]>();
  const rest: string[] = [];
  for (const raw of texts) {
    const t = raw.trim();
    if (!t) continue;
    const hit = FEEDBACK_THEMES.find((f) => f.re.test(t));
    if (hit) groups.set(hit.theme, [...(groups.get(hit.theme) ?? []), t]);
    else rest.push(t);
  }
  const words = (t: string) => [...new Set(t.toLowerCase().replace(/'/g, '').replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length >= 4 && !FEEDBACK_STOP.has(w)))];
  // Remaining answers: repeatedly take the word shared by the most of them (two or more) as a theme.
  let pool = rest;
  for (;;) {
    const freq = new Map<string, number>();
    for (const t of pool) for (const w of words(t)) freq.set(w, (freq.get(w) ?? 0) + 1);
    const [top, n] = [...freq.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0] ?? ['', 0];
    if (n < 2) break;
    groups.set(`“${top}”`, pool.filter((t) => words(t).includes(top)));
    pool = pool.filter((t) => !words(t).includes(top));
  }
  if (pool.length) groups.set('Other', pool);
  const other = (theme: string) => (theme === 'Other' ? 1 : 0);
  return [...groups.entries()].map(([theme, xs]) => ({ theme, count: xs.length, examples: xs.slice(0, keep) })).sort((a, b) => other(a.theme) - other(b.theme) || b.count - a.count);
}
