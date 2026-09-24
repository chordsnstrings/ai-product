import { z } from 'zod';

/**
 * Landing page content (plan 05 §5, plan 03 P1): structured blocks only, never free HTML. The console edits these
 * blocks, the publish step lints and validates them, and the marketing page renders them. A variant overrides
 * fields of individual blocks (e.g. only the hero headline).
 */

const text = (max: number, min = 0) => z.string().trim().min(min).max(max);
const uuid = z.string().uuid();

export const LandingHero = z
  .object({
    label: text(60),
    headline: text(120, 3),
    sub: text(240),
    // Product-archetype visual: an example asset shown with the "Example" label (validated like gallery assets).
    visualAssetId: uuid.nullable().optional(),
    visualCaption: text(60).optional(),
  })
  .strict();

export const LandingProof = z
  .object({
    // Process proof only ("Built only for skincare brands"); live counters show only above their minimum.
    text: text(120),
    liveCounter: z.boolean().optional(),
    // Testimonials must reference a stored, unrevoked consent record (FTC 16 CFR 465).
    testimonialIds: z.array(uuid).max(3).optional(),
  })
  .strict();

export const LandingStep = z.object({ title: text(60, 2), body: text(240) }).strict();
export const LandingGalleryItem = z.object({ assetId: uuid, caption: text(60, 2) }).strict();
export const LandingFaqItem = z.object({ q: text(120, 3), a: text(600, 3) }).strict();

export const LANDING_GALLERY_MIN = 3;
export const LANDING_GALLERY_MAX = 6;

export const LandingBlocks = z
  .object({
    hero: LandingHero,
    proof: LandingProof,
    howItWorks: z.array(LandingStep).min(3).max(4),
    // 3–6 skincare examples labelled "Example" (plan 03 P1 §7), or none (the section is hidden).
    gallery: z
      .object({ items: z.array(LandingGalleryItem).max(LANDING_GALLERY_MAX) })
      .strict()
      .refine((g) => g.items.length === 0 || g.items.length >= LANDING_GALLERY_MIN, `Show ${LANDING_GALLERY_MIN}–${LANDING_GALLERY_MAX} examples, or none.`),
    faq: z.array(LandingFaqItem).min(1).max(8),
    cta: z.object({ label: text(40, 2), assurance: text(80) }).strict(),
  })
  .strict();
export type LandingBlocks = z.infer<typeof LandingBlocks>;

/** A variant's overrides: any block, and within the hero/proof/cta blocks any subset of fields (no defaults, so an
 * override never resets a field it doesn't name). */
export const LandingVariantContent = z
  .object({
    hero: LandingHero.partial(),
    proof: LandingProof.partial(),
    howItWorks: z.array(LandingStep).min(3).max(4),
    faq: z.array(LandingFaqItem).min(1).max(8),
    cta: z.object({ label: text(40, 2), assurance: text(80) }).partial().strict(),
  })
  .partial()
  .strict();
export type LandingVariantContent = z.infer<typeof LandingVariantContent>;

export const LandingVariant = z
  .object({
    key: z.string().trim().regex(/^[a-z0-9_-]{1,24}$/, 'Variant keys are lowercase letters, digits, - and _'),
    weight: z.number().finite().positive('Variant weights must be greater than 0'),
    content: LandingVariantContent,
  })
  .strict();
export type LandingVariant = z.infer<typeof LandingVariant>;

export const LandingPrimaryMetric = ['upload_start', 'taste_cvr'] as const;
export type LandingPrimaryMetric = (typeof LandingPrimaryMetric)[number];
export const LandingExperiment = z
  .object({ primaryMetric: z.enum(LandingPrimaryMetric), minSample: z.number().int().min(100).max(100_000) })
  .strict();
export type LandingExperiment = z.infer<typeof LandingExperiment>;
export const DEFAULT_LANDING_EXPERIMENT: LandingExperiment = { primaryMetric: 'upload_start', minSample: 400 };

/** The copy every page starts from (plan 03 P1): how it works, FAQ (price, subscription, needs, time, data) and CTA. */
export const DEFAULT_LANDING_BLOCKS: LandingBlocks = {
  hero: {
    label: 'Skincare · Ad testing',
    headline: 'Know what skincare ad to make next. Then make it.',
    sub: 'Upload your product. Get three test ideas and a storyboard in about a minute. Your first ad is $19.',
    visualAssetId: null,
    visualCaption: '',
  },
  proof: { text: 'Built only for skincare brands', liveCounter: true, testimonialIds: [] },
  howItWorks: [
    { title: 'We catalogue your product', body: 'Name, size, ingredients, packaging and every claim on your page — marked as observed or inferred, never invented.' },
    { title: 'Three tests worth running', body: 'Different hypotheses, not copy variations: texture, objections, routines — grounded in what your customers say.' },
    { title: 'A checked, finished ad', body: '15 seconds, 9:16 + 4:5 + square, captions and voice. Product accuracy and claims checked before you see it.' },
  ],
  gallery: { items: [] },
  faq: [
    { q: 'What does it cost?', a: 'The analysis and three ideas are free. Your first finished ad is $19 during a 60-minute intro window after your storyboard is ready; after that it’s $29. Plans start at $49/month.' },
    { q: 'Is there a subscription?', a: 'Not unless you choose one. The $19 ad is a one-time purchase.' },
    { q: 'What do I need?', a: 'A product link or one clear photo of the front of your product.' },
    { q: 'How long does it take?', a: 'Ideas in about a minute; your finished ad in a few minutes.' },
    { q: 'What happens to my data?', a: 'Your product data, claims and results are only ever used for your brand. Delete everything anytime.' },
  ],
  cta: { label: 'Analyze my product — free', assurance: 'Free analysis · no card · about 40 seconds' },
};

/**
 * Pages saved before blocks existed hold `{label, headline, sub, proof}`: read them as blocks with the default
 * copy for the rest. Anything that is already blocks is returned as is (validation happens on save/publish).
 */
export function landingBlocksFrom(raw: unknown): LandingBlocks {
  const r = (raw ?? {}) as Record<string, unknown>;
  if (r.hero && typeof r.hero === 'object') {
    const parsed = LandingBlocks.safeParse(r);
    if (parsed.success) return parsed.data;
    // Stored blocks that no longer validate (e.g. a gallery the rights sweep trimmed below the minimum) still render.
    const d = DEFAULT_LANDING_BLOCKS;
    return {
      hero: { ...d.hero, ...(r.hero as object) },
      proof: { ...d.proof, ...((r.proof as object) ?? {}) },
      howItWorks: Array.isArray(r.howItWorks) ? (r.howItWorks as LandingBlocks['howItWorks']) : d.howItWorks,
      gallery: { items: Array.isArray((r.gallery as { items?: unknown })?.items) ? ((r.gallery as LandingBlocks['gallery']).items ?? []) : [] },
      faq: Array.isArray(r.faq) ? (r.faq as LandingBlocks['faq']) : d.faq,
      cta: { ...d.cta, ...((r.cta as object) ?? {}) },
    };
  }
  const s = (k: string, fallback: string) => (typeof r[k] === 'string' ? (r[k] as string) : fallback);
  const d = DEFAULT_LANDING_BLOCKS;
  return { ...d, hero: { ...d.hero, label: s('label', d.hero.label), headline: s('headline', d.hero.headline), sub: s('sub', d.hero.sub) }, proof: { ...d.proof, text: s('proof', d.proof.text) } };
}

/** Legacy variant overrides (`{headline, sub, …}`) read as hero/proof overrides. */
export function landingVariantFrom(raw: unknown): LandingVariantContent {
  const r = (raw ?? {}) as Record<string, unknown>;
  if (['hero', 'proof', 'howItWorks', 'faq', 'cta'].some((k) => k in r)) return r as LandingVariantContent;
  const hero: Record<string, unknown> = {};
  for (const k of ['label', 'headline', 'sub'] as const) if (typeof r[k] === 'string') hero[k] = r[k];
  return { ...(Object.keys(hero).length ? { hero } : {}), ...(typeof r.proof === 'string' ? { proof: { text: r.proof } } : {}) };
}

/** The blocks a visitor sees: base blocks with the assigned variant's overrides applied block by block. */
export function applyLandingVariant(base: LandingBlocks, v: LandingVariantContent | null | undefined): LandingBlocks {
  if (!v) return base;
  return {
    ...base,
    hero: { ...base.hero, ...(v.hero ?? {}) },
    proof: { ...base.proof, ...(v.proof ?? {}) },
    howItWorks: v.howItWorks ?? base.howItWorks,
    faq: v.faq ?? base.faq,
    cta: { ...base.cta, ...(v.cta ?? {}) },
  };
}

/** Every example asset a page (and its variants) shows: hero visual and gallery items. */
export function landingAssetIds(content: LandingBlocks, variants: readonly { content: LandingVariantContent }[] = []): string[] {
  const ids = new Set<string>();
  if (content.hero.visualAssetId) ids.add(content.hero.visualAssetId);
  for (const g of content.gallery.items) ids.add(g.assetId);
  for (const v of variants) if (v.content.hero?.visualAssetId) ids.add(v.content.hero.visualAssetId);
  return [...ids];
}

/** Every testimonial a page (and its variants) shows. */
export function landingTestimonialIds(content: LandingBlocks, variants: readonly { content: LandingVariantContent }[] = []): string[] {
  const ids = new Set(content.proof.testimonialIds ?? []);
  for (const v of variants) for (const id of v.content.proof?.testimonialIds ?? []) ids.add(id);
  return [...ids];
}
