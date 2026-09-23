import type { Metadata } from 'next';
import { AnalysisFlow } from '@/components/flow';

export const metadata: Metadata = { title: 'Your product · Arkiv', robots: { index: false } };

export default async function Page({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <AnalysisFlow projectId={projectId} />;
}
