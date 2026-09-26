'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';

const MAIN = [
  { href: 'this-week', label: 'This Week' },
  { href: 'map', label: 'Creative Map' },
  { href: 'results', label: 'Results' },
  { href: 'products', label: 'Products' },
];

export function AppNav({ slug, workspaces, current, meter }: { slug: string; workspaces: { slug: string; name: string }[]; current: string; meter: string | null }) {
  const path = usePathname();
  const router = useRouter();
  const is = (h: string) => path.startsWith(`/w/${slug}/${h}`);
  return (
    <nav className="ak-nav" aria-label="Workspace">
      <div className="ak-ws-switch">
        {workspaces.length > 1 ? (
          <select aria-label="Switch workspace" value={slug} onChange={(e) => router.push(`/w/${e.target.value}/this-week`)}>
            {workspaces.map((w) => <option key={w.slug} value={w.slug}>{w.name}</option>)}
          </select>
        ) : (
          <span>{current}</span>
        )}
      </div>
      {MAIN.map((m) => (
        <Link key={m.href} href={`/w/${slug}/${m.href}`} aria-current={is(m.href) ? 'page' : undefined}>{m.label}</Link>
      ))}
      <Link href="/start" style={{ marginTop: 8 }}>+ New product</Link>
      <div className="ak-nav-group">
        <Link href={`/w/${slug}/settings/members`} aria-current={is('settings') ? 'page' : undefined}>Settings</Link>
      </div>
      <div style={{ marginTop: 'auto' }} className="ak-small ak-muted">{meter}</div>
    </nav>
  );
}

export function TabBar({ slug }: { slug: string }) {
  const path = usePathname();
  const items = [...MAIN.map((m) => ({ ...m, label: m.label.replace('Creative ', '') })), { href: 'settings/members', label: 'Settings' }];
  return (
    <nav className="ak-tabbar" aria-label="Workspace">
      {items.map((m) => (
        <Link key={m.href} href={`/w/${slug}/${m.href}`} aria-current={path.startsWith(`/w/${slug}/${m.href.split('/')[0]}`) ? 'page' : undefined}>{m.label}</Link>
      ))}
    </nav>
  );
}
