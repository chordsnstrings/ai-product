import Link from 'next/link';
import type { ReactNode } from 'react';

export const money = (micros: number | string | null | undefined, d = 2) => `$${(Number(micros ?? 0) / 1e6).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`;
export const dt = (v: unknown) => (v ? new Date(v as string).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
export const d = (v: unknown) => (v ? new Date(v as string).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—');
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

export function Kpi({ label, value, sub, alert, href }: { label: string; value: ReactNode; sub?: ReactNode; alert?: boolean; href?: string }) {
  const inner = (
    <div className="ak-panel ak-kpi" style={{ padding: 14, borderColor: alert ? 'var(--risk)' : undefined }}>
      <span className="ak-label" style={{ margin: 0 }}>{label}</span>
      <strong style={{ color: alert ? 'var(--risk)' : undefined }}>{value}</strong>
      {sub ? <span className="ak-small ak-muted">{sub}</span> : null}
    </div>
  );
  return href ? <Link href={href} style={{ textDecoration: 'none', color: 'inherit' }}>{inner}</Link> : inner;
}

export function Grid({ children, min = 200 }: { children: ReactNode; min?: number }) {
  return <div style={{ display: 'grid', gap: 12, gridTemplateColumns: `repeat(auto-fill, minmax(${min}px, 1fr))` }}>{children}</div>;
}

export function Tabs({ base, tabs, current }: { base: string; tabs: [string, string][]; current: string }) {
  return (
    <nav className="ak-row ak-scroll-x" style={{ borderBottom: '1px solid var(--rule)', flexWrap: 'nowrap', margin: '12px 0 16px' }}>
      {tabs.map(([k, l]) => (
        <Link key={k} href={`${base}?tab=${k}`} className="ak-textbtn" style={{ paddingBottom: 6, whiteSpace: 'nowrap', borderBottom: k === current ? '1px solid var(--ink)' : '1px solid transparent' }}>{l}</Link>
      ))}
    </nav>
  );
}

export const Mono = ({ children }: { children: ReactNode }) => <span className="ak-mono" style={{ fontSize: 12 }}>{children}</span>;
