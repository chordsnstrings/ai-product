import type { Metadata } from 'next';
import Link from 'next/link';
import { verifyUnsub } from '@arkiv/email';
import { MarketingShell } from '@/components/marketing';

export const metadata: Metadata = { title: 'Unsubscribe', robots: { index: false, follow: false } };

const mask = (email: string) => {
  const [local = '', domain = ''] = email.split('@');
  return `${local.slice(0, 1)}•••@${domain}`;
};

/**
 * Unsubscribe confirmation (plan 04 L20). The link in an email lands here instead of unsubscribing on GET, so a
 * mail scanner prefetching links can't unsubscribe anyone; mail clients use the RFC 8058 one-click POST instead.
 */
export default async function UnsubscribePage({ searchParams }: { searchParams: Promise<{ t?: string; state?: string }> }) {
  const { t = '', state } = await searchParams;
  const email = verifyUnsub(t);
  return (
    <MarketingShell loggedIn={false}>
      <section className="ak-wrap ak-stack" style={{ maxWidth: 560, paddingTop: 24, paddingBottom: 48 }}>
        <p className="ak-label">Email preferences</p>
        {!email || state === 'invalid' ? (
          <>
            <h1 className="ak-display">This link doesn’t work</h1>
            <p className="ak-muted">Use the unsubscribe link in the most recent email from us, or write to support and we’ll take you off the list.</p>
          </>
        ) : state === 'done' ? (
          <>
            <h1 className="ak-display">You’re unsubscribed</h1>
            <p className="ak-muted">{mask(email)} won’t get product ideas or reminders from us any more. Receipts, sign-in links and notices about your account still arrive.</p>
            <p><Link href="/">Back to Arkiv</Link></p>
          </>
        ) : (
          <>
            <h1 className="ak-display">Unsubscribe from product emails?</h1>
            <p className="ak-muted">Stop reminders and new ideas sent to {mask(email)}. Receipts, sign-in links and notices about your account still arrive.</p>
            <form method="post" action={`/api/unsubscribe?t=${encodeURIComponent(t)}`}>
              <input type="hidden" name="confirm" value="1" />
              <button type="submit" className="ak-btn">Unsubscribe</button>
            </form>
          </>
        )}
      </section>
    </MarketingShell>
  );
}
