'use client';

import { useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';

async function post(url: string, body: unknown) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(j.error ?? 'Failed') as Error & { details?: Record<string, unknown> };
    e.details = j.details ?? undefined;
    throw e;
  }
  return j as Record<string, unknown>;
}

/** Runs an admin action; if the server asks for a fresh second factor (🔐), prompts for a TOTP code and retries once. */
export async function act(action: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  try {
    return await post(`/api/act/${action}`, payload);
  } catch (e) {
    if ((e as { details?: { reauth?: boolean } }).details?.reauth) {
      const code = window.prompt('Confirm with your authenticator code');
      if (!code) throw new Error('Cancelled');
      await post('/api/reauth', { code });
      return post(`/api/act/${action}`, payload);
    }
    throw e;
  }
}

function describe(r: Record<string, unknown>) {
  if (r.status === 'pending') return 'Sent for approval (four-eyes).';
  if (r.message) return String(r.message);
  return 'Done.';
}

export function ActButton({ action, payload = {}, children, confirm, reason, danger, small }: { action: string; payload?: Record<string, unknown>; children: ReactNode; confirm?: string; reason?: boolean | string; danger?: boolean; small?: boolean }) {
  const router = useRouter();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
      <button
        className={`ak-btn ${danger ? 'ak-btn--accent' : 'ak-btn--secondary'}${small ? ' ak-btn--sm' : ''}`}
        style={small ? { padding: '4px 10px', minHeight: 28, fontSize: 12 } : undefined}
        disabled={busy}
        onClick={async () => {
          if (confirm && !window.confirm(confirm)) return;
          let why: string | null = null;
          if (reason) {
            why = window.prompt(typeof reason === 'string' ? reason : 'Reason (recorded in the audit log)');
            if (!why) return;
          }
          setBusy(true);
          setMsg(null);
          try {
            const r = await act(action, { ...payload, ...(why ? { reason: why } : {}) });
            setMsg({ ok: true, text: describe(r) });
            if (typeof r.url === 'string') window.open(r.url, '_blank', 'noopener');
            router.refresh();
          } catch (e) {
            setMsg({ ok: false, text: (e as Error).message });
          }
          setBusy(false);
        }}
      >
        {busy ? '…' : children}
      </button>
      {msg ? <span className={`ak-small ${msg.ok ? 'ak-muted' : 'ak-error'}`}>{msg.text}</span> : null}
    </span>
  );
}

export interface F {
  name: string;
  label: string;
  type?: 'text' | 'number' | 'textarea' | 'select' | 'checkbox' | 'date' | 'json';
  options?: string[] | { value: string; label: string }[];
  defaultValue?: string | number | boolean;
  required?: boolean;
  placeholder?: string;
}

/** Declarative form → admin action. JSON fields are parsed client-side and validated server-side. */
export function ActForm({ action, fields, submit, extra = {}, inline }: { action: string; fields: F[]; submit: string; extra?: Record<string, unknown>; inline?: boolean }) {
  const router = useRouter();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className={inline ? 'ak-row' : 'ak-stack'}
      style={inline ? { alignItems: 'end', flexWrap: 'wrap' } : { ['--stack' as string]: '10px' }}
      onSubmit={async (e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        const payload: Record<string, unknown> = { ...extra };
        try {
          for (const f of fields) {
            const v = fd.get(f.name);
            if (f.type === 'checkbox') payload[f.name] = v === 'on';
            else if (f.type === 'number') payload[f.name] = v === '' || v === null ? undefined : Number(v);
            else if (f.type === 'json') payload[f.name] = v ? JSON.parse(String(v)) : undefined;
            else if (v !== null && v !== '') payload[f.name] = String(v);
          }
        } catch {
          setMsg({ ok: false, text: 'Invalid JSON' });
          return;
        }
        setBusy(true);
        setMsg(null);
        try {
          const r = await act(action, payload);
          setMsg({ ok: true, text: describe(r) });
          router.refresh();
        } catch (x) {
          setMsg({ ok: false, text: (x as Error).message });
        }
        setBusy(false);
      }}
    >
      {fields.map((f) => (
        <label key={f.name} className="ak-field" style={inline ? { minWidth: 140 } : undefined}>
          <span className="ak-label">{f.label}</span>
          {f.type === 'textarea' || f.type === 'json' ? (
            <textarea className="ak-textarea" name={f.name} required={f.required} placeholder={f.placeholder} defaultValue={f.defaultValue as string} rows={f.type === 'json' ? 8 : 3} style={f.type === 'json' ? { fontFamily: 'var(--font-mono)', fontSize: 12 } : undefined} />
          ) : f.type === 'select' ? (
            <select className="ak-input" name={f.name} required={f.required} defaultValue={f.defaultValue as string}>
              {(f.options ?? []).map((o) => (typeof o === 'string' ? <option key={o} value={o}>{o}</option> : <option key={o.value} value={o.value}>{o.label}</option>))}
            </select>
          ) : f.type === 'checkbox' ? (
            <input type="checkbox" name={f.name} defaultChecked={!!f.defaultValue} />
          ) : (
            <input className="ak-input" type={f.type ?? 'text'} name={f.name} required={f.required} placeholder={f.placeholder} defaultValue={f.defaultValue as string} step={f.type === 'number' ? 'any' : undefined} />
          )}
        </label>
      ))}
      <div>
        <button className="ak-btn ak-btn--sm" type="submit" disabled={busy}>{busy ? '…' : submit}</button>
        {msg ? <span className={`ak-small ${msg.ok ? 'ak-muted' : 'ak-error'}`} style={{ marginLeft: 8 }}>{msg.text}</span> : null}
      </div>
    </form>
  );
}
