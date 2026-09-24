import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Tx } from '@arkiv/db';
import {
  applyLandingVariant,
  DEFAULT_LANDING_EXPERIMENT,
  DomainError,
  env,
  LandingBlocks,
  PLANS,
  PRICES,
  landingAssetIds,
  landingBlocksFrom,
  LandingExperiment,
  landingTestimonialIds,
  LandingVariant,
  landingVariantFrom,
  type LandingVariantContent,
} from '@arkiv/shared';
import { audit, type Staff } from './admin';
import { raiseAlert } from './alerts';
import { fleschKincaidGrade, MAX_LANDING_GRADE, scanCreativeText } from './compliance';
import { storage } from './storage';
import { posterior, probBest } from './statistics';

/**
 * Landing pages (plan 05 §5, plan 03 P1, plan 04 L13): structured blocks, a working draft and a published copy,
 * a compliance lint that runs on every path to the public page (save, publish, rollback), example assets that must
 * be skincare examples we own with live rights, testimonials tied to a stored consent record, and A/B/n variants
 * judged only on their pre-registered primary metric past a minimum sample.
 */

// ───────────── Compliance lint ─────────────

const MARKETING_BANNED = [
  { re: /\b\d+(\.\d+)?\s*[x×]\s*(roas|return|revenue|sales|conversions?)\b/i, why: 'Customer-result multiples need substantiation.' },
  { re: /\bguarantee(d|s)?\b/i, why: 'Guarantees are only allowed if they are real, written policies.' },
  { re: /\b(only|just)\s+\d+\s+(spots?|left|remaining)\b/i, why: 'Scarcity must be real; the system has no such limit.' },
  { re: /\b(thousands|millions|\d{2,}[,\d]*)\s+(of\s+)?(brands|customers|users)\b/i, why: 'Usage numbers must come from live data, not copy.' },
  { re: /\b(rated|voted)\s+#?1\b/i, why: 'Rankings need a verifiable source.' },
  { re: /\b\d{1,3}(,\d{3})*\s+(people|visitors|brands)\s+(are\s+)?(viewing|watching|joined|signed up)\b/i, why: 'Live-activity claims must be computed live, never written into copy.' },
];

/** The words a visitor reads on the page (and its variants): the only thing the lint looks at. */
export function landingCopy(content: unknown, variants: readonly { content: unknown }[] = []): string[] {
  const out: string[] = [];
  const walk = (v: unknown, key = '') => {
    if (typeof v === 'string') {
      // Ids are references, not copy.
      if (!/(Id|Ids|assetId)$/.test(key)) out.push(v);
    } else if (Array.isArray(v)) v.forEach((x) => walk(x, key));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  walk(content);
  for (const v of variants) walk(v.content);
  return out.filter((s) => s.trim());
}

/** Plan 05 §5: no unsubstantiated customer results, no fake social proof or scarcity, no drug/absolute claims. */
export function lintLandingCopy(content: unknown, variants: readonly { content: unknown }[] = []): string[] {
  const copy = landingCopy(content, variants);
  const text = copy.join(' \n ');
  const out = MARKETING_BANNED.filter((b) => b.re.test(text)).map((b) => b.why);
  const scan = scanCreativeText(copy.flatMap((c) => c.split(/(?<=[.!?"])\s+/)).slice(0, 400), []);
  if (!scan.ok) out.push(...scan.violations.map((v) => `“${v.text.slice(0, 60)}”: ${v.reason}`));
  // Plan 04 L14: grade 6–7 readability, per page version (the control and each variant as a visitor reads it).
  const base = content && typeof content === 'object' ? (content as LandingBlocks) : null;
  const versions: [string, unknown][] = [['The page', content], ...(base ? variants.map((v): [string, unknown] => [`Variant ${(v as { key?: string }).key ?? ''}`.trim(), applyLandingVariant(base, v.content as LandingVariantContent)]) : [])];
  for (const [name, c] of versions) {
    const grade = fleschKincaidGrade(landingCopy(c));
    if (grade > MAX_LANDING_GRADE) out.push(`${name} reads at grade ${grade}; keep it at ${MAX_LANDING_GRADE} or below (shorter sentences, plainer words).`);
  }
  return [...new Set(out)];
}

/** Dollar amounts the copy states ("$19", "$49/mo", "$8.50"). */
export const statedPrices = (copy: readonly string[]): number[] =>
  [...copy.join(' ').matchAll(/\$\s?(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?)/g)].map((m) => Number(m[1]!.replace(/,/g, '')));

/**
 * Plan 04 §4 "anchor validity": every price the copy states must be a price a visitor can actually pay today — an
 * active offer, a plan, or the standard one-off prices. A stale "$19" after the offer changed is refused.
 */
export async function landingPriceProblems(tx: Tx, content: unknown, variants: readonly { content: unknown }[] = []): Promise<string[]> {
  const stated = [...new Set(statedPrices(landingCopy(content, variants)))];
  if (!stated.length) return [];
  const offers = await tx`select price_micros from offer_definitions where active`;
  const valid = new Set([...offers.map((o) => Number(o.price_micros)), ...Object.values(PLANS).map((p) => p.priceMicros), PRICES.TASTE, PRICES.STANDALONE].map((m) => Math.round(Number(m) / 10_000)));
  return stated.filter((d) => !valid.has(Math.round(d * 100))).map((d) => `“$${d}” isn’t a price anyone can pay right now (no active offer or plan at that price).`);
}

/** Everything the copy itself must pass (lint, readability, price anchors), on save, rollback and publish. */
async function copyProblems(tx: Tx, draft: LandingDraft): Promise<string[]> {
  return [...lintLandingCopy(draft.content, draft.variants), ...(await landingPriceProblems(tx, draft.content, draft.variants))];
}

// ───────────── Example assets and testimonials ─────────────

/** Visual kinds an example may be (a finished ad, a scene, a storyboard frame or its thumbnail). */
export const EXAMPLE_ASSET_KINDS = ['final_export', 'scene_render', 'storyboard_frame', 'thumbnail'] as const;
/** Categories the product analysis assigns to skincare (anything else is rejected as not skincare). */
export const SKINCARE_CATEGORIES = ['serum', 'cleanser', 'moisturizer', 'eye', 'mask', 'facial_oil', 'toner', 'exfoliant', 'balm', 'skincare'] as const;

export interface AssetProblem {
  assetId: string;
  why: string;
  /** The asset lost its right to be shown (missing, deleted, rights expired): the rights sweep removes these. */
  expired: boolean;
}

/**
 * Plan 05 §5 "example gallery (skincare only; validation rejects non-skincare assets)" and plan 04 L13 "Example ads
 * are labelled 'Example, made for a demo product', never implied as customer results": an example must be a visual
 * made for a skincare product in one of our own internal (test) workspaces — never a customer's asset — and its
 * usage rights must be live. Runs as staff or system (sees every workspace); filtered by the given ids only.
 */
export async function landingAssetProblems(tx: Tx, ids: readonly string[]): Promise<AssetProblem[]> {
  if (!ids.length) return [];
  const rows = await tx`
    select a.id, a.kind, a.mime, a.source, a.rights_attested_at, a.rights_expires_at, a.rights_frozen_at, a.deleted_at,
           a.rights_expires_at is not null and a.rights_expires_at <= now() as rights_expired,
           w.is_test, s.category, s.status as sku_status
    from assets a join workspaces w on w.id = a.workspace_id
    left join skus s on s.id = a.sku_id and s.workspace_id = a.workspace_id
    where a.id in ${tx([...new Set(ids)])}`;
  const byId = new Map(rows.map((r) => [r.id as string, r]));
  const out: AssetProblem[] = [];
  for (const id of new Set(ids)) {
    const a = byId.get(id);
    if (!a) out.push({ assetId: id, why: 'No such asset.', expired: true });
    else if (a.deleted_at) out.push({ assetId: id, why: 'The asset was deleted.', expired: true });
    else if (a.rights_frozen_at) out.push({ assetId: id, why: 'Frozen by an open rights / takedown case.', expired: true });
    else if (a.rights_expired) out.push({ assetId: id, why: `Usage rights expired ${new Date(a.rights_expires_at as string).toISOString().slice(0, 10)}.`, expired: true });
    else if (!a.is_test) out.push({ assetId: id, why: 'Examples must come from an internal demo workspace, never a customer’s.', expired: false });
    else if (!(EXAMPLE_ASSET_KINDS as readonly string[]).includes(a.kind as string) || !/^(image|video)\//.test(a.mime as string)) out.push({ assetId: id, why: `A ${String(a.kind).replace(/_/g, ' ')} can’t be an example; use a finished ad, scene or frame.`, expired: false });
    else if (!a.category || !(SKINCARE_CATEGORIES as readonly string[]).includes(a.category as string) || a.sku_status === 'rejected') out.push({ assetId: id, why: 'Not a skincare product: examples are skincare only.', expired: false });
    else if ((a.source === 'upload' || a.source === 'import') && !a.rights_attested_at) out.push({ assetId: id, why: 'Uploaded footage needs a rights attestation before it can be shown.', expired: false });
  }
  return out;
}

/**
 * Signed, short-lived URLs for the example assets a page shows, re-checked at render time: an asset that stopped
 * qualifying (rights expired before the sweep ran, deleted) is simply not shown. System role (the examples live in
 * our internal demo workspace), filtered by the page's own asset ids.
 */
export async function landingExampleUrls(tx: Tx, ids: readonly string[], ttlSeconds = 3600): Promise<Map<string, { url: string; mime: string }>> {
  const out = new Map<string, { url: string; mime: string }>();
  if (!ids.length) return out;
  const bad = new Set((await landingAssetProblems(tx, ids)).map((p) => p.assetId));
  const ok = ids.filter((id) => !bad.has(id));
  if (!ok.length) return out;
  const rows = await tx`select id, storage_key, mime from assets where id in ${tx([...new Set(ok)])} and deleted_at is null`;
  for (const r of rows) out.set(r.id as string, { url: await storage().signedGetUrl(r.storage_key as string, ttlSeconds), mime: r.mime as string });
  return out;
}

/**
 * The same, for the public landing page, which runs as the app role: the example rows come from the narrow
 * landing_example_assets() database function (the same rules as landingAssetProblems, in SQL), never a
 * cross-tenant read.
 */
export async function publicExampleUrls(tx: Tx, ids: readonly string[], ttlSeconds = 3600): Promise<Map<string, { url: string; mime: string }>> {
  const out = new Map<string, { url: string; mime: string }>();
  if (!ids.length) return out;
  const rows = await tx`select id, storage_key, mime from landing_example_assets(${[...new Set(ids)]}::uuid[])`;
  for (const r of rows) out.set(r.id as string, { url: await storage().signedGetUrl(r.storage_key as string, ttlSeconds), mime: r.mime as string });
  return out;
}

/** Claims checked across the platform in the last 7 days (a count only), for the landing proof line. */
export async function claimsCheckedLast7Days(tx: Tx): Promise<number> {
  const [r] = await tx`select landing_claims_checked_7d() as n`;
  return Number(r?.n ?? 0);
}

/** Testimonials must link to a stored consent record that hasn't been revoked (FTC 16 CFR 465, plan 04 §4). */
export async function testimonialProblems(tx: Tx, ids: readonly string[]): Promise<string[]> {
  if (!ids.length) return [];
  const rows = await tx`select id, revoked_at, consent_document from testimonials where id in ${tx([...new Set(ids)])}`;
  const out: string[] = [];
  for (const id of new Set(ids)) {
    const t = rows.find((r) => r.id === id);
    if (!t) out.push(`Testimonial ${id.slice(0, 8)} has no stored consent record.`);
    else if (t.revoked_at) out.push(`Testimonial ${id.slice(0, 8)}: consent was revoked.`);
    else if (!String(t.consent_document ?? '').trim()) out.push(`Testimonial ${id.slice(0, 8)} has no consent document.`);
  }
  return out;
}

export interface LandingDraft {
  content: LandingBlocks;
  variants: LandingVariant[];
}

/** Parse a draft into blocks (strict: structured blocks only, no extra keys, no HTML). */
export function parseLandingDraft(content: unknown, variants: unknown = []): LandingDraft {
  const c = LandingBlocks.safeParse(content);
  if (!c.success) throw new DomainError('INVALID', `Content blocks: ${c.error.issues.map((i) => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')}`);
  const v = LandingVariant.array().max(5).safeParse(variants);
  if (!v.success) throw new DomainError('INVALID', `Variants: ${v.error.issues.map((i) => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')}`);
  const keys = v.data.map((x) => x.key);
  if (new Set(keys).size !== keys.length) throw new DomainError('INVALID', 'Variant keys must be unique.');
  if (keys.includes('control')) throw new DomainError('INVALID', '“control” is the page without overrides; name variants something else.');
  const html = landingCopy(c.data, v.data).find((s) => /<\s*\/?\s*[a-z][^>]*>/i.test(s));
  if (html) throw new DomainError('INVALID', `Blocks take plain text only (no HTML): “${html.slice(0, 40)}”.`);
  return { content: c.data, variants: v.data };
}

/** Everything that must hold before a draft reaches the public page. Throws GATE_BLOCKED with every problem. */
export async function assertPublishable(tx: Tx, draft: LandingDraft): Promise<void> {
  const problems = (await copyProblems(tx, draft)).map((p) => `Compliance lint: ${p}`);
  for (const v of draft.variants) {
    const merged = applyLandingVariant(draft.content, v.content);
    if (!merged.hero.headline.trim()) problems.push(`Variant ${v.key} has no headline.`);
  }
  for (const a of await landingAssetProblems(tx, landingAssetIds(draft.content, draft.variants))) problems.push(`Example ${a.assetId.slice(0, 8)}: ${a.why}`);
  problems.push(...(await testimonialProblems(tx, landingTestimonialIds(draft.content, draft.variants))));
  if (problems.length) throw new DomainError('GATE_BLOCKED', problems.join(' '), { problems });
}

// ───────────── Save, publish, rollback ─────────────

interface HistoryEntry {
  version: number;
  content: unknown;
  variants: unknown;
  at: string;
  by: string;
  published?: boolean;
  note?: string;
}

const pageRow = async (tx: Tx, slug: string) => {
  const [p] = await tx`select * from landing_pages where slug = ${slug} for update`;
  if (!p) throw new DomainError('NOT_FOUND', 'Page not found');
  return p;
};

/** A published copy that changed from the draft stays visible (history) with the version it had. */
const snapshot = (p: Record<string, unknown>, by: string, note?: string): HistoryEntry => ({
  version: Number(p.version),
  content: p.content,
  variants: p.variants,
  at: new Date().toISOString(),
  by,
  published: p.live_version != null && Number(p.live_version) === Number(p.version),
  ...(note ? { note } : {}),
});

export interface LandingSaveInput {
  slug: string;
  archetype: string;
  content: unknown;
  variants: unknown;
  utmMatch: string[];
  experiment?: LandingExperiment;
}

/**
 * Save the draft (versioned). The lint runs here too so problems surface while editing; nothing reaches visitors
 * until publish. The experiment's primary metric and minimum sample are pre-registered: they can't change while
 * a live page is running variants.
 */
export async function saveLandingDraft(tx: Tx, s: Staff, i: LandingSaveInput) {
  const draft = parseLandingDraft(i.content, i.variants);
  const lint = await copyProblems(tx, draft);
  if (lint.length) throw new DomainError('GATE_BLOCKED', `Compliance lint: ${lint.join(' ')}`, { problems: lint });
  const experiment = i.experiment ? LandingExperiment.parse(i.experiment) : undefined;
  const [before] = await tx`select * from landing_pages where slug = ${i.slug} for update`;
  if (before) {
    const cur = { ...DEFAULT_LANDING_EXPERIMENT, ...((before.experiment as object) ?? {}) } as LandingExperiment;
    const running = before.status === 'live' && ((before.live_variants as unknown[]) ?? []).length > 0;
    if (experiment && running && (experiment.primaryMetric !== cur.primaryMetric || experiment.minSample !== cur.minSample)) {
      throw new DomainError('CONFLICT', `The primary metric (${cur.primaryMetric.replace('_', ' ')}, ${cur.minSample} per variant) is pre-registered while variants run. Pause the page, or publish without variants, to register a new one.`);
    }
    await tx`update landing_pages set archetype = ${i.archetype}, content = ${tx.json(draft.content as never)}, variants = ${tx.json(draft.variants as never)},
               utm_match = ${i.utmMatch}, experiment = ${tx.json((experiment ?? cur) as never)}, version = version + 1,
               history = history || ${tx.json([snapshot(before, s.email)] as never)}, updated_at = now()
             where slug = ${i.slug}`;
  } else {
    await tx`insert into landing_pages (slug, archetype, status, content, variants, utm_match, experiment)
             values (${i.slug}, ${i.archetype}, 'draft', ${tx.json(draft.content as never)}, ${tx.json(draft.variants as never)}, ${i.utmMatch},
                     ${tx.json((experiment ?? DEFAULT_LANDING_EXPERIMENT) as never)})`;
  }
  await audit(tx, s, 'lp.save', { type: 'landing_page', id: i.slug }, { before: before ? { version: before.version, content: before.content, variants: before.variants } : null, after: { content: draft.content, variants: draft.variants, experiment } });
  return { version: before ? Number(before.version) + 1 : 1, created: !before };
}

/**
 * Publish the current draft: lint, example assets and testimonial consent are checked again (a draft saved before a
 * testimonial was revoked, or an asset's rights expired, must not go live), then the draft becomes the live copy.
 */
export async function publishLanding(tx: Tx, s: Staff, slug: string) {
  const p = await pageRow(tx, slug);
  const draft = parseLandingDraft(landingBlocksFrom(p.content), ((p.variants as unknown[]) ?? []).map((v) => ({ ...(v as object), content: landingVariantFrom((v as { content?: unknown }).content) })));
  await assertPublishable(tx, draft);
  await tx`update landing_pages set status = 'live', live_content = ${tx.json(draft.content as never)}, live_variants = ${tx.json(draft.variants as never)},
             live_version = version, published_at = now(), updated_at = now() where slug = ${slug}`;
  await audit(tx, s, 'lp.publish', { type: 'landing_page', id: slug }, { before: { status: p.status, liveVersion: p.live_version, content: p.live_content, variants: p.live_variants }, after: { status: 'live', liveVersion: p.version } });
  return { version: Number(p.version) };
}

/** Draft (not live, not linked from ads) or paused (302 to the default page, UTMs kept). The default page stays live. */
export async function setLandingStatus(tx: Tx, s: Staff, slug: string, status: 'draft' | 'paused') {
  if (slug === 'default') throw new DomainError('CONFLICT', 'The default page must stay live (paused pages redirect to it).');
  const p = await pageRow(tx, slug);
  await tx`update landing_pages set status = ${status}, updated_at = now() where slug = ${slug}`;
  await audit(tx, s, 'lp.status', { type: 'landing_page', id: slug }, { before: { status: p.status }, after: { status } });
}

/**
 * One-click rollback to an earlier version: it becomes the new draft version (history keeps every version, with
 * its variants), and on a live page it is published at once — after the same checks as any publish.
 */
export async function rollbackLanding(tx: Tx, s: Staff, slug: string, version: number) {
  const p = await pageRow(tx, slug);
  const h = ((p.history as HistoryEntry[]) ?? []).find((x) => x.version === version);
  if (!h) throw new DomainError('NOT_FOUND', 'Version not found');
  const draft = parseLandingDraft(landingBlocksFrom(h.content), ((h.variants as unknown[]) ?? []).map((v) => ({ ...(v as object), content: landingVariantFrom((v as { content?: unknown }).content) })));
  const live = p.status === 'live';
  if (live) await assertPublishable(tx, draft);
  else {
    const lint = await copyProblems(tx, draft);
    if (lint.length) throw new DomainError('GATE_BLOCKED', `Compliance lint: ${lint.join(' ')}`, { problems: lint });
  }
  const next = Number(p.version) + 1;
  await tx`update landing_pages set content = ${tx.json(draft.content as never)}, variants = ${tx.json(draft.variants as never)}, version = ${next},
             history = history || ${tx.json([snapshot(p, s.email)] as never)},
             live_content = case when ${live} then ${tx.json(draft.content as never)} else live_content end,
             live_variants = case when ${live} then ${tx.json(draft.variants as never)} else live_variants end,
             live_version = case when ${live} then ${next} else live_version end,
             published_at = case when ${live} then now() else published_at end, updated_at = now()
           where slug = ${slug}`;
  await audit(tx, s, 'lp.rollback', { type: 'landing_page', id: slug }, { before: { version: p.version, liveVersion: p.live_version }, after: { toVersion: version, newVersion: next, published: live } });
  return { version: next, published: live };
}

// ───────────── Diff (draft vs published) ─────────────

export interface LandingChange {
  path: string;
  before: string | null;
  after: string | null;
}

function flatten(v: unknown, prefix = '', out: Map<string, string> = new Map()): Map<string, string> {
  if (Array.isArray(v)) v.forEach((x, i) => flatten(x, `${prefix}[${i}]`, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) flatten(x, prefix ? `${prefix}.${k}` : k, out);
  else if (v !== undefined && v !== null && v !== '') out.set(prefix, String(v));
  return out;
}

/** Field-level differences between two versions (content and variants), for the publish review. */
export function diffLanding(before: { content: unknown; variants: unknown } | null, after: { content: unknown; variants: unknown }): LandingChange[] {
  const a = flatten({ content: before?.content ?? {}, variants: before?.variants ?? [] });
  const b = flatten({ content: after.content, variants: after.variants });
  const out: LandingChange[] = [];
  for (const k of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(k) ?? null;
    const y = b.get(k) ?? null;
    if (x !== y) out.push({ path: k, before: x, after: y });
  }
  return out.sort((m, n) => m.path.localeCompare(n.path, 'en', { numeric: true }));
}

// ───────────── Draft preview (signed) ─────────────

const previewSig = (slug: string, exp: string) => createHmac('sha256', env().APP_SECRET).update(`lp-preview:${slug}:${exp}`).digest('base64url');

/** A short-lived token that lets the console frame a page's draft (phone and desktop previews). */
export function landingPreviewToken(slug: string, ttlSeconds = 3600, now = Date.now()): string {
  const exp = String(Math.floor(now / 1000) + ttlSeconds);
  return `${exp}.${previewSig(slug, exp)}`;
}

export function verifyLandingPreviewToken(slug: string, token: string | null | undefined, now = Date.now()): boolean {
  const [exp, sig] = String(token ?? '').split('.');
  if (!exp || !sig || !/^\d+$/.test(exp) || Number(exp) < now / 1000) return false;
  const want = Buffer.from(previewSig(slug, exp));
  const got = Buffer.from(sig);
  return want.length === got.length && timingSafeEqual(want, got);
}

// ───────────── Results: traffic, upload-start %, Taste CVR ─────────────

export interface LandingVariantStats {
  page: string;
  variant: string;
  /** Distinct visitors who viewed the page (any touch) in the window. */
  views: number;
  /** Visitors whose first touch was this page/variant in the window (the denominator for both rates). */
  visitors: number;
  uploads: number;
  taste: number;
}

/**
 * Per page and variant over the last `days`: traffic, and first-touch attribution of upload starts and Taste
 * purchases (a visitor counts for the first page and variant they landed on). Funnel events are global
 * (pre-tenant visitors); staff read them.
 */
export async function landingStats(tx: Tx, opts: { days: number; slug?: string | null }): Promise<LandingVariantStats[]> {
  const slug = opts.slug ?? null;
  const rows = await tx`
    with first_touch as (
      select distinct on (visitor_id) visitor_id, page, coalesce(variant, 'control') as variant, at
      from funnel_events where type = 'LP_VIEWED' and visitor_id is not null and page is not null
      order by visitor_id, at, id),
    cohort as (select * from first_touch where at > now() - make_interval(days => ${opts.days}) and (${slug}::text is null or page = ${slug})),
    conv as (
      select c.page, c.variant, count(*)::int as visitors,
        count(*) filter (where exists (select 1 from funnel_events u where u.type = 'UPLOAD_STARTED' and u.visitor_id = c.visitor_id and u.at >= c.at))::int as uploads,
        count(*) filter (where exists (select 1 from funnel_events t where t.type = 'TASTE_PAID' and t.visitor_id = c.visitor_id and t.at >= c.at))::int as taste
      from cohort c group by 1, 2),
    views as (
      select page, coalesce(variant, 'control') as variant, count(distinct visitor_id)::int as views from funnel_events
      where type = 'LP_VIEWED' and page is not null and at > now() - make_interval(days => ${opts.days}) and (${slug}::text is null or page = ${slug}) group by 1, 2)
    select coalesce(v.page, c.page) as page, coalesce(v.variant, c.variant) as variant, coalesce(v.views, 0) as views,
           coalesce(c.visitors, 0) as visitors, coalesce(c.uploads, 0) as uploads, coalesce(c.taste, 0) as taste
    from views v full join conv c on c.page = v.page and c.variant = v.variant
    order by 1, 2`;
  return rows.map((r) => ({ page: r.page as string, variant: r.variant as string, views: Number(r.views), visitors: Number(r.visitors), uploads: Number(r.uploads), taste: Number(r.taste) }));
}

/** Page totals across variants. */
export function landingTotals(rows: readonly LandingVariantStats[]): Map<string, { views: number; visitors: number; uploads: number; taste: number }> {
  const m = new Map<string, { views: number; visitors: number; uploads: number; taste: number }>();
  for (const r of rows) {
    const t = m.get(r.page) ?? { views: 0, visitors: 0, uploads: 0, taste: 0 };
    t.views += r.views;
    t.visitors += r.visitors;
    t.uploads += r.uploads;
    t.taste += r.taste;
    m.set(r.page, t);
  }
  return m;
}

export interface VariantVerdictRow {
  variant: string;
  trials: number;
  successes: number;
  raw: number | null;
  /** Shrunk estimate (Beta-Binomial toward the page's pooled rate). */
  estimate: number;
  ciLow: number;
  ciHigh: number;
  probBest: number;
  enough: boolean;
}

export interface VariantVerdict {
  metric: LandingExperiment['primaryMetric'];
  minSample: number;
  state: 'gathering' | 'no_winner' | 'winner';
  winner: string | null;
  rows: VariantVerdictRow[];
}

/** Probability a variant must have of being best before it gets the badge. */
export const LANDING_WINNER_PROB = 0.95;

/**
 * The winner badge (plan 05 §5, standard §21): only on the pre-registered primary metric, only when every variant
 * has the minimum sample, and only for a variant that is ≥95% likely to be best under shrunk (Beta-Binomial)
 * estimates — never from a tiny sample.
 */
export function landingVerdict(rows: readonly { variant: string; visitors: number; uploads: number; taste: number }[], experiment: LandingExperiment): VariantVerdict {
  const success = (r: { uploads: number; taste: number }) => (experiment.primaryMetric === 'upload_start' ? r.uploads : r.taste);
  const trials = rows.reduce((a, r) => a + r.visitors, 0);
  const wins = rows.reduce((a, r) => a + success(r), 0);
  // Shrink toward the page's pooled rate; before any data, toward a conservative prior.
  const base = { rate: trials ? Math.min(0.99, Math.max(0.001, wins / trials)) : experiment.primaryMetric === 'upload_start' ? 0.2 : 0.02, strength: Math.max(20, experiment.minSample / 4) };
  const posts = rows.map((r) => posterior({ successes: success(r), trials: r.visitors }, base));
  const pb = rows.length > 1 ? probBest(posts) : rows.map(() => 1);
  const out: VariantVerdictRow[] = rows.map((r, i) => ({
    variant: r.variant,
    trials: r.visitors,
    successes: success(r),
    raw: posts[i]!.raw,
    estimate: posts[i]!.mean,
    ciLow: posts[i]!.ciLow,
    ciHigh: posts[i]!.ciHigh,
    probBest: pb[i]!,
    enough: r.visitors >= experiment.minSample,
  }));
  if (out.length < 2 || !out.every((r) => r.enough)) return { metric: experiment.primaryMetric, minSample: experiment.minSample, state: 'gathering', winner: null, rows: out };
  const lead = out.reduce((a, b) => (b.probBest > a.probBest ? b : a));
  const winner = lead.probBest >= LANDING_WINNER_PROB ? lead.variant : null;
  return { metric: experiment.primaryMetric, minSample: experiment.minSample, state: winner ? 'winner' : 'no_winner', winner, rows: out };
}

// ───────────── Rights sweep ─────────────

function withoutAssets(content: unknown, gone: ReadonlySet<string>): { content: LandingBlocks; removed: string[] } {
  const c = landingBlocksFrom(content);
  const removed: string[] = [];
  const items = c.gallery.items.filter((g) => {
    if (!gone.has(g.assetId)) return true;
    removed.push(g.assetId);
    return false;
  });
  let hero = c.hero;
  if (hero.visualAssetId && gone.has(hero.visualAssetId)) {
    removed.push(hero.visualAssetId);
    hero = { ...hero, visualAssetId: null, visualCaption: '' };
  }
  return { content: { ...c, hero, gallery: { items } }, removed };
}

function variantsWithoutAssets(variants: unknown, gone: ReadonlySet<string>): { variants: { key: string; weight: number; content: LandingVariantContent }[]; removed: string[] } {
  const removed: string[] = [];
  const out = ((variants as { key: string; weight: number; content: unknown }[]) ?? []).map((v) => {
    const content = landingVariantFrom(v.content);
    const id = content.hero?.visualAssetId;
    if (id && gone.has(id)) {
      removed.push(id);
      return { ...v, content: { ...content, hero: { ...content.hero, visualAssetId: null } } };
    }
    return { ...v, content };
  });
  return { variants: out, removed };
}

/**
 * Plan 05 §5 edge case: "an example asset whose rights expire auto-unpublishes from the gallery". Removes such
 * assets (rights expired, deleted, gone) from every page's draft and published copy as a new version, and raises
 * a Pulse alert per page. System role: reads assets only by the ids the pages reference.
 */
export async function sweepLandingGalleryRights(tx: Tx): Promise<{ slug: string; removed: string[] }[]> {
  const pages = await tx`select slug, status, content, variants, live_content, live_variants, version, live_version from landing_pages for update`;
  const ids = new Set<string>();
  for (const p of pages) {
    for (const [c, v] of [[p.content, p.variants], [p.live_content, p.live_variants]] as const) {
      if (!c) continue;
      const vs = ((v as { content: unknown }[]) ?? []).map((x) => ({ content: landingVariantFrom(x.content) }));
      for (const id of landingAssetIds(landingBlocksFrom(c), vs)) ids.add(id);
    }
  }
  const gone = new Set((await landingAssetProblems(tx, [...ids])).filter((a) => a.expired).map((a) => a.assetId));
  if (!gone.size) return [];
  const changed: { slug: string; removed: string[] }[] = [];
  for (const p of pages) {
    const draft = withoutAssets(p.content, gone);
    const draftV = variantsWithoutAssets(p.variants, gone);
    const live = p.live_content ? withoutAssets(p.live_content, gone) : null;
    const liveV = variantsWithoutAssets(p.live_variants, gone);
    const removed = [...new Set([...draft.removed, ...draftV.removed, ...(live?.removed ?? []), ...liveV.removed])];
    if (!removed.length) continue;
    const liveChanged = !!live && live.removed.length + liveV.removed.length > 0;
    const next = Number(p.version) + 1;
    const entry: HistoryEntry = { version: Number(p.version), content: p.content, variants: p.variants, at: new Date().toISOString(), by: 'system:rights-sweep', published: p.live_version != null && Number(p.live_version) === Number(p.version), note: `Removed examples whose rights expired: ${removed.join(', ')}` };
    await tx`update landing_pages set content = ${tx.json(draft.content as never)}, variants = ${tx.json(draftV.variants as never)}, version = ${next},
               history = history || ${tx.json([entry] as never)},
               live_content = ${live ? tx.json(live.content as never) : null}, live_variants = ${tx.json(liveV.variants as never)},
               -- The live copy stays "the draft as published" only if it was before (unpublished edits stay unpublished).
               live_version = case when ${liveChanged} and live_version = version then ${next} else live_version end, updated_at = now()
             where slug = ${p.slug}`;
    await raiseAlert(tx, {
      kind: 'landing.example_rights_expired',
      severity: 'warn',
      subject: { type: 'landing_page', id: p.slug as string },
      message: `/${p.slug}: ${removed.length} example${removed.length === 1 ? '' : 's'} removed (rights expired or asset gone).${liveChanged ? ' The live page was updated.' : ''}`,
      details: { removed, version: next, live: liveChanged },
    });
    changed.push({ slug: p.slug as string, removed });
  }
  return changed;
}
