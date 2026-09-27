import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="ak-wrap ak-section" style={{ maxWidth: 560 }}>
      <p className="ak-index">404</p>
      <h1 className="ak-h1">Not in the archive</h1>
      <p className="ak-muted">This page doesn’t exist, or you don’t have access to it.</p>
      <Link className="ak-btn" href="/app">Go to your archive</Link>
    </div>
  );
}
