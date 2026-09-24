import type { Metadata } from 'next';
import { globalTx } from '@arkiv/db';
import { publicExampleUrls } from '@arkiv/core';
import { landingBlocksFrom } from '@arkiv/shared';
import { ExampleAsset } from '@arkiv/ui';
import { MarketingShell } from '@/components/marketing';
import { BUILT_IN_EXAMPLES, EXAMPLE_LABEL } from '@/lib/examples';

export const metadata: Metadata = { title: 'Examples', description: 'Skincare ad examples by format: texture demo, serum launch, creator-style, founder story and creative refresh.' };
// The published pages' example galleries change when staff publish; re-read at most every 10 minutes.
export const revalidate = 600;

/**
 * `/examples` (plan 03 route map; P1 §7): skincare examples only (standard §13), each 9:16 with a mono caption and
 * labelled as an example (L13). The examples staff chose for the live pages (from our internal demo workspace,
 * rechecked for rights at render) come first, then the built-in demo-product examples of every ad format.
 */
export default async function Examples() {
  const chosen = await globalTx(async (tx) => {
    const pages = await tx`select live_content from landing_pages where status = 'live' order by slug = 'default' desc, slug`;
    const items = pages.flatMap((p) => landingBlocksFrom(p.live_content).gallery.items);
    const unique = [...new Map(items.map((i) => [i.assetId, i])).values()].slice(0, 6);
    const media = await publicExampleUrls(tx, unique.map((i) => i.assetId));
    return unique.filter((i) => media.has(i.assetId)).map((i) => ({ ...i, media: media.get(i.assetId)! }));
  }).catch(() => []);
  return (
    <div className="ak-marketing">
      <MarketingShell loggedIn={false}>
        <section className="ak-wrap ak-stack" style={{ ['--stack' as string]: '24px', paddingTop: 24, paddingBottom: 48 }}>
          <p className="ak-label">Examples</p>
          <h1 className="ak-display">What a finished skincare ad looks like</h1>
          <p className="ak-body-l ak-muted" style={{ maxWidth: 620 }}>
            Every example here was made for a demo product, not a customer’s. Yours uses your real packaging, and every line is checked against cosmetic claim rules.
          </p>
          <div className="ak-grid-3">
            {chosen.map((c) => (
              <ExampleAsset key={c.assetId} src={c.media.url} video={c.media.mime.startsWith('video/')} caption={c.caption} />
            ))}
            {BUILT_IN_EXAMPLES.map((e) => (
              <ExampleAsset key={e.key} src={e.src} caption={`${e.caption} · ${EXAMPLE_LABEL}`} />
            ))}
          </div>
          <p><a className="ak-btn ak-btn--accent" href="/#upload">Analyze my product — free</a></p>
        </section>
      </MarketingShell>
    </div>
  );
}
