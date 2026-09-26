'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

/**
 * §48 "No Meta/TikTok connection: product remains usable, but recommendations are labelled context-limited; gently
 * show value of connection." Shown only while no ad account is connected; a dismissal is remembered per browser
 * and user, and the card never blocks anything.
 */
export function ConnectAdsCard({ slug, userKey }: { slug: string; userKey: string }) {
  const key = `arkiv:connect-ads-dismissed:${userKey}`;
  // Hidden until the stored preference is read, so a dismissed card never flashes.
  const [hidden, setHidden] = useState(true);
  useEffect(() => {
    try {
      setHidden(window.localStorage.getItem(key) === '1');
    } catch {
      setHidden(false);
    }
  }, [key]);
  if (hidden) return null;
  const dismiss = () => {
    try {
      window.localStorage.setItem(key, '1');
    } catch {
      /* storage blocked: hide for this view only */
    }
    setHidden(true);
  };
  return (
    <section className="ak-panel" aria-labelledby="connect-ads-title" data-testid="connect-ads-card">
      <div className="ak-between" style={{ gap: 12, alignItems: 'start' }}>
        <div>
          <h2 id="connect-ads-title" className="ak-h2" style={{ marginTop: 0 }}>Your plan is working from context only</h2>
          <p className="ak-small ak-muted" style={{ maxWidth: 560 }}>
            Without Meta or TikTok results, recommendations come from your product, reviews and claims — they can’t yet learn which ads actually worked. Connecting (read-only) lets Arkiv:
          </p>
          <ul className="ak-small" style={{ margin: '8px 0 12px', paddingLeft: 18 }}>
            <li>link results to each variant automatically by the AK code in the ad name,</li>
            <li>turn test results into learnings that steer next week’s plan,</li>
            <li>notice when a winning ad starts to wear out and suggest a refresh.</li>
          </ul>
          <Link className="ak-btn" href={`/w/${slug}/settings/integrations`}>Connect an ad account</Link>
          <span className="ak-small ak-muted" style={{ marginLeft: 12 }}>No access? Upload a CSV from Results.</span>
        </div>
        <button className="ak-textbtn" onClick={dismiss} aria-label="Dismiss">Not now</button>
      </div>
    </section>
  );
}
