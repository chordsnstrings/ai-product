import type { Metadata } from 'next';
import { globalTx } from '@arkiv/db';
import { setting } from '@arkiv/core';
import { env } from '@arkiv/shared';
import { CheckoutFlow } from '@/components/flow';
import { requireUser } from '@/lib/session';

export const metadata: Metadata = { title: 'Checkout · Arkiv', robots: { index: false } };

export default async function Page({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  await requireUser(`/checkout/${projectId}`);
  // Support stays in view beside the payment (plan 04 L12); the address is a platform setting (plan 05 §20).
  const support = await globalTx((tx) => setting(tx, 'support.email')).catch(() => null);
  return <CheckoutFlow projectId={projectId} publishableKey={env().STRIPE_SECRET_KEY ? (env().STRIPE_PUBLISHABLE_KEY ?? null) : null} supportEmail={typeof support === 'string' && support.includes('@') ? support : null} />;
}
