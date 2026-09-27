import type { Metadata } from 'next';
import Link from 'next/link';
import { DIGEST_LABELS, verifyDigestOptOut } from '@arkiv/email';
import { MarketingShell } from '@/components/marketing';

export const metadata: Metadata = { title: 'Email preferences', robots: { index: false, follow: false } };

/**
 * Confirmation for a weekly digest's "turn it off" link. A GET only shows this page (mail scanners prefetch links);
 * the form posts to /api/notifications/opt-out.
 */
export default async function EmailPreferencesPage({ searchParams }: { searchParams: Promise<{ t?: string; state?: string }> }) {
  const { t = '', state } = await searchParams;
  const o = verifyDigestOptOut(t);
  return (
    <MarketingShell loggedIn={false}>
      <section className="ak-wrap ak-stack" style={{ maxWidth: 560, paddingTop: 24, paddingBottom: 48 }}>
        <p className="ak-label">Email preferences</p>
        {!o || state === 'invalid' ? (
          <>
            <h1 className="ak-display">This link doesn’t work</h1>
            <p className="ak-muted">Turn weekly emails on or off in your workspace under Settings → Profile.</p>
          </>
        ) : state === 'done' ? (
          <>
            <h1 className="ak-display">Turned off</h1>
            <p className="ak-muted">You won’t get {DIGEST_LABELS[o.kind].toLowerCase()} for this workspace any more. Receipts, sign-in links and notices about your account still arrive. You can turn it back on in Settings → Profile.</p>
            <p><Link href="/app">Open Arkiv</Link></p>
          </>
        ) : (
          <>
            <h1 className="ak-display">Turn off this email?</h1>
            <p className="ak-muted">Stop {DIGEST_LABELS[o.kind].toLowerCase()} for this workspace. Receipts, sign-in links and notices about your account still arrive.</p>
            <form method="post" action={`/api/notifications/opt-out?t=${encodeURIComponent(t)}`}>
              <input type="hidden" name="confirm" value="1" />
              <button type="submit" className="ak-btn">Turn it off</button>
            </form>
          </>
        )}
      </section>
    </MarketingShell>
  );
}
