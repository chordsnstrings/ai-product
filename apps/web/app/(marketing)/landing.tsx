import { cookies, headers } from 'next/headers';
import { globalTx } from '@arkiv/db';
import { applyLandingVariant, env, landingBlocksFrom, landingVariantFrom, type LandingBlocks, type LandingVariantContent } from '@arkiv/shared';
import { assignVariantOrNull, claimsCheckedLast7Days, publicExampleUrls } from '@arkiv/core';
import { ExampleAsset, Testimonial } from '@arkiv/ui';
import { StickyCta } from '@arkiv/ui/client';
import { LandingBeacon } from '@/components/landing-beacon';
import { MarketingShell } from '@/components/marketing';
import { HeroCta } from '@/components/hero-cta';
import { FIRST_VIEW_COOKIE } from '@/lib/landing-routing';
import { recordLandingView } from '@/lib/lp-view';
import { currentUser, hasVisitorCookie, visitorId } from '@/lib/session';

type StoredVariant = { key: string; weight: number; content: unknown };
type PageRow = { slug: string; content: unknown; variants: unknown; version: unknown } | undefined;

const variantsOf = (page: PageRow) => ((page?.variants as StoredVariant[]) ?? []).map((v) => ({ key: v.key, weight: Number(v.weight), content: landingVariantFrom(v.content) }));

/** The live copy of a page (the default page when it isn't live). */
async function livePage(slug: string): Promise<PageRow> {
  return globalTx(async (tx) => {
    const [p] = await tx`select slug, live_content as content, live_variants as variants, live_version as version from landing_pages where slug = ${slug} and status = 'live'`;
    return (p ?? (await tx`select slug, live_content as content, live_variants as variants, live_version as version from landing_pages where slug = 'default'`)[0]) as PageRow;
  });
}

/** What the page shows besides its copy: the platform proof counter, example media, consented testimonials. */
async function pageExtras(blocks: LandingBlocks) {
  // A platform-wide count and our own demo workspace's examples, through narrow database functions: the customer
  // app never holds a cross-tenant role (plan 02 §3).
  const exampleIds = [...(blocks.hero.visualAssetId ? [blocks.hero.visualAssetId] : []), ...blocks.gallery.items.map((g) => g.assetId)];
  const [claimsChecked, examples] = await globalTx(async (tx) => [await claimsCheckedLast7Days(tx), await publicExampleUrls(tx, exampleIds)] as const).catch(
    () => [0, new Map<string, { url: string; mime: string }>()] as const,
  );
  // The runtime hides a testimonial whose consent was revoked after publishing (plan 04 §4).
  const testimonialIds = blocks.proof.testimonialIds ?? [];
  const testimonials = testimonialIds.length
    ? await globalTx((tx) => tx`select id, quote, person_name, brand_name from testimonials where id in ${tx(testimonialIds)} and revoked_at is null`)
    : [];
  return { claimsChecked, examples, testimonials };
}

/**
 * The static campaign page (plan 04 L6): rendered once per (page, copy variant), cached and served from the CDN —
 * the proxy picks the page and the visitor's variant and rewrites here. Nothing per visitor is read while
 * rendering; the view is recorded by a small beacon once the page shows, and the hero needs no client JS.
 */
export async function StaticLanding({ slug, variant }: { slug: string; variant: string | null }) {
  const page = await livePage(slug);
  const variants = variantsOf(page);
  const chosen = variant ? (variants.find((v) => v.key === variant) ?? null) : null;
  const blocks: LandingBlocks = applyLandingVariant(landingBlocksFrom(page?.content), chosen?.content as LandingVariantContent | undefined);
  return <LandingBody page={page} blocks={blocks} variant={chosen?.key ?? null} loggedIn={false} extras={await pageExtras(blocks)} beacon />;
}

/**
 * P1 campaign landing page rendered per request (plan 03 P1): the console's signed draft preview, and the fallback
 * when the proxy can't route a visit to the static page. Headline echoes the ad (L1); upload is in the hero (L2);
 * proof is process-level and real (L13); examples are labelled; sticky CTA after the hero scrolls away (L19).
 * Content is the page's structured blocks (plan 05 §5): visitors see the published copy; the preview shows the
 * draft (optionally one variant) without recording a visit.
 */
export async function Landing({ slug, searchParams, preview }: { slug: string; searchParams: Record<string, string | string[] | undefined>; preview?: { variant: string | null } | null }) {
  const utmContent = typeof searchParams.utm_content === 'string' ? searchParams.utm_content : null;
  const routed = (await globalTx(async (tx) => {
    if (preview) {
      const [d] = await tx`select slug, content, variants, version from landing_pages where slug = ${slug}`;
      if (d) return d;
    }
    // utm_content routing (plan 05 §5): e.g. utm_content=texture* → the texture page.
    if (slug === 'default' && utmContent) {
      const [m] = await tx`select slug, live_content as content, live_variants as variants, live_version as version from landing_pages where status = 'live'
                           and exists (select 1 from unnest(utm_match) u where ${utmContent.toLowerCase()} like u || '%') limit 1`;
      if (m) return m;
    }
    return null;
  })) as PageRow | null;
  const page = routed ?? (await livePage(slug));
  // A visitor who already carries our first-party cookie has been here before (plan 05 §4 "new vs returning"); the
  // proxy marks the first view of a visitor whose cookie it has just created.
  const returning = (await hasVisitorCookie()) && !(await cookies()).get(FIRST_VIEW_COOKIE)?.value;
  const vid = await visitorId();
  const variants = variantsOf(page);
  const variant = preview ? (variants.find((v) => v.key === preview.variant)?.key ?? null) : page ? assignVariantOrNull(`lp:${page.slug}`, vid, variants) : null;
  const blocks: LandingBlocks = applyLandingVariant(landingBlocksFrom(page?.content), variants.find((v) => v.key === variant)?.content as LandingVariantContent | undefined);
  const user = await currentUser();
  // A staff preview is not a visit.
  if (!preview) {
    const search = new URLSearchParams();
    for (const [k, v] of Object.entries(searchParams)) for (const x of Array.isArray(v) ? v : v === undefined ? [] : [v]) search.append(k, x);
    await recordLandingView({ visitorId: vid, page: (page?.slug as string) ?? null, variant, search, headers: new Headers(await headers()), returning }).catch(() => {});
  }
  return <LandingBody page={page} blocks={blocks} variant={variant} loggedIn={!!user} extras={await pageExtras(blocks)} preview={!!preview} />;
}

function LandingBody({ page, blocks, variant, loggedIn, extras, preview, beacon }: {
  page: PageRow;
  blocks: LandingBlocks;
  variant: string | null;
  loggedIn: boolean;
  extras: Awaited<ReturnType<typeof pageExtras>>;
  preview?: boolean;
  beacon?: boolean;
}) {
  const { claimsChecked, examples, testimonials } = extras;
  const heroVisual = blocks.hero.visualAssetId ? examples.get(blocks.hero.visualAssetId) : undefined;
  const gallery = blocks.gallery.items.map((g) => ({ ...g, media: examples.get(g.assetId) })).filter((g) => g.media);

  return (
    <div className="ak-marketing">
      <MarketingShell loggedIn={loggedIn}>
        {beacon ? <LandingBeacon page={page?.slug as string} variant={variant} /> : null}
        {preview ? (
          <p className="ak-wrap ak-label" role="status" style={{ padding: '8px 0', color: 'var(--risk)' }}>
            Preview of draft v{String(page?.version ?? '?')}{variant ? ` · variant ${variant}` : ''} — not live, not counted
          </p>
        ) : null}
        <section className="ak-wrap" style={{ paddingTop: 24 }}>
          <div className="ak-grid-2" style={{ alignItems: 'start' }}>
            <div className="ak-stack" style={{ ['--stack' as string]: '20px' }}>
              <p className="ak-label">{blocks.hero.label}</p>
              <h1 className="ak-display-xl">{blocks.hero.headline}</h1>
              <p className="ak-body-l ak-muted" style={{ maxWidth: 520 }}>{blocks.hero.sub}</p>
              <ol className="ak-rail" aria-label="How it works">
                <li data-active="true">01 Your product</li>
                <li>02 Three test ideas</li>
                <li>03 Storyboard</li>
                <li>04 Your ad</li>
              </ol>
              {heroVisual ? (
                <div style={{ maxWidth: 220 }}>
                  <ExampleAsset src={heroVisual.url} video={heroVisual.mime.startsWith('video/')} caption={blocks.hero.visualCaption || 'Example, made for a demo product'} />
                </div>
              ) : null}
            </div>
            <HeroCta page={page?.slug as string} variant={variant} turnstileSiteKey={env().TURNSTILE_SITE_KEY ?? null} assurance={blocks.cta.assurance} />
          </div>
        </section>

        <section className="ak-wrap ak-section">
          <div className="ak-between" style={{ flexWrap: 'wrap', gap: 24 }}>
            <p className="ak-label">{blocks.proof.text}</p>
            {blocks.proof.liveCounter !== false && claimsChecked >= 100 ? <p className="ak-label">{claimsChecked.toLocaleString('en-US')} claims checked this week</p> : null}
          </div>
          <hr className="ak-rule-ink" style={{ margin: '12px 0 32px' }} />
          <div className="ak-grid-3">
            {blocks.howItWorks.map((step, n) => (
              <div key={n} className="ak-stack" style={{ ['--stack' as string]: '8px' }}>
                <span className="ak-index">{String(n + 1).padStart(2, '0')}</span>
                <h2 className="ak-h2">{step.title}</h2>
                <p className="ak-muted" style={{ margin: 0 }}>{step.body}</p>
              </div>
            ))}
          </div>
          {testimonials.length ? (
            <div className="ak-grid-3" style={{ marginTop: 32 }}>
              {testimonials.map((t) => (
                <Testimonial key={t.id as string} consentId={t.id as string} quote={t.quote as string} name={t.person_name as string} brand={(t.brand_name as string) ?? undefined} />
              ))}
            </div>
          ) : null}
        </section>

        {gallery.length ? (
          <section className="ak-wrap ak-section" style={{ paddingTop: 0 }}>
            <h2 className="ak-label">Examples</h2>
            <hr className="ak-rule-ink" style={{ margin: '12px 0 16px' }} />
            <div className="ak-grid-3">
              {gallery.map((g) => (
                <ExampleAsset key={g.assetId} src={g.media!.url} video={g.media!.mime.startsWith('video/')} caption={g.caption} />
              ))}
            </div>
          </section>
        ) : null}

        <section className="ak-wrap ak-section" style={{ paddingTop: 0 }}>
          <h2 className="ak-label">What we check</h2>
          <hr className="ak-rule-ink" style={{ margin: '12px 0 8px' }} />
          <table className="ak-meta">
            <tbody>
              <tr><th>Claims</th><td>Every line checked against FDA cosmetic and FTC substantiation rules. No “cures”, no fake before/after.</td></tr>
              <tr><th>Product accuracy</th><td>Label text, closure, shape and colour compared with your photos. If a shot drifts, we use your exact product.</td></tr>
              <tr><th>Platform fit</th><td>Safe zones, captions, audio and exact sizes for TikTok, Reels and Feed.</td></tr>
            </tbody>
          </table>
        </section>

        <section className="ak-wrap ak-section" style={{ paddingTop: 0 }}>
          <h2 className="ak-label">Questions</h2>
          <hr className="ak-rule-ink" style={{ margin: '12px 0 8px' }} />
          {blocks.faq.map(({ q, a }) => (
            <details key={q} style={{ borderBottom: '1px solid var(--rule)', padding: '14px 0' }}>
              <summary style={{ cursor: 'pointer', fontWeight: 500 }}>{q}</summary>
              <p className="ak-muted" style={{ margin: '8px 0 0' }}>{a}</p>
            </details>
          ))}
        </section>

        <StickyCta watchId="upload" mobileOnly>
          <a href="#upload" className="ak-btn ak-btn--accent ak-btn--block">{blocks.cta.label}</a>
        </StickyCta>
      </MarketingShell>
    </div>
  );
}
