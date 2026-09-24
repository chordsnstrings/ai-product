import type { Metadata } from 'next';
import { BASE_VARIANT } from '@/lib/landing-routing';
import { StaticLanding } from '../../../landing';

/**
 * Static campaign pages (plan 04 L6 "static-rendered landing pages on the CDN"): one cached render per page and copy
 * variant, regenerated in the background at most once a minute (a publish or pause shows within about a minute).
 * Visitors reach it through the proxy's rewrite of `/` and `/for/<slug>`; nothing is rendered at build time.
 */
export const revalidate = 60;
export const dynamicParams = true;
export async function generateStaticParams() {
  return [];
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  // The public address is `/` or `/for/<slug>`, never this internal path.
  return { alternates: { canonical: slug === 'default' ? '/' : `/for/${slug}` } };
}

export default async function StaticCampaignPage({ params }: { params: Promise<{ slug: string; variant: string }> }) {
  const { slug, variant } = await params;
  return <StaticLanding slug={decodeURIComponent(slug)} variant={variant === BASE_VARIANT ? null : decodeURIComponent(variant)} />;
}
