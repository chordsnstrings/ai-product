'use client';

import { useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { Banner, Button } from '@arkiv/ui';
import { api, Sheet } from '@arkiv/ui/client';

type Variant = 'primary' | 'secondary' | 'accent' | 'text';

/** POSTs a workspace action and refreshes server data. Errors are shown inline, never swallowed. */
export function ActionButton({ slug, action, body, children, variant = 'secondary', confirm, next, size }: { slug: string; action: string; body?: unknown; children: ReactNode; variant?: Variant; confirm?: string; next?: string; size?: 'sm' }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function run() {
    if (confirm && !window.confirm(confirm)) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ next?: string | null; url?: string }>(`/api/w/${slug}/${action}`, body ?? {});
      if (r.url) window.location.assign(r.url);
      else if (r.next ?? next) router.push((r.next ?? next)!);
      else router.refresh();
    } catch (e) {
      setErr((e as Error).message);
    }
    setBusy(false);
  }
  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 4 }}>
      {variant === 'text' ? (
        <button className="ak-textbtn" onClick={run} disabled={busy}>{children}</button>
      ) : (
        <Button variant={variant} size={size} onClick={run} disabled={busy}>{busy ? '…' : children}</Button>
      )}
      {err ? <span className="ak-error ak-small" role="alert">{err}</span> : null}
    </span>
  );
}

export interface Field {
  name: string;
  label: string;
  type?: 'text' | 'email' | 'textarea' | 'select' | 'date' | 'file' | 'checkboxes';
  options?: { value: string; label: string }[];
  required?: boolean;
  placeholder?: string;
  defaultValue?: string;
  max?: number;
  accept?: string;
  hint?: string;
  /** Checkbox values ticked at first (all of them when omitted). */
  checked?: string[];
}

/** Small declarative form → workspace action (JSON, or multipart when a file field is present). */
export function ActionForm({ slug, action, fields, submit, extra, onDone, multipart }: { slug: string; action: string; fields: Field[]; submit: string; extra?: Record<string, unknown>; onDone?: (r: unknown) => void; multipart?: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    setBusy(true);
    setErr(null);
    setOk(null);
    try {
      let payload: unknown;
      if (multipart) {
        for (const [k, v] of Object.entries(extra ?? {})) fd.set(k, String(v));
        payload = fd;
      } else {
        const o: Record<string, unknown> = { ...extra };
        for (const f of fields) {
          if (f.type === 'checkboxes') o[f.name] = fd.getAll(f.name);
          else {
            const v = fd.get(f.name);
            if (v !== null && v !== '') o[f.name] = v;
          }
        }
        payload = o;
      }
      const r = await api<{ next?: string }>(`/api/w/${slug}/${action}`, payload);
      (e.target as HTMLFormElement).reset();
      setOk('Saved');
      onDone?.(r);
      if (r?.next) router.push(r.next);
      else router.refresh();
    } catch (x) {
      setErr((x as Error).message);
    }
    setBusy(false);
  }
  return (
    <form className="ak-stack" onSubmit={onSubmit}>
      {fields.map((f) => (
        <label key={f.name} className="ak-field">
          <span className="ak-label">{f.label}</span>
          {f.type === 'textarea' ? (
            <textarea className="ak-textarea" name={f.name} required={f.required} placeholder={f.placeholder} defaultValue={f.defaultValue} maxLength={f.max} />
          ) : f.type === 'select' ? (
            <select className="ak-input" name={f.name} required={f.required} defaultValue={f.defaultValue}>
              {f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          ) : f.type === 'checkboxes' ? (
            <span className="ak-row">
              {f.options?.map((o) => (
                <label key={o.value} className="ak-check"><input type="checkbox" name={f.name} value={o.value} defaultChecked={f.checked ? f.checked.includes(o.value) : true} /> {o.label}</label>
              ))}
            </span>
          ) : (
            <input className="ak-input" type={f.type ?? 'text'} name={f.name} required={f.required} placeholder={f.placeholder} defaultValue={f.defaultValue} maxLength={f.max} accept={f.accept} />
          )}
          {f.hint ? <span className="ak-small ak-muted">{f.hint}</span> : null}
        </label>
      ))}
      {err ? <Banner tone="risk">{err}</Banner> : null}
      {ok ? <p className="ak-small ak-muted" role="status">{ok}</p> : null}
      <div><Button type="submit" disabled={busy}>{busy ? 'Saving…' : submit}</Button></div>
    </form>
  );
}

export function SheetButton({ label, title, description, children, variant = 'secondary' }: { label: string; title: string; description?: string; children: ReactNode; variant?: Variant }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      {variant === 'text' ? <button className="ak-textbtn" onClick={() => setOpen(true)}>{label}</button> : <Button variant={variant} onClick={() => setOpen(true)}>{label}</Button>}
      <Sheet open={open} onOpenChange={setOpen} title={title} description={description}>{children}</Sheet>
    </>
  );
}
