import type { Metadata } from 'next';
import Link from 'next/link';
import { Banner } from '@arkiv/ui';
import { MarketingShell } from '@/components/marketing';

export const metadata: Metadata = { title: 'Report a rights issue' };

const ERRORS: Record<string, string> = {
  invalid: 'Please fill in your name, a valid email address and a description of the content.',
  limited: 'Too many reports from here just now. Please try again later.',
  blocked: 'We couldn’t accept this report from your network. Please email it to us instead.',
};

/**
 * Takedown / rights complaint form (plan 05 §15). Anyone who holds rights in content shown in an ad made with Arkiv
 * (a creator, a photographer, a brand) can report it; the report opens a case our compliance team reviews, and the
 * content is frozen while it is open. Email to the rights address reaches the same queue.
 */
export default async function RightsPage({ searchParams }: { searchParams: Promise<{ state?: string }> }) {
  const { state } = await searchParams;
  return (
    <MarketingShell loggedIn={false}>
      <section className="ak-wrap ak-stack" style={{ maxWidth: 620, paddingTop: 24, paddingBottom: 48 }}>
        <p className="ak-label">Rights & takedown</p>
        {state === 'done' ? (
          <>
            <h1 className="ak-display">Thanks, we have your report</h1>
            <p className="ak-muted">Our compliance team reviews every report and replies by email. While a report is open, the content can’t be used in new ads.</p>
            <p><Link href="/">Back to Arkiv</Link></p>
          </>
        ) : (
          <>
            <h1 className="ak-display">Report content that uses your rights</h1>
            <p className="ak-muted">If an ad made with Arkiv uses your footage, photo, likeness or other work without permission, tell us here.</p>
            {state && ERRORS[state] ? <Banner tone="risk">{ERRORS[state]}</Banner> : null}
            <form method="post" action="/api/rights" className="ak-stack">
              <label className="ak-field">
                <span className="ak-label">Your name (or who you represent)</span>
                <input className="ak-input" name="name" required minLength={2} maxLength={200} autoComplete="name" />
              </label>
              <label className="ak-field">
                <span className="ak-label">Email for our reply</span>
                <input className="ak-input" name="email" type="email" required maxLength={254} autoComplete="email" />
              </label>
              <label className="ak-field">
                <span className="ak-label">Where the content appears (link), if you have it</span>
                <input className="ak-input" name="url" type="url" maxLength={500} />
              </label>
              <label className="ak-field">
                <span className="ak-label">What the content is and which rights you hold</span>
                <textarea className="ak-textarea" name="detail" required minLength={10} maxLength={3500} rows={6} />
              </label>
              <button type="submit" className="ak-btn">Send report</button>
            </form>
          </>
        )}
      </section>
    </MarketingShell>
  );
}
