'use client';

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="ak-wrap ak-section" style={{ maxWidth: 560 }}>
      <h1 className="ak-h1">Something went wrong on our side</h1>
      <p className="ak-muted">Your work is saved. Try again — if it keeps happening, email support@arkiv.app{error.digest ? ` with reference ${error.digest}` : ''}.</p>
      <button className="ak-btn" onClick={reset}>Try again</button>
    </div>
  );
}
