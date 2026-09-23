import { notFound, redirect } from 'next/navigation';
import { globalTx } from '@arkiv/db';
import { setting } from '@arkiv/core';
import { MarketingShell } from '@/components/marketing';
import { currentUser } from '@/lib/session';

/**
 * Placeholder legal pages. These MUST be replaced by counsel-reviewed text before paid launch
 * (plan 06 Phase 6: consumer-protection review of checkout, plans and cancel flows).
 */
const DOCS: Record<string, { title: string; body: string[] }> = {
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
      'Subprocessors: DigitalOcean (hosting), Stripe (payments), Resend (email), Anthropic, BytePlus and MiniMax (AI processing).',
    ],
  },
};

export default async function LegalPage({ params }: { params: Promise<{ doc: string }> }) {
  const doc = (await params).doc;
  const d = DOCS[doc];
  if (!d) notFound();
  // Once counsel-reviewed documents are published elsewhere, staff point the legal URL settings at them
  // (plan 05 §20); every in-app link to /legal/* then follows.
  const url = await globalTx((tx) => setting(tx, doc === 'terms' ? 'legal.terms_url' : 'legal.privacy_url'));
  if (url !== `/legal/${doc}` && /^(https:\/\/|\/(?!\/))/.test(url)) redirect(url);
  const user = await currentUser();
  return (
    <MarketingShell loggedIn={!!user}>
      <article className="ak-wrap ak-stack" style={{ maxWidth: 720, paddingTop: 24, paddingBottom: 48 }}>
        <h1 className="ak-display">{d.title}</h1>
        {d.body.map((p, i) => <p key={i} className="ak-muted">{p}</p>)}
      </article>
    </MarketingShell>
  );
}
