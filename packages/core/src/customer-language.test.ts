import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool, withTenant } from '@arkiv/db';
import { makeSku, makeTenant, truncateAll } from '@arkiv/db/testing';
import { clusterThemes, importSignals, parseCsv, parseReviewPaste, stripSignature, themeMetrics } from './customer-language';
import { recordFacts } from './product-truth';
import { ctxFor } from './testing';

beforeEach(truncateAll);
afterAll(closeAll);

const NOW = Date.parse('2026-09-01T00:00:00Z');
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000);

describe('theme metrics (§18)', () => {
  it('prevalence is recency-weighted: recent mentions count more than old ones', () => {
    const signals = [
      ...Array.from({ length: 5 }, () => ({ text: 'sticky', observedAt: daysAgo(10) })),
      ...Array.from({ length: 5 }, () => ({ text: 'fine', observedAt: daysAgo(400) })),
    ];
    const recent = themeMetrics(signals, [0, 1, 2, 3, 4], { now: NOW });
    const old = themeMetrics(signals, [5, 6, 7, 8, 9], { now: NOW });
    expect(recent.sampleSize).toBe(5);
    expect(old.sampleSize).toBe(5);
    expect(recent.prevalence).toBeGreaterThan(0.8);
    expect(old.prevalence).toBeLessThan(0.2);
    expect(recent.prevalence + old.prevalence).toBeCloseTo(1, 3);
  });

  it('trend compares the last 90 days with the 90 before, in both directions', () => {
    const mk = (recentHits: number, priorHits: number) => {
      const s = [...Array.from({ length: 10 }, () => ({ text: 'x', observedAt: daysAgo(20) })), ...Array.from({ length: 10 }, () => ({ text: 'x', observedAt: daysAgo(120) }))];
      const matches = [...Array.from({ length: recentHits }, (_, i) => i), ...Array.from({ length: priorHits }, (_, i) => 10 + i)];
      return themeMetrics(s, matches, { now: NOW }).trend;
    };
    expect(mk(7, 2)).toBe('rising');
    expect(mk(2, 7)).toBe('falling');
    expect(mk(4, 4)).toBe('flat');
  });

  it('undated signals get a neutral weight and never make a trend', () => {
    const undated = Array.from({ length: 12 }, () => ({ text: 'x', observedAt: null }));
    const m = themeMetrics(undated, [0, 1, 2, 3, 4, 5, 6, 7, 8], { now: NOW });
    expect(m.trend).toBe('flat');
    expect(m.prevalence).toBeCloseTo(0.75, 3);
    // Thin windows (fewer than 5 dated signals each) are flat, however lopsided.
    const thin = [0, 1, 2].map(() => ({ text: 'x', observedAt: daysAgo(5) })).concat([0, 1, 2].map(() => ({ text: 'x', observedAt: daysAgo(100) })));
    expect(themeMetrics(thin, [0, 1, 2], { now: NOW }).trend).toBe('flat');
  });

  it('relevance is lower for order/shipping talk and higher when snippets name the product', () => {
    const s = [
      { text: 'Shipping took three weeks and the package arrived crushed', observedAt: null },
      { text: 'Delivery was slow', observedAt: null },
      { text: 'The niacinamide glow serum is not sticky at all', observedAt: null },
      { text: 'Niacinamide makes my skin calm', observedAt: null },
    ];
    const shipping = themeMetrics(s, [0, 1], { productTerms: ['niacinamide'] });
    const product = themeMetrics(s, [2, 3], { productTerms: ['niacinamide'] });
    expect(shipping.relevance).toBeLessThan(0.5);
    expect(product.relevance).toBe(1);
  });
});

describe('review import keeps review text only (§48 minimise PII)', () => {
  it('parses quoted CSV cells with commas, quotes and line breaks', () => {
    expect(parseCsv('a,b\n"one, two","say ""hi""\nthere"\n')).toEqual([['a', 'b'], ['one, two', 'say "hi"\nthere']]);
  });

  it.each([
    ['Judge.me', 'title,body,rating,review_date,source,curated,reviewer_name,reviewer_email,product_id,product_handle,reply,ip_address,location\n"Great","Soaks in fast, no stickiness",5,2026-08-01,web,ok,Sarah Kim,sarah@example.com,123,glow,,10.1.2.3,Austin TX'],
    ['Yotpo', 'Review Title,Review Content,Review Score,Date,Product ID,Product Name,Display Name,Email\nGreat,"Soaks in fast, no stickiness",5,2026-08-01,123,Glow,Sarah Kim,sarah@example.com'],
    ['Okendo', 'reviewId,productId,rating,title,body,reviewer.name,reviewer.email,dateCreated\nr1,123,5,Great,"Soaks in fast, no stickiness",Sarah Kim,sarah@example.com,2026-08-01T10:00:00Z'],
    ['Shopify Product Reviews', 'product_handle,state,rating,title,author,email,location,body,reply,created_at,replied_at\nglow,published,5,Great,Sarah Kim,sarah@example.com,Austin,"Soaks in fast, no stickiness",,2026-08-01 10:00:00 UTC,'],
  ])('%s export: review text, rating and date; the name only as author; email and other columns dropped', (_app, csv) => {
    const [r] = parseReviewPaste(csv);
    expect(r!.text).toBe('Great. Soaks in fast, no stickiness');
    expect(r!.rating).toBe(5);
    expect(r!.observedAt).toMatch(/^2026-08-01/);
    expect(r!.author).toBe('Sarah Kim');
    expect(JSON.stringify(r)).not.toMatch(/sarah@example|Austin|10\.1\.2\.3/);
  });

  it('a CSV export whose review column is not recognised is refused, never stored line by line', () => {
    expect(() => parseReviewPaste('Name,Email,Stars,Feedback text here\nSarah Kim,sarah@example.com,5,Lovely')).toThrow(/review text column/);
  });

  it('one review per line, with trailing sign-offs removed', () => {
    expect(stripSignature('Loved it, no pilling — Sarah K.')).toBe('Loved it, no pilling');
    expect(stripSignature('Great serum - Jo')).toBe('Great serum');
    expect(stripSignature('Works well with SPF - Morning routine')).toBe('Works well with SPF - Morning routine');
    expect(parseReviewPaste('Loved it, no pilling — Sarah K.\n\nA bit sticky ~ Maria').map((r) => r.text)).toEqual(['Loved it, no pilling', 'A bit sticky']);
  });

  it('stores the hashed author and no email', async () => {
    const t = await makeTenant();
    const ctx = ctxFor(t.workspaceId, t.userId);
    const skuId = await makeSku(t.workspaceId);
    const items = parseReviewPaste('title,body,rating,reviewer_name,reviewer_email\nOk,"Nice, write me at jo@example.com",4,Jo Lee,jo@example.com');
    await withTenant(t.workspaceId, (tx) => importSignals(tx, ctx, skuId, items));
    const [row] = await ownerPool()`select text, author_hash from customer_signals where sku_id = ${skuId}`;
    expect(row!.text).toBe('Ok. Nice, write me at [email]');
    expect(row!.author_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('clusterThemes stores per-theme numbers', () => {
  it('sample size is the theme’s own, with sentiment, trend and relevance', async () => {
    const t = await makeTenant();
    const ctx = ctxFor(t.workspaceId, t.userId);
    const skuId = await makeSku(t.workspaceId);
    await withTenant(t.workspaceId, (tx) => recordFacts(tx, ctx, skuId, [{ key: 'key_ingredients', valueText: 'Niacinamide', sourceType: 'product_page', state: 'OBSERVED' }]));
    const d = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
    const items = [
      ...Array.from({ length: 6 }, (_, i) => ({ text: `So sticky with the niacinamide at first (${i})`, observedAt: d(10 + i) })),
      ...Array.from({ length: 6 }, (_, i) => ({ text: `Skin feels soft (${i})`, observedAt: d(100 + i) })),
      ...Array.from({ length: 2 }, (_, i) => ({ text: `Soft and sticky both (${i})`, observedAt: d(120 + i) })),
    ];
    await withTenant(t.workspaceId, (tx) => importSignals(tx, ctx, skuId, items));
    expect(await clusterThemes(ctx, skuId)).toBeGreaterThan(0);
    const themes = await ownerPool()`select label, sample_size, trend, sentiment::float8 as sentiment, relevance::float8 as relevance, prevalence::float8 as prevalence, cardinality(snippet_ids) as reps
                                     from customer_themes where sku_id = ${skuId}`;
    const sticky = themes.find((x) => x.label === 'sticky or greasy feel')!;
    const soft = themes.find((x) => x.label === 'feels hydrated and soft')!;
    expect(sticky).toMatchObject({ sample_size: 8, trend: 'rising', sentiment: -0.6, reps: 5 });
    expect(soft).toMatchObject({ sample_size: 8, trend: 'falling', sentiment: 0.7 });
    expect(sticky.relevance).toBeGreaterThan(soft.relevance);
    expect(sticky.prevalence).toBeGreaterThan(soft.prevalence);
  }, 30_000);
});
