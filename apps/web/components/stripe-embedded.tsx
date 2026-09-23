'use client';

import { useMemo } from 'react';
import { loadStripe } from '@stripe/stripe-js';
import { EmbeddedCheckout, EmbeddedCheckoutProvider } from '@stripe/react-stripe-js';

/** Stripe Embedded Checkout (Stripe-hosted card fields; we never see card data). */
export function StripeEmbedded({ clientSecret, pk }: { clientSecret: string; pk: string }) {
  const stripe = useMemo(() => loadStripe(pk), [pk]);
  return (
    <div className="ak-panel" style={{ padding: 0, overflow: 'hidden' }}>
      <EmbeddedCheckoutProvider stripe={stripe} options={{ clientSecret }}>
        <EmbeddedCheckout />
      </EmbeddedCheckoutProvider>
    </div>
  );
}
