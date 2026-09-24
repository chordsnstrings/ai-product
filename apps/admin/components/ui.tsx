import Link from 'next/link';
import type { ReactNode } from 'react';
import { formatDate, formatDateTime, formatTime } from '@arkiv/shared/format';
import { requestTz } from '@/lib/prefs';

export const money = (micros: number | string | null | undefined, d = 2) => `$${(Number(micros ?? 0) / 1e6).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`;
/** Dates are stored in UTC and shown in the console timezone (plan 05 §1), or an explicit one. */
/** House format (design §6): `23 Sep 2026`, `14:02 ET` — in the console timezone. */
export const dt = (v: unknown, tz = requestTz().tz) => (v ? formatDateTime(v as string, { timeZone: tz }) || '—' : '—');
export const d = (v: unknown, tz = requestTz().tz) => (v ? formatDate(v as string, { timeZone: tz }) || '—' : '—');
export const tm = (v: unknown, tz = requestTz().tz) => (v ? formatTime(v as string, { timeZone: tz }) || '—' : '—');
export const ago = (v: unknown) => {
  if (!v) return '—';
  const s = (Date.now() - new Date(v as string).getTime()) / 1000;
  return s < 90 ? `${Math.round(s)}s` : s < 5400 ? `${Math.round(s / 60)}m` : s < 172800 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`;
};
export const pct = (n: number, dd = 1) => (Number.isFinite(n) ? `${(n * 100).toFixed(dd)}%` : '—');

export function Page({ title, sub, actions, children }: { title: string; sub?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <>
      <div className="ak-between" style={{ alignItems: 'end', gap: 16, flexWrap: 'wrap', marginBottom: 16 }}>
        <div>
          <h1 className="ak-h2" style={{ margin: 0 }}>{title}</h1>
          {sub ? <p className="ak-small ak-muted" style={{ margin: '4px 0 0' }}>{sub}</p> : null}
        </div>
        {actions ? <div className="ak-row">{actions}</div> : null}
      </div>
      {children}
    </>
  );
}

export function Section({ title, children, right }: { title: string; children: ReactNode; right?: ReactNode }) {
  return (
    <section style={{ marginTop: 24 }}>
      <div className="ak-between"><h2 className="ak-label">{title}</h2>{right}</div>
      {children}
    </section>
  );
}

export function Table({ head, rows, empty = 'Nothing here.' }: { head: ReactNode[]; rows: ReactNode[][]; empty?: string }) {
  if (!rows.length) return <p className="ak-small ak-muted">{empty}</p>;
  return (
    <div className="ak-scroll-x">
      <table className="ak-table">
        <thead><tr>{head.map((h, i) => <th key={i}>{h}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

/** A metric tile. An alert is spelled out (chip + text), never shown by colour alone (WCAG 1.4.1). */
export function Kpi({ label, value, sub, alert, alertText = 'Alert', href }: { label: string; value: ReactNode; sub?: ReactNode; alert?: boolean; alertText?: string; href?: string }) {
  const inner = (
    <div className="ak-panel ak-kpi" style={{ padding: 14, borderColor: alert ? 'var(--risk)' : undefined }}>
      <span className="ak-between" style={{ alignItems: 'start' }}>
        <span className="ak-label" style={{ margin: 0 }}>{label}</span>
        {alert ? <span className="ak-chip ak-chip--risk"><span aria-hidden="true">⚠</span> {alertText}</span> : null}
      </span>
      <strong style={{ color: alert ? 'var(--risk)' : undefined }}>{value}</strong>
      {sub ? <span className="ak-small ak-muted">{sub}</span> : null}
    </div>
  );
  return href ? <Link href={href} style={{ textDecoration: 'none', color: 'inherit' }}>{inner}</Link> : inner;
}

export function Grid({ children, min = 200 }: { children: ReactNode; min?: number }) {
  return <div style={{ display: 'grid', gap: 12, gridTemplateColumns: `repeat(auto-fill, minmax(${min}px, 1fr))` }}>{children}</div>;
}

/** Section tabs: the current tab carries aria-current, not just an underline (WCAG 1.3.1 / 4.1.2). */
export function Tabs({ base, tabs, current, label = 'Sections', params }: { base: string; tabs: [string, string][]; current: string; label?: string; params?: Record<string, string | undefined> }) {
  const href = (k: string) => {
    const q = new URLSearchParams(Object.entries(params ?? {}).filter((e): e is [string, string] => !!e[1]));
    q.set('tab', k);
    return `${base}?${q}`;
  };
  return (
    <nav aria-label={label} className="ak-row ak-scroll-x" style={{ borderBottom: '1px solid var(--rule)', flexWrap: 'nowrap', margin: '12px 0 16px' }}>
      {tabs.map(([k, l]) => (
        <Link key={k} href={href(k)} aria-current={k === current ? 'page' : undefined} className="ak-textbtn" style={{ paddingBottom: 6, whiteSpace: 'nowrap', fontWeight: k === current ? 600 : undefined, borderBottom: k === current ? '2px solid var(--ink)' : '2px solid transparent' }}>{l}</Link>
      ))}
    </nav>
  );
}

/**
 * A filter toggle rendered as a link: its state is exposed (aria-current) and shown with a ✓, not by fill
 * colour alone (WCAG 1.4.1, 4.1.2).
 */
export function FilterChip({ href, on, children }: { href: string; on: boolean; children: ReactNode }) {
  return (
    <Link href={href} className={`ak-chip${on ? ' ak-chip--dec' : ''}`} aria-current={on ? 'true' : undefined}>
      {on ? <span aria-hidden="true">✓ </span> : null}{children}
    </Link>
  );
}

export const Mono = ({ children }: { children: ReactNode }) => <span className="ak-mono" style={{ fontSize: 12 }}>{children}</span>;
