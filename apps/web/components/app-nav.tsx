'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';

const MAIN = [
  { href: 'this-week', label: 'This Week' },
  { href: 'map', label: 'Creative Map' },
  { href: 'studio', label: 'Studio' },
  { href: 'products', label: 'Products' },
  { href: 'results', label: 'Results' },
];

export function AppNav({ slug, workspaces, current, meter }: { slug: string; workspaces: { slug: string; name: string }[]; current: string; meter: string | null }) {
  const path = usePathname();
  const router = useRouter();
  const is = (h: string) => path.startsWith(`/w/${slug}/${h}`);
  return (
    <nav className="ak-nav" aria-label="Workspace">
      <div className="ak-ws-switch">
        {workspaces.length > 1 ? (
          // WCAG 3.2.2 On Input: choosing an option never navigates by itself (arrow keys on a closed select change
          // it); the switch happens on the button or Enter.
          <form
            className="ak-row"
            style={{ gap: 8, flexWrap: 'nowrap' }}
            onSubmit={(e) => {
              e.preventDefault();
              const to = new FormData(e.currentTarget).get('workspace');
              if (typeof to === 'string' && to && to !== slug) router.push(`/w/${to}/this-week`);
            }}
          >
            <select name="workspace" aria-label="Workspace" defaultValue={slug} key={slug}>
              {workspaces.map((w) => <option key={w.slug} value={w.slug}>{w.name}</option>)}
            </select>
            <button type="submit" className="ak-textbtn ak-small">Switch</button>
          </form>
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
  // Five tabs on the phone (plan 03 Part B); Settings is in the phone header.
  const items = MAIN.map((m) => ({ ...m, label: m.label.replace('Creative ', '') }));
  return (
    <nav className="ak-tabbar" aria-label="Workspace">
      {items.map((m) => (
        <Link key={m.href} href={`/w/${slug}/${m.href}`} aria-current={path.startsWith(`/w/${slug}/${m.href.split('/')[0]}`) ? 'page' : undefined}>{m.label}</Link>
      ))}
    </nav>
  );
}
