import { createHash } from 'node:crypto';
import { withTenant, type Tx } from '@arkiv/db';
import { DomainError } from '@arkiv/shared';
import type { TenantContext } from './context';
import { authorize, settle } from './cost-governor';
import { emit } from './events';
import { ThemeSet } from './intel-schemas';
import { mockThemes } from './mock-intel';
import { llmJson, routedLines } from './model-gateway';
import { THEMES_SYSTEM } from './prompts';

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
  return n;
}

/** Parse a pasted review export: CSV with a text/review/body column, or one review per line. */
export function parseReviewPaste(raw: string): SignalInput[] {
  const lines = raw.split(/\r?\n/).filter((l) => l.trim());
  const head = lines[0]?.toLowerCase() ?? '';
  if (/(^|,)"?(review|body|text|content)"?(,|$)/.test(head)) {
    const cols = head.split(',').map((c) => c.replace(/"/g, '').trim());
    const ti = cols.findIndex((c) => ['review', 'body', 'text', 'content'].includes(c));
    const ri = cols.findIndex((c) => ['rating', 'stars', 'score'].includes(c));
    const di = cols.findIndex((c) => ['date', 'created_at', 'created'].includes(c));
    return lines.slice(1).map((l) => {
      const cells = l.match(/("([^"]|"")*"|[^,]*)(,|$)/g)?.map((c) => c.replace(/,$/, '').replace(/^"|"$/g, '').replace(/""/g, '"')) ?? [];
      return { text: cells[ti] ?? '', rating: ri >= 0 ? Number(cells[ri]) || null : null, observedAt: di >= 0 ? cells[di] || null : null, source: 'review' as const };
    });
  }
  return lines.map((l) => ({ text: l, source: 'review' as const }));
}

/** Cluster themes with recency-weighted prevalence and provenance snippets. */
export async function clusterThemes(ctx: TenantContext, skuId: string) {
  const ws = ctx.workspaceId;
  const signals = await withTenant(ws, (tx) => tx`select id, text, observed_at from customer_signals where sku_id = ${skuId}
                                                 order by observed_at desc nulls last limit 400`);
  if (signals.length < 3) return 0;
  const auth = await withTenant(ws, async (tx) =>
    authorize(tx, ctx, { purpose: 'storyboard', lines: await routedLines(tx, ws, [{ task: 'customer_language.themes', kind: 'llm', inputTokens: 30_000, outputTokens: 2_000 }]), idempotencyKey: `themes:${skuId}:${signals.length}:${new Date().toISOString().slice(0, 10)}` }),
  );
  try {
    const texts = signals.map((s) => s.text as string);
    const res = await llmJson({
      ctx,
      token: auth.token,
      task: 'customer_language.themes',
      subject: { type: 'sku', id: skuId },
      system: THEMES_SYSTEM,
      content: [{ type: 'untrusted', sourceId: 'reviews', text: texts.map((t, i) => `[${i}] ${t}`).join('\n').slice(0, 100_000) }],
      schema: ThemeSet,
      mock: () => mockThemes(texts),
      effort: 'medium',
      maxTokens: 2000,
    });
    await withTenant(ws, async (tx) => {
      await tx`delete from customer_themes where sku_id = ${skuId}`;
      const now = Date.now();
      for (const t of res.data.themes) {
        const idx = t.snippetIndexes.filter((i) => i < signals.length);
        // Recency weighting: signals from the last 90 days count fully, older ones decay.
        const weight = idx.reduce((acc, i) => {
          const at = signals[i]!.observed_at ? new Date(signals[i]!.observed_at as string).getTime() : now;
          return acc + Math.exp(-(now - at) / (180 * 86400_000));
        }, 0);
        const mentions = texts.filter((x) => t.label.split(/\s+/).some((w) => w.length > 3 && x.toLowerCase().includes(w.toLowerCase()))).length;
        const prevalence = Math.min(1, Math.max(idx.length, mentions) / signals.length);
        await tx`insert into customer_themes (workspace_id, sku_id, label, signal_type, prevalence, intensity, sample_size, trend, relevance, snippet_ids)
                 values (${ws}, ${skuId}, ${t.label}, ${t.signalType}, ${prevalence}, ${t.intensity}, ${signals.length},
                         ${weight > idx.length * 0.8 ? 'rising' : 'flat'}, 1, ${idx.map((i) => signals[i]!.id as string)})`;
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
