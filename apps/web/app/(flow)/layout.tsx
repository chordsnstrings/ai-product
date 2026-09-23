import Link from 'next/link';
import type { ReactNode } from 'react';
import { currentUser } from '@/lib/session';

/** Funnel chrome: wordmark only, no navigation away from the task (plan 04 L1). */
export default async function FlowLayout({ children }: { children: ReactNode }) {
  const user = await currentUser();
  return (
    <div data-theme="light" style={{ background: 'var(--paper)', minHeight: '100vh' }}>
      <header className="ak-wrap ak-between" style={{ paddingTop: 20, paddingBottom: 20 }}>
        <Link href="/" className="ak-wordmark">Arkiv</Link>
        <span className="ak-small ak-muted">{user ? user.email : 'No account needed to preview'}</span>
      </header>
      <main>{children}</main>
    </div>
  );
}
