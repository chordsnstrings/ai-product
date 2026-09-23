import type { Metadata } from 'next';
import { DeliverFlow } from '@/components/flow';

export const metadata: Metadata = { title: 'Your ad · Arkiv', robots: { index: false } };

export default async function Page({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <DeliverFlow projectId={projectId} />;
}
