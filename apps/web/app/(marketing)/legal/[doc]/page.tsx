import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { globalTx } from '@arkiv/db';
import { setting } from '@arkiv/core';
import { DATA_RECIPIENTS, type DataRecipient } from '@arkiv/shared';
import { MarketingShell } from '@/components/marketing';
import { currentUser } from '@/lib/session';

/**
 * Placeholder legal pages. These MUST be replaced by counsel-reviewed text before paid launch
 * (plan 06 Phase 6: consumer-protection review of checkout, plans and cancel flows).
 * The subprocessor list is generated from the data inventory in @arkiv/shared (standard §40), which a test
 * keeps in step with every external host the code talks to.
 */
const DOCS: Record<string, { title: string; body: string[]; recipients?: boolean }> = {
  terms: {
    title: 'Terms of Service',
    body: [
      'Draft — pending legal review. Arkiv provides software that helps skincare brands plan, produce and learn from ad creative.',
      'One-time purchases ($19 intro / $29 standalone) are single charges and never convert into a subscription.',
      'Subscriptions renew monthly until cancelled. You can cancel online at any time in Settings → Billing; access continues to the end of the paid period.',
      'You confirm you have rights to the product images, footage and claims evidence you upload.',
    ],
  },
  privacy: {
    title: 'Privacy Policy',
    body: [
      'Draft — pending legal review. We process your product data, uploads, ad performance and account details only to provide the service to your brand.',
      'We never use one customer’s data to serve another customer.',
      'You can export or delete your workspace at any time. Deleted data is purged after a 7-day grace period; backups expire within 14 days. Financial records are retained as required by law.',
      'The companies that process data for us, what they receive and where, are listed below and on the subprocessors page.',
    ],
    recipients: true,
  },
  subprocessors: {
    title: 'Subprocessors and connected services',
    body: ['Draft — pending legal review. Every service that receives customer or visitor data, what it receives, and where it is processed.'],
    recipients: true,
  },
};

function RecipientTable({ rows }: { rows: readonly DataRecipient[] }) {
  return (
    <div className="ak-scroll-x">
      <table className="ak-table">
        <thead>
          <tr><th>Service</th><th>Purpose</th><th>Data</th><th>Where</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name}><td>{r.name}</td><td>{r.purpose}</td><td>{r.data}</td><td>{r.region}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Each legal page has its own title (WCAG 2.4.2): Terms and Privacy never share the home page's. */
export async function generateMetadata({ params }: { params: Promise<{ doc: string }> }): Promise<Metadata> {
  const d = DOCS[(await params).doc];
  return d ? { title: d.title } : {};
}

export default async function LegalPage({ params }: { params: Promise<{ doc: string }> }) {
  const doc = (await params).doc;
  const d = DOCS[doc];
  if (!d) notFound();
  // Once counsel-reviewed documents are published elsewhere, staff point the legal URL settings at them
  // (plan 05 §20); every in-app link to /legal/terms and /legal/privacy then follows.
  if (doc === 'terms' || doc === 'privacy') {
    const url = await globalTx((tx) => setting(tx, doc === 'terms' ? 'legal.terms_url' : 'legal.privacy_url'));
    if (url !== `/legal/${doc}` && /^(https:\/\/|\/(?!\/))/.test(url)) redirect(url);
  }
  const user = await currentUser();
  return (
    <MarketingShell loggedIn={!!user}>
      <article className="ak-wrap ak-stack" style={{ maxWidth: 880, paddingTop: 24, paddingBottom: 48 }}>
        <h1 className="ak-display">{d.title}</h1>
        {d.body.map((p, i) => <p key={i} className="ak-muted">{p}</p>)}
        {d.recipients ? (
          <>
            <h2 className="ak-h2">Subprocessors</h2>
            <p className="ak-small ak-muted">They process data on our behalf to run Arkiv.</p>
            <RecipientTable rows={DATA_RECIPIENTS.filter((r) => r.kind === 'subprocessor')} />
            <h2 className="ak-h2">Services you choose to connect or sign in with</h2>
            <p className="ak-small ak-muted">Only used if you sign in with them or connect your store or ad account; you can disconnect at any time.</p>
            <RecipientTable rows={DATA_RECIPIENTS.filter((r) => r.kind !== 'subprocessor')} />
            {doc === 'privacy' ? <p className="ak-small"><Link href="/legal/subprocessors">Subprocessors page</Link></p> : null}
          </>
        ) : null}
      </article>
    </MarketingShell>
  );
}
