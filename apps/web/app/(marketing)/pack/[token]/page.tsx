import type { Metadata } from 'next';
import { globalTx } from '@arkiv/db';
import { CREATOR_SAFE_ZONE, openCreatorPack } from '@arkiv/core';
import { MarketingShell } from '@/components/marketing';
import { CreatorUpload } from '@/components/creator-upload';
import { formatDate } from '@arkiv/shared/format';

export const metadata: Metadata = { title: 'Creator brief', robots: { index: false, follow: false } };

/**
 * A Creator Pack (standard §26): the brief a brand shares with a creator by a private, expiring link — goal, hooks,
 * shots, approved and forbidden claims, CTA and framing — and where the creator uploads the footage back.
 */
/**
 * Plan 03 A7 "safe-zone overlay diagram": a 9:16 frame with the areas the platforms cover (top, bottom captions and
 * buttons, right-hand icons) shaded, and the safe centre where the product and any text belong.
 */
function SafeZoneDiagram() {
  const W = 90;
  const H = 160;
  const z = CREATOR_SAFE_ZONE;
  const safe = { x: W * z.left, y: H * z.top, w: W * (1 - z.left - z.right), h: H * (1 - z.top - z.bottom) };
  return (
    <figure className="ak-row" style={{ gap: 16, alignItems: 'center', margin: 0 }}>
      <svg viewBox={`0 0 ${W} ${H}`} width={W * 1.5} height={H * 1.5} role="img" aria-labelledby="safe-zone-title">
        <title id="safe-zone-title">9:16 frame: keep the product and text inside the centre box; the shaded edges are covered by the app.</title>
        <rect x="0.5" y="0.5" width={W - 1} height={H - 1} fill="none" stroke="currentColor" />
        <rect x="0" y="0" width={W} height={H * z.top} fill="currentColor" opacity="0.15" />
        <rect x="0" y={H * (1 - z.bottom)} width={W} height={H * z.bottom} fill="currentColor" opacity="0.15" />
        <rect x={W * (1 - z.right)} y={H * z.top} width={W * z.right} height={H * (1 - z.top - z.bottom)} fill="currentColor" opacity="0.15" />
        <rect x={safe.x} y={safe.y} width={safe.w} height={safe.h} fill="none" stroke="currentColor" strokeDasharray="3 2" />
        <text x={safe.x + safe.w / 2} y={safe.y + safe.h / 2} textAnchor="middle" fontSize="7" fill="currentColor">Safe area</text>
        <text x={W / 2} y={H * (1 - z.bottom / 2) + 2} textAnchor="middle" fontSize="6" fill="currentColor">Captions · buttons</text>
      </svg>
      <figcaption className="ak-small ak-muted" style={{ maxWidth: 280 }}>
        The shaded edges are covered by TikTok and Reels: the top {Math.round(z.top * 100)}%, the bottom {Math.round(z.bottom * 100)}% and the right {Math.round(z.right * 100)}%. Keep the product, the label and any text inside the dashed box.
      </figcaption>
    </figure>
  );
}

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
        <SafeZoneDiagram />
        {c.voiceover ? (
          <>
            <h2 className="ak-label">Example voice-over (optional)</h2>
            <p className="ak-muted">“{c.voiceover}”</p>
          </>
        ) : null}

        {/* Printable (plan 03 A7): the brief prints on its own; the upload form is for the screen. */}
        <div className="ak-no-print ak-stack">
          <hr className="ak-rule" />
          <h2 className="ak-label">Send your footage</h2>
          <CreatorUpload token={token} brand={c.brandName ?? c.productName} />
        </div>
        <p className="ak-small ak-muted">This link works until {formatDate(pack.expiresAt)}.</p>
      </article>
    </MarketingShell>
  );
}
