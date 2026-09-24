import type { Metadata } from 'next';
import { projectTitle } from '@/lib/page-title';
import { StoryboardFlow } from '@/components/flow';

export async function generateMetadata({ params }: { params: Promise<{ projectId: string }> }): Promise<Metadata> {
  return projectTitle((await params).projectId, 'Storyboard', { robots: { index: false } });
}

export default async function Page({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <StoryboardFlow projectId={projectId} />;
}
