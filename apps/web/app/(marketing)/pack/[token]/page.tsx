import type { Metadata } from 'next';
import { globalTx } from '@arkiv/db';
import { openCreatorPack } from '@arkiv/core';
import { MarketingShell } from '@/components/marketing';
import { CreatorUpload } from '@/components/creator-upload';
import { formatDate } from '@arkiv/shared/format';

export const metadata: Metadata = { title: 'Creator brief', robots: { index: false, follow: false } };

/**
 * A Creator Pack (standard §26): the brief a brand shares with a creator by a private, expiring link — goal, hooks,
 * shots, approved and forbidden claims, CTA and framing — and where the creator uploads the footage back.
 */
export default async function CreatorPackPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const pack = await globalTx((tx) => openCreatorPack(tx, token));
  if (!pack) {
    return (
      <MarketingShell loggedIn={false}>
        <section className="ak-wrap ak-stack" style={{ maxWidth: 640, paddingTop: 24, paddingBottom: 48 }}>
          <p className="ak-label">Creator brief</p>
          <h1 className="ak-display">This link has expired</h1>
          <p className="ak-muted">Brief links last 14 days and the brand can turn them off. Ask the brand for a new one.</p>
        </section>
      </MarketingShell>
    );
  }
  const c = pack.content;
  return (
    <MarketingShell loggedIn={false}>
      <article className="ak-wrap ak-stack" style={{ maxWidth: 720, paddingTop: 24, paddingBottom: 48 }}>
        <p className="ak-label">Creator brief · {c.brandName ?? c.productName}</p>
        <h1 className="ak-display">{c.productName}</h1>
        <p>{c.goal}</p>
        {c.customerTension ? <p className="ak-muted">What your audience worries about: {c.customerTension}</p> : null}

        <h2 className="ak-label">Open with one of these hooks</h2>
        <ol>{c.hooks.map((h) => <li key={h}>“{h}”</li>)}</ol>
        <h2 className="ak-label">First shot</h2>
        <p>{c.firstShot}</p>
        <p className="ak-small">Show {c.productName} clearly by second {c.productVisibleBySec}.</p>

        <h2 className="ak-label">Shots</h2>
        <ol>
          {c.requiredShots.map((s) => (
            <li key={`${s.sec}-${s.shot}`}>
              <span className="ak-index">{s.sec.toFixed(1)}s</span> {s.shot}
              {s.say ? <div className="ak-muted">Say: “{s.say}”</div> : null}
              {s.onScreen ? <div className="ak-muted">On screen: {s.onScreen}</div> : null}
            </li>
          ))}
        </ol>

        <h2 className="ak-label">What you can say about the product</h2>
        {c.approvedClaims.length ? <ul>{c.approvedClaims.map((a) => <li key={a.wording}>{a.wording}{a.qualifier ? ` (${a.qualifier})` : ''}</li>)}</ul> : <p className="ak-muted">Describe how it looks, feels and fits your routine — no claims about what it does.</p>}
        <h2 className="ak-label">Never say or imply</h2>
        <ul>
          {c.forbiddenClaims.map((f) => <li key={f}>{f}</li>)}
          <li>That it treats, cures or heals any condition, or any before/after result</li>
        </ul>
        <h2 className="ak-label">Call to action</h2>
        <p>{c.cta}</p>
        <h2 className="ak-label">Framing</h2>
        <ul>{c.framing.map((f) => <li key={f}>{f}</li>)}</ul>
        {c.voiceover ? (
          <>
            <h2 className="ak-label">Example voice-over (optional)</h2>
            <p className="ak-muted">“{c.voiceover}”</p>
          </>
        ) : null}

        <hr className="ak-rule" />
        <h2 className="ak-label">Send your footage</h2>
        <CreatorUpload token={token} brand={c.brandName ?? c.productName} />
        <p className="ak-small ak-muted">This link works until {formatDate(pack.expiresAt)}.</p>
      </article>
    </MarketingShell>
  );
}
