'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Sheet } from '@arkiv/ui/client';
import { GOTO, gotoTarget, isTyping, moveRow, paletteItems } from '@/lib/keys';

type Group = { group: string; items: { href: string; label: string }[] };

/**
 * Console keyboard layer (plan 05 "keyboard-first"): g-chords between modules, / to search, ⌘K / Ctrl+K command
 * palette (modules, tenant / user / audit lookup), ? for help. Keys typed into fields are never taken.
 */
export function Keys({ nav }: { nav: Group[] }) {
  const router = useRouter();
  const [palette, setPalette] = useState(false);
  const [help, setHelp] = useState(false);
  const allowed = useMemo(() => new Set(nav.flatMap((g) => g.items.map((i) => i.href))), [nav]);
  const chord = useRef<number>(0);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette(true);
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target as HTMLElement | null)) return;
      if (chord.current && Date.now() - chord.current < 1200) {
        chord.current = 0;
        const href = gotoTarget(e.key, allowed);
        if (href) {
          e.preventDefault();
          router.push(href);
        }
        return;
      }
      if (e.key === 'g') {
        chord.current = Date.now();
        return;
      }
      if (e.key === '/') {
        e.preventDefault();
        const search = document.querySelector<HTMLInputElement>('main input[name="q"], main input[type="search"], main [data-search]');
        if (search) search.focus();
        else setPalette(true);
        return;
      }
      if (e.key === '?') {
        e.preventDefault();
        setHelp(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [allowed, router]);
  const labels = new Map(nav.flatMap((g) => g.items.map((i) => [i.href, i.label] as const)));
  return (
    <>
      <Palette open={palette} onOpenChange={setPalette} nav={nav} />
      <Sheet open={help} onOpenChange={setHelp} title="Keyboard shortcuts">
        <table className="ak-table">
          <tbody>
            <Row k="⌘K / Ctrl+K">Command palette: modules, find a tenant, user or audit entries</Row>
            <Row k="/">Search on this page (palette where there is no search)</Row>
            <Row k="j / k  ↓ / ↑">Move between table rows</Row>
            <Row k="Enter">Open the focused row</Row>
            <Row k="?">This help</Row>
            {Object.entries(GOTO).filter(([, href]) => allowed.has(href)).map(([key, href]) => <Row key={key} k={`g ${key}`}>{labels.get(href) ?? href}</Row>)}
          </tbody>
        </table>
      </Sheet>
    </>
  );
}

const Row = ({ k, children }: { k: string; children: ReactNode }) => (
  <tr>
    <td><kbd className="ak-mono">{k}</kbd></td>
    <td>{children}</td>
  </tr>
);

function Palette({ open, onOpenChange, nav }: { open: boolean; onOpenChange: (o: boolean) => void; nav: Group[] }) {
  const router = useRouter();
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const items = useMemo(() => paletteItems(q, nav).slice(0, 12), [q, nav]);
  useEffect(() => {
    if (open) {
      setQ('');
      setSel(0);
    }
  }, [open]);
  const go = (href: string) => {
    onOpenChange(false);
    router.push(href);
  };
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Go to">
      <input
        className="ak-input"
        autoFocus
        aria-label="Module, tenant, user or audit search"
        placeholder="Tenant name, email, id, cus_…, or a module"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setSel(0);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setSel((s) => moveRow(s, 1, items.length));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setSel((s) => moveRow(s, -1, items.length));
          } else if (e.key === 'Enter' && items[sel]) {
            e.preventDefault();
            go(items[sel]!.href);
          }
        }}
      />
      <ul role="listbox" aria-label="Results" style={{ listStyle: 'none', padding: 0, margin: '8px 0 0' }}>
        {items.map((it, i) => (
          <li key={it.href} role="option" aria-selected={i === sel}>
            <button type="button" className="ak-textbtn" onClick={() => go(it.href)} style={{ display: 'flex', justifyContent: 'space-between', width: '100%', padding: '6px 8px', background: i === sel ? 'var(--paper-sunk)' : undefined }}>
              <span>{it.label}</span>
              {it.hint ? <span className="ak-small ak-muted">{it.hint}</span> : null}
            </button>
          </li>
        ))}
      </ul>
    </Sheet>
  );
}

/**
 * A dense table with a keyboard row cursor (j/k or ↓/↑, Enter opens the row's first link) and a header that stays
 * in view while a long table scrolls.
 */
export function KeyTable({ children, tall }: { children: ReactNode; tall: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const rows = () => [...el.querySelectorAll<HTMLTableRowElement>('tbody > tr')];
    for (const r of rows()) r.tabIndex = -1;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target as HTMLElement | null)) return;
      const all = rows();
      const current = all.findIndex((r) => r === document.activeElement || r.contains(document.activeElement));
      const inTable = current >= 0 || el.contains(document.activeElement);
      const down = e.key === 'j' || (inTable && e.key === 'ArrowDown');
      const up = e.key === 'k' || (inTable && e.key === 'ArrowUp');
      // j/k drive the first table on the page unless focus is already in another one.
      const first = document.querySelector('[data-keytable]') === el;
      if ((down || up) && (inTable || (first && !document.activeElement?.closest('[data-keytable]')))) {
        e.preventDefault();
        const next = moveRow(current, down ? 1 : -1, all.length);
        all[next]?.focus();
        all[next]?.scrollIntoView({ block: 'nearest' });
        return;
      }
      if (e.key === 'Enter' && current >= 0 && document.activeElement === all[current]) {
        const link = all[current]!.querySelector<HTMLAnchorElement>('a[href]');
        if (link) {
          e.preventDefault();
          link.click();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  return (
    <div ref={box} data-keytable className="ak-scroll-x ak-keytable" style={tall ? { maxHeight: '75vh', overflowY: 'auto' } : undefined}>
      {children}
    </div>
  );
}
