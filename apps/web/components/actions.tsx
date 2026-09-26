'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState, type ReactNode } from 'react';
import { Banner, Button, Field as FormField, Input, Select, splitConfirm, Textarea } from '@arkiv/ui';
import { api, confirmSheet, Sheet, toast, useSubmissionKey } from '@arkiv/ui/client';
import { StepUp } from './profile';
import { forgetUpload, RESUMABLE_TYPES, resumableUpload } from './resumable-upload';
import { blockedAlternative, type BlockedAlternative } from '@/lib/claim-alternative';

/** The server wants a recent sign-in first (plan 02 M14 step-up): offer the emailed confirmation link. */
const needsStepUp = (e: unknown) => !!(e as { details?: { stepUp?: boolean } } | null)?.details?.stepUp;

type Variant = 'primary' | 'secondary' | 'accent' | 'text';

/**
 * A blocked claim's compliant alternative, under the error (plan 03 A3/A5, §43): the rules' advice, and — when it
 * quotes an example wording — a button that puts that wording into the field.
 */
export function AlternativeHint({ alt, onUse }: { alt: BlockedAlternative; onUse?: (wording: string) => void }) {
  return (
    <div className="ak-small" role="note" style={{ display: 'grid', gap: 4 }}>
      <span><span className="ak-muted">Try instead:</span> {alt.advice}</span>
      {alt.wording && onUse ? (
        <span><button type="button" className="ak-textbtn" onClick={() => onUse(alt.wording!)}>Use “{alt.wording}”</button></span>
      ) : null}
    </div>
  );
}

/**
 * POSTs a workspace action and refreshes server data. Errors are shown inline, never swallowed. A `confirm`
 * question opens the confirmation sheet first (with an oxide confirm button when `danger`); `success` is toasted.
 */
export function ActionButton({ slug, action, body, children, variant = 'secondary', confirm, danger, next, size, success }: { slug: string; action: string; body?: unknown; children: ReactNode; variant?: Variant; confirm?: string; danger?: boolean; next?: string; size?: 'sm'; success?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [stepUp, setStepUp] = useState(false);
  const submission = useSubmissionKey();
  async function run() {
    if (confirm) {
      const ok = await confirmSheet({ ...splitConfirm(confirm), danger, confirmLabel: typeof children === 'string' ? children : 'Confirm' });
      if (!ok.ok) return;
    }
    setBusy(true);
    setErr(null);
    setStepUp(false);
    try {
      const r = await api<{ next?: string | null; url?: string }>(`/api/w/${slug}/${action}`, body ?? {}, 'POST', { idempotencyKey: submission.key() });
      submission.next();
      if (r.url) window.location.assign(r.url);
      else if (r.next ?? next) router.push((r.next ?? next)!);
      else {
        router.refresh();
        if (success) toast(success);
      }
    } catch (e) {
      if (needsStepUp(e)) setStepUp(true);
      else setErr((e as Error).message);
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
      {stepUp ? <StepUp message="For your security, confirm it’s you first, then try again." /> : err ? <span className="ak-error ak-small" role="alert">{err}</span> : null}
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
  /** The input's purpose for autofill (WCAG 1.3.5), e.g. 'name' or 'organization'. */
  autoComplete?: string;
}

/** Small declarative form → workspace action (JSON, or multipart when a file field is present). Success is a toast. */
export function ActionForm({ slug, action, fields, submit, extra, onDone, multipart, danger }: { slug: string; action: string; fields: Field[]; submit: string; extra?: Record<string, unknown>; onDone?: (r: unknown) => void; multipart?: boolean; danger?: boolean }) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [alt, setAlt] = useState<BlockedAlternative | null>(null);
  const [stepUp, setStepUp] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  // A compliant alternative replaces the form's first text field (the wording the rules blocked).
  const wordingField = fields.find((f) => !f.type || f.type === 'text' || f.type === 'textarea')?.name;
  const applyWording = (w: string) => {
    const el = wordingField ? formRef.current?.elements.namedItem(wordingField) : null;
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      el.value = w;
      el.focus();
    }
    setErr(null);
    setAlt(null);
  };
  // One key per submission: a doubled or retried submit of the same form returns the first answer (§39).
  const submission = useSubmissionKey();
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    setBusy(true);
    setErr(null);
    setAlt(null);
    try {
      let payload: unknown;
      let sent: File | null = null;
      if (multipart) {
        for (const [k, v] of Object.entries(extra ?? {})) fd.set(k, String(v));
        // Photos, video and PDFs go up first, straight to storage and resumably; the form then names the upload.
        const f = fd.get('file');
        if (f instanceof File && f.size > 0 && RESUMABLE_TYPES.test(f.type)) {
          setProgress(0);
          const uploadId = await resumableUpload(slug, f, setProgress);
          fd.delete('file');
          fd.set('fileUploadId', uploadId);
          sent = f;
        }
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
      const r = await api<{ next?: string }>(`/api/w/${slug}/${action}`, payload, 'POST', { idempotencyKey: submission.key() });
      submission.next();
      if (sent) forgetUpload(slug, sent);
      (e.target as HTMLFormElement).reset();
      toast('Saved');
      onDone?.(r);
      if (r?.next) router.push(r.next);
      else router.refresh();
    } catch (x) {
      if (needsStepUp(x)) setStepUp(true);
      else {
        setErr((x as Error).message);
        setAlt(blockedAlternative(x));
      }
    }
    setProgress(null);
    setBusy(false);
  }
  return (
    <form ref={formRef} className="ak-stack" onSubmit={onSubmit}>
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
              <Textarea name={f.name} required={f.required} placeholder={f.placeholder} defaultValue={f.defaultValue} maxLength={f.max} autoComplete={f.autoComplete} />
            ) : f.type === 'select' ? (
              <Select name={f.name} required={f.required} defaultValue={f.defaultValue} autoComplete={f.autoComplete}>
                {f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </Select>
            ) : (
              <Input type={f.type ?? 'text'} name={f.name} required={f.required} placeholder={f.placeholder} defaultValue={f.defaultValue} maxLength={f.max} accept={f.accept} autoComplete={f.autoComplete} />
            )}
          </FormField>
        ),
      )}
      {stepUp ? <StepUp message="For your security, confirm it’s you first, then try again." /> : null}
      {err ? <Banner tone="risk">{err}</Banner> : null}
      {err && alt ? <AlternativeHint alt={alt} onUse={wordingField ? applyWording : undefined} /> : null}
      <div><Button type="submit" variant={danger ? 'danger' : 'primary'} disabled={busy}>{busy ? (progress != null && progress < 1 ? `Uploading ${Math.round(progress * 100)}%…` : 'Saving…') : submit}</Button></div>
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
