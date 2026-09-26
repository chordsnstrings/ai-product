'use client';

import { useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { startAuthentication } from '@simplewebauthn/browser';
import { Field, Input, Select, splitConfirm, Textarea } from '@arkiv/ui';
import { confirmSheet, toast } from '@arkiv/ui/client';

export async function post(url: string, body: unknown) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(j.error ?? 'Failed') as Error & { details?: Record<string, unknown> };
    e.details = j.details ?? undefined;
    throw e;
  }
  return j as Record<string, unknown>;
}

/**
 * 🔐 fresh second factor (plan 05 §0.1): a passkey tap when the staff member has one, otherwise (or if they
 * cancel the tap and their account allows it) an authenticator code.
 */
export async function reauthenticate(): Promise<void> {
  const { options } = await post('/api/reauth', { step: 'options' });
  if (options) {
    // A cancelled or unavailable authenticator falls back to a code; a refused assertion is final.
    const response = await startAuthentication({ optionsJSON: options as Parameters<typeof startAuthentication>[0]['optionsJSON'] }).catch(() => null);
    if (response) {
      await post('/api/reauth', { response });
      return;
    }
  }
  const r = await confirmSheet({ title: 'Confirm it’s you', body: 'This action needs a fresh second factor.', confirmLabel: 'Confirm', input: { label: 'Authenticator code', kind: 'code', required: true } });
  if (!r.ok) throw new Error('Cancelled');
  await post('/api/reauth', { code: r.value.trim() });
}

/** Runs an admin action; if the server asks for a fresh second factor (🔐), re-authenticates and retries once. */
export async function act(action: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  try {
    return await post(`/api/act/${action}`, payload);
  } catch (e) {
    if ((e as { details?: { reauth?: boolean } }).details?.reauth) {
      await reauthenticate();
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
        className={`ak-btn ${danger ? 'ak-btn--danger' : 'ak-btn--secondary'}${small ? ' ak-btn--sm' : ''}`}
        style={small ? { padding: '4px 10px', minHeight: 28, fontSize: 12 } : undefined}
        disabled={busy}
        onClick={async () => {
          let why: string | null = null;
          // One sheet asks both: the confirmation and, when the audit log needs it, the reason.
          if (confirm || reason) {
            const label = typeof children === 'string' ? children : 'Confirm';
            const q = confirm ? splitConfirm(confirm) : { title: `${label}?` };
            const res = await confirmSheet({ ...q, danger, confirmLabel: label, input: reason ? { label: typeof reason === 'string' ? reason : 'Reason (recorded in the audit log)', kind: 'textarea', required: true } : undefined });
            if (!res.ok) return;
            if (reason) why = res.value.trim();
          }
          setBusy(true);
          setMsg(null);
          try {
            const r = await act(action, { ...payload, ...(why ? { reason: why } : {}) });
            // A plain success is a toast (design §3); what the server says (a secret to hand over, a count) or a
            // request left waiting for a second approver stays on the page.
            if (r.status === 'pending' || r.message) setMsg({ ok: true, text: describe(r) });
            else toast(describe(r));
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
  type?: 'text' | 'number' | 'textarea' | 'select' | 'checkbox' | 'date' | 'datetime-local' | 'json';
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
            // The browser's local time → an explicit UTC instant (the server never guesses the staff timezone).
            else if (f.type === 'datetime-local') payload[f.name] = v ? new Date(String(v)).toISOString() : undefined;
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
          // A plain success is a toast (design §3); what the server says (a secret to hand over, a count) or a
          // request left waiting for a second approver stays on the page.
          if (r.status === 'pending' || r.message) setMsg({ ok: true, text: describe(r) });
          else toast(describe(r));
          router.refresh();
        } catch (x) {
          setMsg({ ok: false, text: (x as Error).message });
        }
        setBusy(false);
      }}
    >
      {fields.map((f) =>
        f.type === 'checkbox' ? (
          <label key={f.name} className="ak-check" style={inline ? { minWidth: 140 } : undefined}>
            <input type="checkbox" name={f.name} defaultChecked={!!f.defaultValue} />
            <span className="ak-label">{f.label}</span>
          </label>
        ) : (
          <div key={f.name} style={inline ? { minWidth: 140 } : undefined}>
            <Field label={f.label}>
              {f.type === 'textarea' || f.type === 'json' ? (
                <Textarea name={f.name} required={f.required} placeholder={f.placeholder} defaultValue={f.defaultValue as string} rows={f.type === 'json' ? 8 : 3} style={f.type === 'json' ? { fontFamily: 'var(--font-mono)', fontSize: 12 } : undefined} />
              ) : f.type === 'select' ? (
                <Select name={f.name} required={f.required} defaultValue={f.defaultValue as string}>
                  {(f.options ?? []).map((o) => (typeof o === 'string' ? <option key={o} value={o}>{o}</option> : <option key={o.value} value={o.value}>{o.label}</option>))}
                </Select>
              ) : (
                <Input type={f.type ?? 'text'} name={f.name} required={f.required} placeholder={f.placeholder} defaultValue={f.defaultValue as string} step={f.type === 'number' ? 'any' : undefined} />
              )}
            </Field>
          </div>
        ),
      )}
      <div>
        <button className="ak-btn ak-btn--sm" type="submit" disabled={busy}>{busy ? '…' : submit}</button>
        {msg ? <span className={`ak-small ${msg.ok ? 'ak-muted' : 'ak-error'}`} style={{ marginLeft: 8 }}>{msg.text}</span> : null}
      </div>
    </form>
  );
}
