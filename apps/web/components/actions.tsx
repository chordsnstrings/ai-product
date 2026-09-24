'use client';

import { useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { Banner, Button, Field as FormField, Input, Select, splitConfirm, Textarea } from '@arkiv/ui';
import { api, confirmSheet, Sheet, toast } from '@arkiv/ui/client';

type Variant = 'primary' | 'secondary' | 'accent' | 'text';

/**
 * POSTs a workspace action and refreshes server data. Errors are shown inline, never swallowed. A `confirm`
 * question opens the confirmation sheet first (with an oxide confirm button when `danger`); `success` is toasted.
 */
export function ActionButton({ slug, action, body, children, variant = 'secondary', confirm, danger, next, size, success }: { slug: string; action: string; body?: unknown; children: ReactNode; variant?: Variant; confirm?: string; danger?: boolean; next?: string; size?: 'sm'; success?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function run() {
    if (confirm) {
      const ok = await confirmSheet({ ...splitConfirm(confirm), danger, confirmLabel: typeof children === 'string' ? children : 'Confirm' });
      if (!ok.ok) return;
    }
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ next?: string | null; url?: string }>(`/api/w/${slug}/${action}`, body ?? {});
      if (r.url) window.location.assign(r.url);
      else if (r.next ?? next) router.push((r.next ?? next)!);
      else {
        router.refresh();
        if (success) toast(success);
      }
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

/** Small declarative form → workspace action (JSON, or multipart when a file field is present). Success is a toast. */
export function ActionForm({ slug, action, fields, submit, extra, onDone, multipart, danger }: { slug: string; action: string; fields: Field[]; submit: string; extra?: Record<string, unknown>; onDone?: (r: unknown) => void; multipart?: boolean; danger?: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    setBusy(true);
    setErr(null);
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
      toast('Saved');
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
      {fields.map((f) =>
        f.type === 'checkboxes' ? (
          <fieldset key={f.name} className="ak-field" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="ak-label">{f.label}</legend>
            <span className="ak-row">
              {f.options?.map((o) => (
                <label key={o.value} className="ak-check"><input type="checkbox" name={f.name} value={o.value} defaultChecked={f.checked ? f.checked.includes(o.value) : true} /> {o.label}</label>
              ))}
            </span>
            {f.hint ? <span className="ak-hint">{f.hint}</span> : null}
          </fieldset>
        ) : (
          <FormField key={f.name} label={f.label} hint={f.hint}>
            {f.type === 'textarea' ? (
              <Textarea name={f.name} required={f.required} placeholder={f.placeholder} defaultValue={f.defaultValue} maxLength={f.max} />
            ) : f.type === 'select' ? (
              <Select name={f.name} required={f.required} defaultValue={f.defaultValue}>
                {f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </Select>
            ) : (
              <Input type={f.type ?? 'text'} name={f.name} required={f.required} placeholder={f.placeholder} defaultValue={f.defaultValue} maxLength={f.max} accept={f.accept} />
            )}
          </FormField>
        ),
      )}
      {err ? <Banner tone="risk">{err}</Banner> : null}
      <div><Button type="submit" variant={danger ? 'danger' : 'primary'} disabled={busy}>{busy ? 'Saving…' : submit}</Button></div>
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
