import type { Metadata } from 'next';
import { providerEnabled } from '@arkiv/auth';
import { ConceptsFlow } from '@/components/flow';

export const metadata: Metadata = { title: 'Ad ideas · Arkiv', robots: { index: false } };

export default async function Page({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  // The save gate offers Google/Apple only when they can be used (plan 03 P6).
  return <ConceptsFlow projectId={projectId} providers={{ google: providerEnabled('google'), apple: providerEnabled('apple') }} />;
}
