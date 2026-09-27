'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { act } from './act';

/**
 * Bulk tag for the tenant list (plan 05 §2.1 "Bulk actions: tag"). Row checkboxes live in the server-rendered
 * table and join this form through their `form` attribute, so the selection is read from the form's data.
 */
export function BulkTag({ formId, count }: { formId: string; count: number }) {
  const router = useRouter();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      id={formId}
      className="ak-row"
      style={{ alignItems: 'end', flexWrap: 'wrap', gap: 8 }}
      onSubmit={async (e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        const workspaceIds = fd.getAll('ws').map(String);
        if (!workspaceIds.length) {
          setMsg({ ok: false, text: 'Select tenants first.' });
          return;
        }
        setBusy(true);
        setMsg(null);
        try {
          const r = await act('tenant.bulk_tag', { workspaceIds, tag: String(fd.get('tag') ?? ''), mode: String(fd.get('mode') ?? 'add') });
          setMsg({ ok: true, text: String(r.message ?? 'Done.') });
          router.refresh();
        } catch (x) {
          setMsg({ ok: false, text: (x as Error).message });
        }
        setBusy(false);
      }}
    >
      <label className="ak-field" style={{ flex: '0 1 160px' }}>
        <span className="ak-label">Bulk</span>
        <select className="ak-input" name="mode" defaultValue="add" style={{ minHeight: 36, padding: '4px 8px' }}>
          <option value="add">Add tag</option>
          <option value="remove">Remove tag</option>
        </select>
      </label>
      <label className="ak-field" style={{ flex: '0 1 200px' }}>
        <span className="ak-label">Tag</span>
        <input className="ak-input" name="tag" required maxLength={40} pattern="[a-z0-9][a-z0-9_-]*" title="lowercase letters, digits, - and _" style={{ minHeight: 36, padding: '4px 8px' }} />
      </label>
      <button className="ak-btn ak-btn--sm" disabled={busy}>{busy ? '…' : `Apply to selected (of ${count})`}</button>
      {msg ? <span role="status" className={`ak-small ${msg.ok ? 'ak-muted' : 'ak-error'}`}>{msg.text}</span> : null}
    </form>
  );
}
