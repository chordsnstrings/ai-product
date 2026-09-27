'use client';

import { useState } from 'react';
import { Banner } from '@arkiv/ui';
import { api } from '@arkiv/ui/client';

type Product = { id: string; title: string; image: string | null; priceMicros: number | null; currency: string | null };

const money = (micros: number, currency: string | null) => {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency ?? 'USD' }).format(micros / 1_000_000);
  } catch {
    return `${(micros / 1_000_000).toFixed(2)} ${currency ?? ''}`.trim();
  }
};

/** Plan 03 P2: pick one store product to preview; it is analysed like a pasted product link. */
export function ShopifyPicker({ products }: { products: Product[] }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  async function pick(id: string) {
    setBusy(id);
    setErr(null);
    try {
      const r = await api<{ projectId: string }>('/api/preview/shopify/pick', { productId: id });
      window.location.assign(`/start/${r.projectId}`);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(null);
    }
  }
  return (
    <div className="ak-stack">
      {err ? <Banner tone="risk">{err}</Banner> : null}
      <ul className="ak-stack" style={{ listStyle: 'none', padding: 0, margin: 0, gap: 8 }}>
        {products.map((p) => (
          <li key={p.id} className="ak-panel ak-between" style={{ gap: 12 }}>
            <span className="ak-row" style={{ gap: 12 }}>
              {p.image ? <img src={p.image} alt="" width={48} height={48} style={{ objectFit: 'cover' }} /> : null}
              <span>
                {p.title}
                {p.priceMicros != null ? <span className="ak-small ak-muted" style={{ display: 'block' }}>{money(p.priceMicros, p.currency)}</span> : null}
              </span>
            </span>
            <button type="button" className="ak-btn ak-btn--secondary ak-btn--sm" disabled={!!busy} onClick={() => void pick(p.id)}>
              {busy === p.id ? 'Starting…' : 'Analyze this one'}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
