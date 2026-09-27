import type { Metadata } from 'next';
import { projectTitle } from '@/lib/page-title';
import { AnalysisFlow } from '@/components/flow';

export async function generateMetadata({ params }: { params: Promise<{ projectId: string }> }): Promise<Metadata> {
  return projectTitle((await params).projectId, 'Your product', { robots: { index: false } });
}

export default async function Page({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <AnalysisFlow projectId={projectId} />;
}
