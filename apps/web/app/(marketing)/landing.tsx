import { headers } from 'next/headers';
import { globalTx, withSystem } from '@arkiv/db';
import { assignVariantOrNull, recordFunnel } from '@arkiv/core';
import { StickyCta } from '@arkiv/ui/client';
import { MarketingShell } from '@/components/marketing';
import { UploadModule } from '@/components/upload-module';
import { currentUser, visitorId } from '@/lib/session';

interface LandingContent {
  label: string;
  headline: string;
  sub: string;
  proof: string;
}

/**
 * P1 campaign landing page (plan 03 P1). Headline echoes the ad (L1); upload is in the hero (L2);
 * proof is process-level and real (L13); examples are labelled; sticky CTA after the hero scrolls away (L19).
 */
export async function Landing({ slug, searchParams }: { slug: string; searchParams: Record<string, string | string[] | undefined> }) {
  const utm = Object.fromEntries(Object.entries(searchParams).filter(([k]) => k.startsWith('utm_')).map(([k, v]) => [k, String(v)]));
  const page = await globalTx(async (tx) => {
    // utm_content routing (plan 05 §5): e.g. utm_content=texture* → the texture page.
    if (slug === 'default' && utm.utm_content) {
      const [m] = await tx`select slug, content, variants from landing_pages where status = 'live'
                           and exists (select 1 from unnest(utm_match) u where ${utm.utm_content.toLowerCase()} like u || '%') limit 1`;
      if (m) return m;
    }
    const [p] = await tx`select slug, content, variants from landing_pages where slug = ${slug} and status = 'live'`;
    return p ?? (await tx`select slug, content, variants from landing_pages where slug = 'default'`)[0];
  });
  const vid = await visitorId();
  const variants = (page?.variants as { key: string; weight: number; content: Partial<LandingContent> }[]) ?? [];
  const variant = page ? assignVariantOrNull(`lp:${page.slug}`, vid, variants) : null;
  const content: LandingContent = { ...(page?.content as LandingContent), ...(variants.find((v) => v.key === variant)?.content ?? {}) };
  const user = await currentUser();
  const ua = (await headers()).get('user-agent') ?? '';
  await recordFunnel('LP_VIEWED', { visitorId: vid, page: page?.slug as string, variant, utm, props: { inApp: /Instagram|FBAN|FBAV|TikTok|musical_ly|BytedanceWebview/i.test(ua) } }).catch(() => {});
  // Cross-tenant aggregate (a count only, no tenant data) → system role.
  const stats = await withSystem((tx) => tx`select (select count(*) from events where type = 'CLAIM_CREATED' and at > now() - interval '7 days')::int as claims`).catch(() => [{ claims: 0 }]);
  const claimsChecked = Number(stats[0]?.claims ?? 0);

  return (
    <div className="ak-marketing">
      <MarketingShell loggedIn={!!user}>
        <section className="ak-wrap" style={{ paddingTop: 24 }}>
          <div className="ak-grid-2" style={{ alignItems: 'start' }}>
            <div className="ak-stack" style={{ ['--stack' as string]: '20px' }}>
              <p className="ak-label">{content.label}</p>
              <h1 className="ak-display-xl">{content.headline}</h1>
              <p className="ak-body-l ak-muted" style={{ maxWidth: 520 }}>{content.sub}</p>
              <ol className="ak-rail" aria-label="How it works">
                <li data-active="true">01 Your product</li>
                <li>02 Three test ideas</li>
                <li>03 Storyboard</li>
                <li>04 Your ad</li>
              </ol>
            </div>
            <UploadModule page={page?.slug as string} variant={variant} />
          </div>
        </section>

        <section className="ak-wrap ak-section">
          <div className="ak-between" style={{ flexWrap: 'wrap', gap: 24 }}>
            <p className="ak-label">{content.proof}</p>
            {claimsChecked >= 100 ? <p className="ak-label">{claimsChecked.toLocaleString('en-US')} claims checked this week</p> : null}
          </div>
          <hr className="ak-rule-ink" style={{ margin: '12px 0 32px' }} />
          <div className="ak-grid-3">
            {[
              ['01', 'We catalogue your product', 'Name, size, ingredients, packaging and every claim on your page — marked as observed or inferred, never invented.'],
              ['02', 'Three tests worth running', 'Different hypotheses, not copy variations: texture, objections, routines — grounded in what your customers say.'],
              ['03', 'A checked, finished ad', '15 seconds, 9:16 + 4:5 + square, captions and voice. Product accuracy and claims checked before you see it.'],
            ].map(([n, t, b]) => (
              <div key={n} className="ak-stack" style={{ ['--stack' as string]: '8px' }}>
                <span className="ak-index">{n}</span>
                <h2 className="ak-h2">{t}</h2>
                <p className="ak-muted" style={{ margin: 0 }}>{b}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="ak-wrap ak-section" style={{ paddingTop: 0 }}>
          <p className="ak-label">What we check</p>
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
          <p className="ak-label">Questions</p>
          <hr className="ak-rule-ink" style={{ margin: '12px 0 8px' }} />
          {[
            ['What does it cost?', 'The analysis and three ideas are free. Your first finished ad is $19 during a 60-minute intro window after your storyboard is ready; after that it’s $29. Plans start at $49/month.'],
            ['Is there a subscription?', 'Not unless you choose one. The $19 ad is a one-time purchase.'],
            ['What do I need?', 'A product link or one clear photo of the front of your product.'],
            ['How long does it take?', 'Ideas in about a minute; your finished ad in a few minutes.'],
            ['What happens to my data?', 'Your product data, claims and results are only ever used for your brand. Delete everything anytime.'],
          ].map(([q, a]) => (
            <details key={q} style={{ borderBottom: '1px solid var(--rule)', padding: '14px 0' }}>
              <summary style={{ cursor: 'pointer', fontWeight: 500 }}>{q}</summary>
              <p className="ak-muted" style={{ margin: '8px 0 0' }}>{a}</p>
            </details>
          ))}
        </section>

        <StickyCta watchId="upload" mobileOnly>
          <a href="#upload" className="ak-btn ak-btn--accent ak-btn--block">Analyze my product — free</a>
        </StickyCta>
      </MarketingShell>
    </div>
  );
}
