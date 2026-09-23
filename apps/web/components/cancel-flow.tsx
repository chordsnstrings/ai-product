'use client';

import { useState } from 'react';
import { Banner, Button } from '@arkiv/ui';
import { api } from '@arkiv/ui/client';

const REASONS = [
  ['too_expensive', 'Too expensive'],
  ['not_enough_value', 'Not seeing enough value yet'],
  ['paused_ads', 'We paused paid ads'],
  ['switching', 'Switching to another tool'],
  ['quality', 'Ad quality wasn’t right'],
  ['other', 'Something else'],
] as const;

/**
 * A9: two screens, maximum. Screen 1 states consequences, takes an optional reason, and offers one honest
 * alternative (downgrade) once. Screen 2 confirms. No retention maze (ROSCA / FTC click-to-cancel).
 */
export function CancelFlow({ slug, endsOn, planCode }: { slug: string; endsOn: string; planCode: string }) {
  const [step, setStep] = useState<0 | 1 | 2>(0);
  const [reason, setReason] = useState<string>('');
  const [detail, setDetail] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ends, setEnds] = useState(endsOn);

  if (step === 0) return <Button variant="secondary" onClick={() => setStep(1)}>Cancel plan</Button>;
  if (step === 2)
    return (
      <div className="ak-panel" role="status">
        <p className="ak-h2" style={{ marginTop: 0 }}>Cancelled. Your plan ends {ends}.</p>
        <p>You keep full access until then. Your archive is kept for 90 days after that, and you can export everything anytime.</p>
        <a className="ak-btn ak-btn--secondary" href={`/w/${slug}/settings/data`}>Export my data</a>
      </div>
    );
  return (
    <div className="ak-panel ak-stack">
      <p className="ak-h2" style={{ margin: 0 }}>Before you go</p>
      <ul className="ak-small" style={{ margin: 0 }}>
        <li>Your plan runs until <strong>{endsOn}</strong>; tests already in production finish.</li>
        <li>Unused Creative Tests expire at the end of the period.</li>
        <li>Your archive, learnings and exports are kept for 90 days.</li>
      </ul>
      <label className="ak-field">
        <span className="ak-label">Reason (optional)</span>
        <select className="ak-input" value={reason} onChange={(e) => setReason(e.target.value)}>
          <option value="">Prefer not to say</option>
          {REASONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </label>
      {reason ? <textarea className="ak-textarea" maxLength={500} placeholder="Anything we should know? (optional)" value={detail} onChange={(e) => setDetail(e.target.value)} /> : null}
      {planCode !== 'LAUNCH' && (reason === 'too_expensive' || reason === 'not_enough_value') ? (
        <p className="ak-small">Alternatively, Launch is $49/month with 3 tests — you can switch at renewal from “Change plan” above.</p>
      ) : null}
      {err ? <Banner tone="risk">{err}</Banner> : null}
      <div className="ak-row">
        <Button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setErr(null);
            try {
              const r = await api<{ endsAt: string }>(`/api/w/${slug}/cancel`, { reason: reason || null, detail: detail || null });
              if (r.endsAt) setEnds(new Date(r.endsAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }));
              setStep(2);
            } catch (e) {
              setErr((e as Error).message);
            }
            setBusy(false);
          }}
        >
          {busy ? 'Cancelling…' : 'Cancel plan'}
        </Button>
        <button className="ak-textbtn" onClick={() => setStep(0)}>Keep my plan</button>
      </div>
    </div>
  );
}
