'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const TABS = [
  ['members', 'Members'],
  ['billing', 'Billing'],
  ['integrations', 'Integrations'],
  ['brand', 'Brand'],
  ['access-log', 'Access log'],
  ['data', 'Data'],
  ['profile', 'Profile'],
] as const;

export function SettingsTabs({ slug }: { slug: string }) {
  const path = usePathname();
  return (
    <nav className="ak-row ak-scroll-x" aria-label="Settings" style={{ borderBottom: '1px solid var(--rule)', flexWrap: 'nowrap' }}>
      {TABS.map(([k, l]) => {
        const on = path.endsWith(`/settings/${k}`);
        return (
          <Link key={k} href={`/w/${slug}/settings/${k}`} aria-current={on ? 'page' : undefined} className="ak-textbtn" style={{ paddingBottom: 8, whiteSpace: 'nowrap', borderBottom: on ? '1px solid var(--ink)' : '1px solid transparent' }}>
            {l}
          </Link>
        );
      })}
    </nav>
  );
}
