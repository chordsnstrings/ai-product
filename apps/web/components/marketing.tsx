import Link from 'next/link';
import type { ReactNode } from 'react';
import { globalTx } from '@arkiv/db';
import { setting } from '@arkiv/core';

/** Support address and legal links are platform settings (plan 05 §20), editable in the staff console. */
async function footerSettings() {
  return globalTx(async (tx) => ({ support: await setting(tx, 'support.email'), terms: await setting(tx, 'legal.terms_url'), privacy: await setting(tx, 'legal.privacy_url') }));
}

/** Marketing chrome: no nav menu (single path, plan 04 L1); light theme only (design §7). */
export async function MarketingShell({ children, loggedIn }: { children: ReactNode; loggedIn: boolean }) {
  const f = await footerSettings();
  return (
    <div data-theme="light" style={{ background: 'var(--paper)', minHeight: '100vh' }}>
      <header className="ak-wrap ak-between" style={{ paddingTop: 20, paddingBottom: 20 }}>
        <Link href="/" className="ak-wordmark">Arkiv</Link>
        {loggedIn ? <Link className="ak-textbtn" href="/app">Your archive</Link> : <Link className="ak-textbtn" href="/login">Log in</Link>}
      </header>
      <main>{children}</main>
      <footer className="ak-wrap" style={{ padding: '48px var(--gutter) 96px' }}>
        <hr className="ak-rule" />
        <div className="ak-between ak-small ak-muted" style={{ paddingTop: 16, flexWrap: 'wrap' }}>
          <span>Arkiv · Creative testing for skincare brands</span>
          <span className="ak-row">
            <Link href="/pricing">Pricing</Link>
            <Link href={f.terms}>Terms</Link>
            <Link href={f.privacy}>Privacy</Link>
            <Link href="/legal/subprocessors">Subprocessors</Link>
            <Link href="/rights">Report a rights issue</Link>
            <a href={`mailto:${f.support}`}>Contact</a>
          </span>
        </div>
      </footer>
    </div>
  );
}
