'use client';

import { useState } from 'react';
import { Banner, Button } from '@arkiv/ui';
import { api } from '@arkiv/ui/client';

type P = { code: 'LAUNCH' | 'GROWTH' | 'SCALE'; name: string; price: string; tests: number; perTest: string; consent: string };

/**
 * Consent is an unchecked box next to the exact recurring terms (plan 04 §3). The checkout cannot start without it,
 * and the server stores the text snapshot shown here.
 */
export function PlanPicker({ slug, plans, initial, canBuy }: { slug: string; plans: P[]; initial: P['code']; canBuy: boolean }) {
  const [code, setCode] = useState(initial);
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [embedded, setEmbedded] = useState<{ C: React.ComponentType<{ clientSecret: string; pk: string }>; clientSecret: string; pk: string } | null>(null);
  const p = plans.find((x) => x.code === code)!;

  async function go() {
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ url: string | null; clientSecret: string | null; live: boolean; publishableKey: string | null }>(`/api/w/${slug}/subscribe`, { plan: code, agreed });
      if (r.live && r.clientSecret && r.publishableKey) {
        const mod = await import('./stripe-embedded');
        setEmbedded({ C: mod.StripeEmbedded, clientSecret: r.clientSecret, pk: r.publishableKey });
      } else if (r.url) window.location.assign(r.url);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }
  if (embedded) return <embedded.C clientSecret={embedded.clientSecret} pk={embedded.pk} />;
  if (!canBuy) return <Banner tone="warn">Only the workspace owner or an admin can choose a plan.</Banner>;
  return (
    <div className="ak-stack" style={{ marginTop: 24 }}>
      <div role="radiogroup" aria-label="Plan" className="ak-stack">
        {plans.map((x) => (
          <label key={x.code} className={`ak-card${x.code === code ? ' ak-card--pick' : ''}`} style={{ cursor: 'pointer' }}>
            <div className="ak-between">
              <span>
                <input type="radio" name="plan" checked={x.code === code} onChange={() => { setCode(x.code); setAgreed(false); }} style={{ marginRight: 10 }} />
                <strong>{x.name}</strong> · {x.tests} Creative Tests / month
              </span>
              <span className="ak-mono">{x.price}/mo · ≈ {x.perTest}/test</span>
            </div>
          </label>
        ))}
      </div>
      <div className="ak-sealed">
        <p style={{ margin: 0 }}>{p.consent}</p>
        <label className="ak-check" style={{ marginTop: 12 }}>
          <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
          <span>I agree to the recurring charge above.</span>
        </label>
      </div>
      {err ? <Banner tone="risk">{err}</Banner> : null}
      <Button block disabled={!agreed || busy} onClick={go}>{busy ? 'Opening checkout…' : `Continue to payment · ${p.price}`}</Button>
      <p className="ak-small ak-muted">Sales tax, where it applies, is shown at checkout.</p>
    </div>
  );
}
