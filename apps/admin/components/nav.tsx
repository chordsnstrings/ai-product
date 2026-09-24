'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Sheet } from '@arkiv/ui/client';

type Group = { group: string; items: { href: string; label: string }[] };
export interface NavPrefs {
  tz: string;
  range: number;
  includeTest: boolean;
  timezones: readonly string[];
}

const COOKIE_AGE = 60 * 60 * 24 * 365;
const setPref = (name: string, value: string) => {
  document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=${COOKIE_AGE}; samesite=strict`;
};

/**
 * Console-wide date range, timezone and test-account preferences (plan 05 §1, §2.3). Stored as cookies; every
 * page reads them on the server, and times are shown in the chosen zone (data stays in UTC).
 */
function Prefs({ prefs, idPrefix }: { prefs: NavPrefs; idPrefix: string }) {
  const router = useRouter();
  const change = (name: string, value: string) => {
    setPref(name, value);
    router.refresh();
  };
  return (
    <div className="ak-stack" style={{ ['--stack' as string]: '8px' }}>
      <label className="ak-field" htmlFor={`${idPrefix}-tz`}>
        <span className="ak-label">Timezone</span>
        <select id={`${idPrefix}-tz`} className="ak-input" style={{ minHeight: 32, padding: '4px 8px' }} value={prefs.tz} onChange={(e) => change('ak_tz', e.target.value)}>
          {prefs.timezones.map((z) => <option key={z} value={z}>{z}</option>)}
        </select>
      </label>
      <div role="group" aria-label="Date range" className="ak-row" style={{ gap: 6, flexWrap: 'wrap' }}>
        {[1, 7, 30].map((r) => (
          <button key={r} type="button" className={`ak-chip${prefs.range === r ? ' ak-chip--dec' : ''}`} aria-pressed={prefs.range === r} onClick={() => change('ak_range', String(r))}>
            {prefs.range === r ? '✓ ' : ''}{r === 1 ? 'Today' : `${r}d`}
          </button>
        ))}
      </div>
      <label className="ak-row ak-small" style={{ gap: 6 }}>
        <input type="checkbox" checked={prefs.includeTest} onChange={(e) => change('ak_test', e.target.checked ? '1' : '0')} />
        Include test accounts
      </label>
    </div>
  );
}

function Links({ nav, pending, onNavigate }: { nav: Group[]; pending: number; onNavigate?: () => void }) {
  const path = usePathname();
  const on = (h: string) => (h === '/' ? path === '/' : path.startsWith(h));
  return (
    <>
      {nav.map((g) => (
        <div key={g.group} style={{ marginTop: 12 }}>
          <p className="ak-label" style={{ margin: '0 8px 4px' }}>{g.group}</p>
          {g.items.map((i) => (
            <Link key={i.href} href={i.href} onClick={onNavigate} aria-current={on(i.href) ? 'page' : undefined} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 8px', textDecoration: 'none', borderBottom: on(i.href) ? '1px solid var(--ink)' : '1px solid transparent' }}>
              <span>{i.label}</span>
              {i.href === '/approvals' && pending ? <span className="ak-chip ak-chip--warn">{pending}<span className="ak-sr"> pending</span></span> : null}
            </Link>
          ))}
        </div>
      ))}
    </>
  );
}

function Account({ staff }: { staff: { name: string; roles: string[] } }) {
  return (
    <div className="ak-small">
      <div>{staff.name}</div>
      <div className="ak-muted ak-mono" style={{ fontSize: 11 }}>{staff.roles.join(' · ')}</div>
      <div className="ak-row" style={{ gap: 12 }}>
        <Link href="/account" className="ak-textbtn">Passkeys</Link>
        <button className="ak-textbtn" onClick={async () => { await fetch('/api/logout', { method: 'POST' }); window.location.assign('/login'); }}>Sign out</button>
      </div>
    </div>
  );
}

/**
 * Left rail on wide screens; below 900px (phones, and desktops zoomed to 200–400%) a top bar with a Menu
 * button opens the same grouped navigation in a sheet, so every module stays reachable (WCAG 1.4.10 reflow).
 */
export function Nav({ nav, staff, pending, prefs }: { nav: Group[]; staff: { name: string; roles: string[] }; pending: number; prefs: NavPrefs }) {
  const [open, setOpen] = useState(false);
  const path = usePathname();
  useEffect(() => {
    setOpen(false);
  }, [path]);
  return (
    <>
      <header className="ak-topbar ak-topbar--mobile">
        <span className="ak-ws-switch" style={{ fontSize: 16, padding: 0, border: 0 }}>Arkiv Admin</span>
        <button type="button" className="ak-btn ak-btn--secondary ak-btn--sm" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
          Menu{pending ? <span className="ak-chip ak-chip--warn" style={{ marginLeft: 6 }}>{pending}<span className="ak-sr"> pending approvals</span></span> : null}
        </button>
      </header>
      <nav className="ak-nav" aria-label="Console" style={{ overflowY: 'auto' }}>
        <div className="ak-ws-switch" style={{ fontSize: 16 }}>Arkiv Admin</div>
        <Links nav={nav} pending={pending} />
        <div style={{ marginTop: 'auto', paddingTop: 16 }} className="ak-stack">
          <Prefs prefs={prefs} idPrefix="rail" />
          <Account staff={staff} />
        </div>
      </nav>
      <Sheet open={open} onOpenChange={setOpen} title="Console">
        <nav aria-label="Console menu">
          <Links nav={nav} pending={pending} onNavigate={() => setOpen(false)} />
        </nav>
        <div className="ak-stack" style={{ marginTop: 16 }}>
          <Prefs prefs={prefs} idPrefix="sheet" />
          <Account staff={staff} />
        </div>
      </Sheet>
    </>
  );
}
