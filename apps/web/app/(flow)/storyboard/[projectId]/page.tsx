import type { Metadata } from 'next';
import { StoryboardFlow } from '@/components/flow';

export const metadata: Metadata = { title: 'Storyboard · Arkiv', robots: { index: false } };

export default async function Page({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <StoryboardFlow projectId={projectId} />;
}
