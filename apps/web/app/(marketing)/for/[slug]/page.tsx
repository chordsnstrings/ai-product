import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { globalTx } from '@arkiv/db';
import { verifyLandingPreviewToken } from '@arkiv/core';
import { Landing } from '../../landing';

export const dynamic = 'force-dynamic';

type SP = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? null;

/** The console's signed draft preview is never indexed. */
export async function generateMetadata({ searchParams }: { searchParams: Promise<SP> }): Promise<Metadata> {
  return (await searchParams).preview ? { robots: { index: false, follow: false } } : {};
}

/**
 * Campaign page (plan 03 P1). A page that isn't live (paused, draft, unknown) redirects temporarily to the default
 * page with the visitor's query string (UTMs) intact (plan 05 §5 edge cases); a valid console preview token shows
 * the draft instead.
 */
export default async function CampaignPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<SP> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const preview = verifyLandingPreviewToken(slug, one(sp.preview));
  if (!preview) {
    const [live] = await globalTx((tx) => tx`select 1 from landing_pages where slug = ${slug} and status = 'live'`);
    if (!live) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(sp)) {
        if (k === 'preview') continue;
        for (const x of Array.isArray(v) ? v : v === undefined ? [] : [v]) qs.append(k, x);
      }
      redirect(qs.size ? `/?${qs}` : '/');
    }
  }
  return <Landing slug={slug} searchParams={sp} preview={preview ? { variant: one(sp.variant) } : null} />;
}
