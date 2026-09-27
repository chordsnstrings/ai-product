'use client';

import { useEffect, useState } from 'react';
import { UploadModule } from './upload-module';

type Resume = { signedIn: boolean; continue: { name: string; href: string } | null };

/**
 * The landing hero's call to action (plan 03 P1 states). The page is static, so the visitor's own state is read
 * here after it loads: a signed-in user sees "Go to your archive" plus a compact "Add a product"; a returning
 * visitor with a preview in progress sees "Continue with <product>" in place of the upload (L18), with "Start a new
 * product" behind it; everyone else — and anyone while this loads or if it fails — the upload module.
 */
export function HeroCta(props: { page: string; variant: string | null; turnstileSiteKey: string | null; assurance?: string }) {
  const [resume, setResume] = useState<Resume | null>(null);
  const [fresh, setFresh] = useState(false);
  useEffect(() => {
    let alive = true;
    fetch('/api/resume', { credentials: 'same-origin', cache: 'no-store' })
      .then((r) => (r.ok ? (r.json() as Promise<Resume>) : null))
      .then((r) => alive && r && setResume(r))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  if (resume?.signedIn) {
    return (
      <div className="ak-stack">
        <a className="ak-btn ak-btn--accent ak-btn--block" href="/app">Go to your archive</a>
        <p className="ak-label" style={{ margin: '8px 0 0' }}>Add a product</p>
        <UploadModule {...props} compact />
      </div>
    );
  }
  if (resume?.continue && !fresh) {
    return (
      <div className="ak-panel ak-stack" id="upload">
        <p className="ak-label" style={{ margin: 0 }}>Welcome back</p>
        <a className="ak-btn ak-btn--accent ak-btn--block" href={resume.continue.href}>Continue with {resume.continue.name}</a>
        <button type="button" className="ak-textbtn" onClick={() => setFresh(true)}>Start a new product</button>
      </div>
    );
  }
  return <UploadModule {...props} />;
}
