import Link from 'next/link';
import type { ReactNode } from 'react';
import { ConfirmHost, ThemeScope } from '@arkiv/ui/client';
import { StatusBanner } from '@/components/status-banner';
import { currentUser } from '@/lib/session';

/** Funnel chrome: wordmark only, no navigation away from the task (plan 04 L1). */
export default async function FlowLayout({ children }: { children: ReactNode }) {
  const user = await currentUser();
  return (
    // Light-only (design §7); sheets opened here portal out and take the same theme from the scope.
    <ThemeScope theme="light">
      <StatusBanner />
      <header className="ak-wrap ak-between" style={{ paddingTop: 20, paddingBottom: 20 }}>
        <Link href="/" className="ak-wordmark">Arkiv</Link>
        <span className="ak-small ak-muted">{user ? user.email : 'No account needed to preview'}</span>
      </header>
      <main>{children}</main>
      <ConfirmHost />
    </ThemeScope>
  );
}
