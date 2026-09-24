import type { Metadata } from 'next';
import { projectTitle } from '@/lib/page-title';
import { env } from '@arkiv/shared';
import { CheckoutFlow } from '@/components/flow';
import { requireUser } from '@/lib/session';

export async function generateMetadata({ params }: { params: Promise<{ projectId: string }> }): Promise<Metadata> {
  return projectTitle((await params).projectId, 'Checkout', { robots: { index: false } });
}

export default async function Page({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  await requireUser(`/checkout/${projectId}`);
  return <CheckoutFlow projectId={projectId} publishableKey={env().STRIPE_SECRET_KEY ? (env().STRIPE_PUBLISHABLE_KEY ?? null) : null} />;
}
