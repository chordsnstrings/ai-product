import { headers } from 'next/headers';
import { globalTx, withSystem } from '@arkiv/db';
import { applyLandingVariant, env, geoFromHeaders, landingBlocksFrom, landingVariantFrom, type LandingBlocks, type LandingVariantContent } from '@arkiv/shared';
import { assignVariantOrNull, deviceClass, landingExampleUrls, recordFunnel } from '@arkiv/core';
import { ExampleAsset, Testimonial } from '@arkiv/ui';
import { StickyCta } from '@arkiv/ui/client';
import { MarketingShell } from '@/components/marketing';
import { UploadModule } from '@/components/upload-module';
import { currentUser, hasVisitorCookie, visitorId } from '@/lib/session';

type StoredVariant = { key: string; weight: number; content: unknown };

/**
 * P1 campaign landing page (plan 03 P1). Headline echoes the ad (L1); upload is in the hero (L2); proof is
 * process-level and real (L13); examples are labelled; sticky CTA after the hero scrolls away (L19).
 * Content is the page's structured blocks (plan 05 §5): visitors see the published copy; the console's signed
 * preview shows the draft (optionally one variant) without recording a visit.
 */
export async function Landing({ slug, searchParams, preview }: { slug: string; searchParams: Record<string, string | string[] | undefined>; preview?: { variant: string | null } | null }) {
  const utm = Object.fromEntries(Object.entries(searchParams).filter(([k]) => k.startsWith('utm_')).map(([k, v]) => [k, String(v)]));
  const page = await globalTx(async (tx) => {
    if (preview) {
      const [d] = await tx`select slug, content, variants, version from landing_pages where slug = ${slug}`;
      if (d) return d;
    }
    // utm_content routing (plan 05 §5): e.g. utm_content=texture* → the texture page.
    if (slug === 'default' && utm.utm_content) {
      const [m] = await tx`select slug, live_content as content, live_variants as variants, live_version as version from landing_pages where status = 'live'
                           and exists (select 1 from unnest(utm_match) u where ${utm.utm_content.toLowerCase()} like u || '%') limit 1`;
      if (m) return m;
    }
    const [p] = await tx`select slug, live_content as content, live_variants as variants, live_version as version from landing_pages where slug = ${slug} and status = 'live'`;
    return p ?? (await tx`select slug, live_content as content, live_variants as variants, live_version as version from landing_pages where slug = 'default'`)[0];
  });
  // A visitor who already carries our first-party cookie has been here before (plan 05 §4 "new vs returning").
  const returning = await hasVisitorCookie();
  const vid = await visitorId();
  const variants = ((page?.variants as StoredVariant[]) ?? []).map((v) => ({ key: v.key, weight: Number(v.weight), content: landingVariantFrom(v.content) }));
  const variant = preview ? (variants.find((v) => v.key === preview.variant)?.key ?? null) : page ? assignVariantOrNull(`lp:${page.slug}`, vid, variants) : null;
  const blocks: LandingBlocks = applyLandingVariant(landingBlocksFrom(page?.content), variants.find((v) => v.key === variant)?.content as LandingVariantContent | undefined);
  const user = await currentUser();
  const h = await headers();
  const ua = h.get('user-agent') ?? '';
  const geo = geoFromHeaders(h);
  // Slices for plan 05 §4: device class, edge country/region, new vs returning, and the ad (creative) id the
  // campaign passes (ad_id, or the utm_id macro). A staff preview is not a visit.
  const adId = String(searchParams.ad_id ?? searchParams.utm_id ?? '').slice(0, 64) || null;
  if (!preview) {
    await recordFunnel('LP_VIEWED', {
      visitorId: vid,
      page: page?.slug as string,
      variant,
      utm,
      props: { inApp: /Instagram|FBAN|FBAV|TikTok|musical_ly|BytedanceWebview/i.test(ua), device: deviceClass(ua), country: geo?.country ?? null, region: geo?.region ?? null, returning, adId },
    }).catch(() => {});
  }
  // Cross-tenant aggregate (a count only, no tenant data) and our own demo workspace's examples → system role.
  const exampleIds = [...(blocks.hero.visualAssetId ? [blocks.hero.visualAssetId] : []), ...blocks.gallery.items.map((g) => g.assetId)];
  const [stats, examples] = await withSystem(async (tx) => [
    await tx`select (select count(*) from events where type = 'CLAIM_CREATED' and at > now() - interval '7 days')::int as claims`,
    await landingExampleUrls(tx, exampleIds),
  ] as const).catch(() => [[{ claims: 0 }], new Map<string, { url: string; mime: string }>()] as const);
  const claimsChecked = Number(stats[0]?.claims ?? 0);
  // The runtime hides a testimonial whose consent was revoked after publishing (plan 04 §4).
  const testimonialIds = blocks.proof.testimonialIds ?? [];
  const testimonials = testimonialIds.length
    ? await globalTx((tx) => tx`select id, quote, person_name, brand_name from testimonials where id in ${tx(testimonialIds)} and revoked_at is null`)
    : [];
  const heroVisual = blocks.hero.visualAssetId ? examples.get(blocks.hero.visualAssetId) : undefined;
  const gallery = blocks.gallery.items.map((g) => ({ ...g, media: examples.get(g.assetId) })).filter((g) => g.media);

  return (
    <div className="ak-marketing">
      <MarketingShell loggedIn={!!user}>
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
            <UploadModule page={page?.slug as string} variant={variant} turnstileSiteKey={env().TURNSTILE_SITE_KEY ?? null} assurance={blocks.cta.assurance} />
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
