import type { Metadata } from 'next';
import { ConceptsFlow } from '@/components/flow';

export const metadata: Metadata = { title: 'Ad ideas · Arkiv', robots: { index: false } };

export default async function Page({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <ConceptsFlow projectId={projectId} />;
}
