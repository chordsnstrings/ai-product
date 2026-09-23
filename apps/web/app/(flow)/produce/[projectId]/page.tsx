import type { Metadata } from 'next';
import { ProduceFlow } from '@/components/flow';

export const metadata: Metadata = { title: 'Making your ad · Arkiv', robots: { index: false } };

export default async function Page({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <ProduceFlow projectId={projectId} />;
}
