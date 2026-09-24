import type { Metadata } from 'next';
import { projectTitle } from '@/lib/page-title';
import { ProduceFlow } from '@/components/flow';

export async function generateMetadata({ params }: { params: Promise<{ projectId: string }> }): Promise<Metadata> {
  return projectTitle((await params).projectId, 'Making your ad', { robots: { index: false } });
}

export default async function Page({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <ProduceFlow projectId={projectId} />;
}
