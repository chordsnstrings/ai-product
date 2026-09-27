import type { Metadata } from 'next';
import { projectTitle } from '@/lib/page-title';
import { providerEnabled } from '@arkiv/auth';
import { ConceptsFlow } from '@/components/flow';

export async function generateMetadata({ params }: { params: Promise<{ projectId: string }> }): Promise<Metadata> {
  return projectTitle((await params).projectId, 'Ad ideas', { robots: { index: false } });
}

export default async function Page({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  // The save gate offers Google/Apple only when they can be used (plan 03 P6).
  return <ConceptsFlow projectId={projectId} providers={{ google: providerEnabled('google'), apple: providerEnabled('apple') }} />;
}
