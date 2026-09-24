import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool, withAdmin, withSystem } from '@arkiv/db';
import { makeSku, makeTenant, truncateAll } from '@arkiv/db/testing';
import { DEFAULT_LANDING_BLOCKS, landingBlocksFrom, newId, type LandingBlocks, type StaffRole } from '@arkiv/shared';
import type { Staff } from './admin';
import {
  diffLanding,
  landingAssetProblems,
  landingPreviewToken,
  landingStats,
  landingVerdict,
  lintLandingCopy,
  parseLandingDraft,
  publishLanding,
  rollbackLanding,
  saveLandingDraft,
  setLandingStatus,
  sweepLandingGalleryRights,
  verifyLandingPreviewToken,
} from './landing';

beforeEach(truncateAll);
afterAll(closeAll);

const slugs: string[] = [];
afterEach(async () => {
  // landing_pages is reference data (not truncated): remove the pages these tests created.
  if (slugs.length) await ownerPool()`delete from landing_pages where slug in ${ownerPool()(slugs.splice(0))}`;
});

async function staff(roles: StaffRole[] = ['GROWTH']): Promise<Staff> {
  const id = newId();
  await ownerPool()`insert into staff_users (id, email, name, password_hash, roles) values (${id}, ${`${id.slice(-6)}@arkiv.test`}, 'Growth', 'x', ${roles})`;
  return { staffId: id, email: `${id.slice(-6)}@arkiv.test`, name: 'Growth', roles };
}

const blocks = (patch: Partial<LandingBlocks> = {}): LandingBlocks => ({ ...structuredClone(DEFAULT_LANDING_BLOCKS), ...patch });
const newSlug = () => {
  const s = `t-${newId().slice(-10)}`;
  slugs.push(s);
  return s;
};

/** A visual asset in a workspace (demo workspaces are is_test). */
async function asset(opts: { demo?: boolean; category?: string; kind?: string; rightsExpire?: string | null; deleted?: boolean } = {}) {
  const t = await makeTenant();
  if (opts.demo !== false) await ownerPool()`update workspaces set is_test = true where id = ${t.workspaceId}`;
  const sku = await makeSku(t.workspaceId, 'Demo Serum');
  await ownerPool()`update skus set category = ${opts.category ?? 'serum'} where id = ${sku}`;
  const id = newId();
  await ownerPool()`insert into assets (id, workspace_id, sku_id, kind, storage_key, mime, bytes, checksum_sha256, source, rights_expires_at, deleted_at)
                    values (${id}, ${t.workspaceId}, ${sku}, ${opts.kind ?? 'final_export'}, ${`t/${t.workspaceId}/${id}.mp4`}, 'video/mp4', 10, 'x', 'composed',
                            ${opts.rightsExpire ?? null}, ${opts.deleted ? new Date() : null})`;
  return id;
}

describe('landing blocks (plan 05 §5)', () => {
  it('the standard copy passes the lint; unsubstantiated results, scarcity and drug claims do not', () => {
    expect(lintLandingCopy(DEFAULT_LANDING_BLOCKS)).toEqual([]);
    expect(lintLandingCopy(blocks({ hero: { ...DEFAULT_LANDING_BLOCKS.hero, headline: 'Brands see 3x ROAS' } })).join(' ')).toMatch(/substantiation/);
    expect(lintLandingCopy(blocks({ cta: { label: 'Only 3 spots left', assurance: '' } })).join(' ')).toMatch(/Scarcity/);
    // Variant copy is linted too.
    expect(lintLandingCopy(DEFAULT_LANDING_BLOCKS, [{ content: { hero: { sub: 'Our serum cures acne.' } } }]).length).toBeGreaterThan(0);
    // Ids are not copy.
    expect(lintLandingCopy(blocks({ proof: { text: 'Built only for skincare brands', testimonialIds: [newId()] } }))).toEqual([]);
  });

  it('accepts structured blocks only: no HTML, no unknown blocks, 3–6 examples or none', () => {
    expect(() => parseLandingDraft({ ...DEFAULT_LANDING_BLOCKS, html: '<b>x</b>' })).toThrow(/Content blocks/);
    expect(() => parseLandingDraft(blocks({ hero: { ...DEFAULT_LANDING_BLOCKS.hero, headline: 'Hello <script>alert(1)</script>' } }))).toThrow(/plain text only/);
    expect(() => parseLandingDraft(blocks({ gallery: { items: [{ assetId: newId(), caption: 'Example' }] } }))).toThrow(/3–6 examples/);
    expect(() => parseLandingDraft(DEFAULT_LANDING_BLOCKS, [{ key: 'b', weight: 1, content: {} }, { key: 'b', weight: 1, content: {} }])).toThrow(/unique/);
    expect(parseLandingDraft(DEFAULT_LANDING_BLOCKS, [{ key: 'b', weight: 1, content: { hero: { headline: 'Texture ads that sell serum' } } }]).variants[0]!.content.hero?.headline).toBe('Texture ads that sell serum');
  });

  it('reads pages saved before blocks existed', () => {
    const b = landingBlocksFrom({ label: 'L', headline: 'Old headline', sub: 'Old sub', proof: 'Old proof' });
    expect(b.hero).toMatchObject({ label: 'L', headline: 'Old headline', sub: 'Old sub' });
    expect(b.proof.text).toBe('Old proof');
    expect(b.faq).toEqual(DEFAULT_LANDING_BLOCKS.faq);
  });

  it('example assets must be skincare visuals from an internal demo workspace with live rights', async () => {
    const ok = await asset();
    const customer = await asset({ demo: false });
    const notSkin = await asset({ category: 'not_skincare' });
    const photo = await asset({ kind: 'product_photo' });
    const expired = await asset({ rightsExpire: '2020-01-01' });
    const deleted = await asset({ deleted: true });
    const problems = await withAdmin((tx) => landingAssetProblems(tx, [ok, customer, notSkin, photo, expired, deleted, newId()]));
    const why = (id: string) => problems.find((p) => p.assetId === id);
    expect(why(ok)).toBeUndefined();
    expect(why(customer)?.why).toMatch(/never a customer/);
    expect(why(notSkin)?.why).toMatch(/skincare only/);
    expect(why(photo)?.why).toMatch(/can’t be an example/);
    expect(why(expired)).toMatchObject({ expired: true });
    expect(why(deleted)).toMatchObject({ expired: true });
    expect(problems.filter((p) => p.expired)).toHaveLength(3);
  });
});

describe('landing publishing (plan 05 §5)', () => {
  it('saves drafts, publishes only after the checks, keeps variants in history and rolls back in one click', async () => {
    const s = await staff();
    const slug = newSlug();
    await withAdmin((tx) => saveLandingDraft(tx, s, { slug, archetype: 'serum_launch', content: DEFAULT_LANDING_BLOCKS, variants: [], utmMatch: [] }));
    let [p] = await ownerPool()`select status, version, live_version, live_content from landing_pages where slug = ${slug}`;
    expect(p).toMatchObject({ status: 'draft', version: 1, live_version: null, live_content: null });

    await withAdmin((tx) => publishLanding(tx, s, slug));
    [p] = await ownerPool()`select status, version, live_version from landing_pages where slug = ${slug}`;
    expect(p).toMatchObject({ status: 'live', version: 1, live_version: 1 });

    // v2 adds a variant; the live page doesn't change until publish.
    const v2 = blocks({ hero: { ...DEFAULT_LANDING_BLOCKS.hero, headline: 'Serum launch ads, made this week.' } });
    await withAdmin((tx) => saveLandingDraft(tx, s, { slug, archetype: 'serum_launch', content: v2, variants: [{ key: 'b', weight: 1, content: { hero: { headline: 'Launch your serum with a tested ad.' } } }], utmMatch: [] }));
    [p] = await ownerPool()`select version, live_version, live_content->'hero'->>'headline' as live_headline from landing_pages where slug = ${slug}`;
    expect(p).toMatchObject({ version: 2, live_version: 1, live_headline: DEFAULT_LANDING_BLOCKS.hero.headline });
    await withAdmin((tx) => publishLanding(tx, s, slug));

    // v3 drops the variant; rolling back to v2 brings the variant back and publishes it.
    await withAdmin((tx) => saveLandingDraft(tx, s, { slug, archetype: 'serum_launch', content: v2, variants: [], utmMatch: [] }));
    await withAdmin((tx) => publishLanding(tx, s, slug));
    const r = await withAdmin((tx) => rollbackLanding(tx, s, slug, 2));
    expect(r).toEqual({ version: 4, published: true });
    [p] = await ownerPool()`select version, live_version, variants, live_variants, history from landing_pages where slug = ${slug}`;
    expect(p!.live_version).toBe(4);
    expect((p!.variants as { key: string }[]).map((v) => v.key)).toEqual(['b']);
    expect((p!.live_variants as { key: string }[]).map((v) => v.key)).toEqual(['b']);
    // Every history entry carries its variants (a rollback to it can't drop them).
    for (const h of p!.history as { variants?: unknown }[]) expect(Array.isArray(h.variants)).toBe(true);
    const audits = await ownerPool()`select action from admin_audit_log where target_id = ${slug} order by id`;
    expect(audits.map((a) => a.action)).toEqual(['lp.save', 'lp.publish', 'lp.save', 'lp.publish', 'lp.save', 'lp.publish', 'lp.rollback']);
  });

  it('never bypasses the lint: publish, status → live and rollback all check it', async () => {
    const s = await staff();
    const slug = newSlug();
    await expect(withAdmin((tx) => saveLandingDraft(tx, s, { slug, archetype: 'general', content: blocks({ hero: { ...DEFAULT_LANDING_BLOCKS.hero, headline: 'Guaranteed 5x ROAS' } }), variants: [], utmMatch: [] }))).rejects.toThrow(/Compliance lint/);
    await withAdmin((tx) => saveLandingDraft(tx, s, { slug, archetype: 'general', content: DEFAULT_LANDING_BLOCKS, variants: [], utmMatch: [] }));
    await withAdmin((tx) => publishLanding(tx, s, slug));
    // A version that predates the lint (written straight to the table) can't be rolled back onto the live page.
    await ownerPool()`update landing_pages set history = history || ${ownerPool().json([{ version: 0, content: { label: 'x', headline: 'Brands see 3x ROAS', sub: '', proof: '' }, variants: [], at: new Date().toISOString(), by: 'old' }] as never)} where slug = ${slug}`;
    await expect(withAdmin((tx) => rollbackLanding(tx, s, slug, 0))).rejects.toThrow(/Compliance lint/);
    // Nor published from a draft edited outside the editor.
    await ownerPool()`update landing_pages set content = jsonb_set(content, '{hero,headline}', '"Brands see 3x ROAS"') where slug = ${slug}`;
    await expect(withAdmin((tx) => publishLanding(tx, s, slug))).rejects.toThrow(/Compliance lint/);
    const [p] = await ownerPool()`select live_content->'hero'->>'headline' as h from landing_pages where slug = ${slug}`;
    expect(p!.h).toBe(DEFAULT_LANDING_BLOCKS.hero.headline);
  });

  it('testimonials need an unrevoked consent record; examples are re-checked at publish', async () => {
    const s = await staff();
    const slug = newSlug();
    const [t] = await ownerPool()`insert into testimonials (quote, person_name, consent_document, consent_given_at) values ('It found the claim we could not use.', 'Ana', 'consent/ana.pdf', now()) returning id`;
    const withQuote = blocks({ proof: { text: 'Built only for skincare brands', testimonialIds: [t!.id as string] } });
    await withAdmin((tx) => saveLandingDraft(tx, s, { slug, archetype: 'general', content: withQuote, variants: [], utmMatch: [] }));
    await ownerPool()`update testimonials set revoked_at = now() where id = ${t!.id}`;
    await expect(withAdmin((tx) => publishLanding(tx, s, slug))).rejects.toThrow(/consent was revoked/);
    await expect(withAdmin((tx) => saveLandingDraft(tx, s, { slug, archetype: 'general', content: blocks({ proof: { text: 'x', testimonialIds: [newId()] } }), variants: [], utmMatch: [] }).then(() => publishLanding(tx, s, slug)))).rejects.toThrow(/no stored consent record/);

    const customer = await asset({ demo: false });
    const ok = [await asset(), await asset()];
    await withAdmin((tx) => saveLandingDraft(tx, s, { slug, archetype: 'general', content: blocks({ gallery: { items: [...ok, customer].map((assetId) => ({ assetId, caption: 'Example, demo serum' })) } }), variants: [], utmMatch: [] }));
    await expect(withAdmin((tx) => publishLanding(tx, s, slug))).rejects.toThrow(/never a customer/);
  });

  it('pre-registers the primary metric while live variants run; the default page stays live', async () => {
    const s = await staff();
    const slug = newSlug();
    const variants = [{ key: 'a', weight: 1, content: {} }, { key: 'b', weight: 1, content: { hero: { headline: 'Texture-first ads for your serum.' } } }];
    await withAdmin((tx) => saveLandingDraft(tx, s, { slug, archetype: 'general', content: DEFAULT_LANDING_BLOCKS, variants, utmMatch: [], experiment: { primaryMetric: 'taste_cvr', minSample: 500 } }));
    await withAdmin((tx) => publishLanding(tx, s, slug));
    await expect(withAdmin((tx) => saveLandingDraft(tx, s, { slug, archetype: 'general', content: DEFAULT_LANDING_BLOCKS, variants, utmMatch: [], experiment: { primaryMetric: 'upload_start', minSample: 500 } }))).rejects.toThrow(/pre-registered/);
    // Unchanged metric saves fine; after pausing it can be re-registered.
    await withAdmin((tx) => saveLandingDraft(tx, s, { slug, archetype: 'general', content: DEFAULT_LANDING_BLOCKS, variants, utmMatch: [], experiment: { primaryMetric: 'taste_cvr', minSample: 500 } }));
    await withAdmin((tx) => setLandingStatus(tx, s, slug, 'paused'));
    await withAdmin((tx) => saveLandingDraft(tx, s, { slug, archetype: 'general', content: DEFAULT_LANDING_BLOCKS, variants, utmMatch: [], experiment: { primaryMetric: 'upload_start', minSample: 800 } }));
    const [p] = await ownerPool()`select experiment from landing_pages where slug = ${slug}`;
    expect(p!.experiment).toEqual({ primaryMetric: 'upload_start', minSample: 800 });
    await expect(withAdmin((tx) => setLandingStatus(tx, s, 'default', 'paused'))).rejects.toThrow(/must stay live/);
  });

  it('diffs draft against live field by field', () => {
    const live = { content: DEFAULT_LANDING_BLOCKS, variants: [] };
    const draft = { content: blocks({ hero: { ...DEFAULT_LANDING_BLOCKS.hero, headline: 'New headline here' }, faq: DEFAULT_LANDING_BLOCKS.faq.slice(0, 4) }), variants: [{ key: 'b', weight: 1, content: { hero: { sub: 'Variant sub' } } }] };
    const d = diffLanding(live, draft);
    expect(d.find((c) => c.path === 'content.hero.headline')).toEqual({ path: 'content.hero.headline', before: DEFAULT_LANDING_BLOCKS.hero.headline, after: 'New headline here' });
    expect(d.find((c) => c.path === 'content.faq[4].q')).toMatchObject({ after: null });
    expect(d.find((c) => c.path === 'variants[0].content.hero.sub')).toMatchObject({ before: null, after: 'Variant sub' });
    expect(diffLanding(live, live)).toEqual([]);
  });
});

describe('landing gallery rights sweep (plan 05 §5 edge case)', () => {
  it('unpublishes an example whose rights expire from the draft and the live page, as a new version with an alert', async () => {
    const s = await staff();
    const slug = newSlug();
    const ids = [await asset({ rightsExpire: new Date(Date.now() + 3600_000).toISOString() }), await asset(), await asset(), await asset()];
    const content = blocks({ hero: { ...DEFAULT_LANDING_BLOCKS.hero, visualAssetId: ids[3]!, visualCaption: 'Example' }, gallery: { items: ids.slice(0, 3).map((assetId) => ({ assetId, caption: 'Example, demo serum' })) } });
    await withAdmin((tx) => saveLandingDraft(tx, s, { slug, archetype: 'general', content, variants: [], utmMatch: [] }));
    await withAdmin((tx) => publishLanding(tx, s, slug));
    expect(await withSystem((tx) => sweepLandingGalleryRights(tx))).toEqual([]);

    await ownerPool()`update assets set rights_expires_at = now() - interval '1 minute' where id = ${ids[0]!}`;
    await ownerPool()`update assets set deleted_at = now() where id = ${ids[3]!}`;
    const changed = await withSystem((tx) => sweepLandingGalleryRights(tx));
    expect(changed).toEqual([{ slug, removed: expect.arrayContaining([ids[0], ids[3]]) }]);
    const [p] = await ownerPool()`select version, live_version, content, live_content, history from landing_pages where slug = ${slug}`;
    expect(p!.version).toBe(2);
    expect(p!.live_version).toBe(2);
    for (const c of [p!.content, p!.live_content] as LandingBlocks[]) {
      expect(c.gallery.items.map((g) => g.assetId)).toEqual(ids.slice(1, 3));
      expect(c.hero.visualAssetId).toBeNull();
    }
    expect((p!.history as { by: string }[]).at(-1)!.by).toBe('system:rights-sweep');
    const alerts = await ownerPool()`select kind, subject_id from platform_alerts where resolved_at is null`;
    expect(alerts).toEqual([{ kind: 'landing.example_rights_expired', subject_id: slug }]);
    expect(await withSystem((tx) => sweepLandingGalleryRights(tx))).toEqual([]);
  });
});

describe('landing previews and results (plan 05 §5)', () => {
  it('signs draft previews per page and for a limited time', () => {
    const t = landingPreviewToken('serum', 60);
    expect(verifyLandingPreviewToken('serum', t)).toBe(true);
    expect(verifyLandingPreviewToken('texture', t)).toBe(false);
    expect(verifyLandingPreviewToken('serum', t.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')))).toBe(false);
    expect(verifyLandingPreviewToken('serum', landingPreviewToken('serum', 60, Date.now() - 3600_000))).toBe(false);
    expect(verifyLandingPreviewToken('serum', null)).toBe(false);
  });

  it('attributes upload starts and Taste purchases to the first page and variant a visitor landed on', async () => {
    const slug = newSlug();
    const ev = (type: string, visitor: string, page: string | null, variant: string | null, minutesAgo: number) =>
      ownerPool()`insert into funnel_events (type, visitor_id, page, variant, at) values (${type}, ${visitor}, ${page}, ${variant}, now() - make_interval(mins => ${minutesAgo}))`;
    await ev('LP_VIEWED', 'v1', slug, 'a', 30);
    await ev('UPLOAD_STARTED', 'v1', null, null, 29);
    await ev('TASTE_PAID', 'v1', null, null, 10);
    await ev('LP_VIEWED', 'v2', slug, 'b', 30);
    await ev('LP_VIEWED', 'v3', slug, 'b', 30);
    await ev('UPLOAD_STARTED', 'v3', null, null, 20);
    // v4 first landed elsewhere: its later view of this page counts as traffic, not as this page's conversion.
    await ev('LP_VIEWED', 'v4', 'default', null, 40);
    await ev('LP_VIEWED', 'v4', slug, 'a', 30);
    await ev('UPLOAD_STARTED', 'v4', null, null, 5);
    const rows = await withAdmin((tx) => landingStats(tx, { days: 7, slug }));
    expect(rows).toEqual([
      { page: slug, variant: 'a', views: 2, visitors: 1, uploads: 1, taste: 1 },
      { page: slug, variant: 'b', views: 2, visitors: 2, uploads: 1, taste: 0 },
    ]);
  });

  it('awards a winner only on the primary metric, past the minimum sample, with ≥95% probability', () => {
    const exp = { primaryMetric: 'upload_start' as const, minSample: 400 };
    // A big raw lift on a tiny sample is no winner.
    expect(landingVerdict([{ variant: 'a', visitors: 30, uploads: 3, taste: 0 }, { variant: 'b', visitors: 30, uploads: 12, taste: 0 }], exp)).toMatchObject({ state: 'gathering', winner: null });
    const clear = landingVerdict([{ variant: 'a', visitors: 2000, uploads: 300, taste: 10 }, { variant: 'b', visitors: 2000, uploads: 420, taste: 9 }], exp);
    expect(clear).toMatchObject({ state: 'winner', winner: 'b' });
    expect(clear.rows[1]!.estimate).toBeLessThan(420 / 2000); // shrunk toward the pooled rate
    // Same data judged on Taste CVR (the other metric): no winner.
    expect(landingVerdict([{ variant: 'a', visitors: 2000, uploads: 300, taste: 10 }, { variant: 'b', visitors: 2000, uploads: 420, taste: 9 }], { primaryMetric: 'taste_cvr', minSample: 400 })).toMatchObject({ state: 'no_winner', winner: null });
  });
});
