import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { billingGateway, type MockStripe } from '@arkiv/billing';
import { MockPay } from './mock-pay';

export const metadata: Metadata = { title: 'Test checkout', robots: { index: false } };

/** Development stand-in for Stripe Checkout. Unavailable whenever Stripe keys are configured. */
export default async function Page({ params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params;
  const gw = billingGateway();
  if (gw.live) notFound();
  const s = (gw as MockStripe).sessions.get(sessionId);
  if (!s) notFound();
  const next = s.returnUrl.replace('{CHECKOUT_SESSION_ID}', s.id);
  return (
    <div className="ak-wrap ak-section" style={{ maxWidth: 520 }}>
      <p className="ak-label">Test mode · no real charge</p>
      <h1 className="ak-h1">{s.productName}</h1>
      {s.description ? <p className="ak-muted">{s.description}</p> : null}
      <p className="ak-price">${((s.amountCents ?? 0) / 100).toFixed(2)}{s.mode === 'subscription' ? <span className="ak-small ak-muted"> / month</span> : null}</p>
      <MockPay sessionId={s.id} next={next} status={s.status} />
    </div>
  );
}
