'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export function Nav({ nav, staff, pending }: { nav: { group: string; items: { href: string; label: string }[] }[]; staff: { name: string; roles: string[] }; pending: number }) {
  const path = usePathname();
  const on = (h: string) => (h === '/' ? path === '/' : path.startsWith(h));
  return (
    <nav className="ak-nav" aria-label="Console" style={{ overflowY: 'auto' }}>
      <div className="ak-ws-switch" style={{ fontSize: 16 }}>Arkiv Admin</div>
      {nav.map((g) => (
        <div key={g.group} style={{ marginTop: 12 }}>
          <p className="ak-label" style={{ margin: '0 8px 4px' }}>{g.group}</p>
          {g.items.map((i) => (
            <Link key={i.href} href={i.href} aria-current={on(i.href) ? 'page' : undefined} style={{ padding: '6px 8px' }}>
              <span>{i.label}</span>
              {i.href === '/approvals' && pending ? <span className="ak-chip ak-chip--warn">{pending}</span> : null}
            </Link>
          ))}
        </div>
      ))}
      <div style={{ marginTop: 'auto', paddingTop: 16 }} className="ak-small">
        <div>{staff.name}</div>
        <div className="ak-muted ak-mono" style={{ fontSize: 11 }}>{staff.roles.join(' · ')}</div>
        <button className="ak-textbtn" onClick={async () => { await fetch('/api/logout', { method: 'POST' }); window.location.assign('/login'); }}>Sign out</button>
      </div>
    </nav>
  );
}
