import Link from 'next/link';
import { notFound } from 'next/navigation';
import { withAdmin } from '@arkiv/db';
import { activeBreakGlass, assertBreakGlass, audit, shouldMaskPii, staffCan } from '@arkiv/core';
import { canResendTemplate, isTemplateName, renderEmail, type TemplateName } from '@arkiv/email';
import { newId } from '@arkiv/shared';
import { ActButton } from '@/components/act';
import { dt, Mono, Page, Section, Table } from '@/components/ui';
import { piiView } from '@/lib/mask';
import { requireStaff } from '@/lib/staff';

export const metadata = { title: 'Email' };

/**
 * Plan 05 §2.2 Emails → "view rendered email": the template re-rendered from the data it was sent with (credential
 * links were never stored and show as redacted). The body carries tenant content (product names, claims, test
 * ideas), so the rendered view needs break-glass; delivery metadata doesn't.
 */
export default async function EmailView({ params }: { params: Promise<{ id: string; logId: string }> }) {
  const s = await requireStaff('tenant.read');
  const { id, logId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id) || !/^[0-9a-f-]{36}$/i.test(logId)) notFound();
  const d0 = await withAdmin(async (tx) => {
    // The log row must belong to this tenant: sent in its context, or to one of its members.
    const [row] = await tx`select l.* from email_log l where l.id = ${logId}
                             and (l.workspace_id = ${id} or (l.workspace_id is null and l.to_email in (select u.email from memberships m join users u on u.id = m.user_id where m.workspace_id = ${id})))`;
    if (!row) return null;
    await audit(tx, s, 'email.view', { type: 'email_log', id: logId }, { workspaceId: id });
    const bg = await activeBreakGlass(tx, s, id);
    if (bg) await assertBreakGlass(tx, s, id, `rendered email ${logId}`);
    const [support] = await tx`select value from platform_settings where key = 'support.email'`;
    return { row, bg: !!bg, support: typeof support?.value === 'string' ? (support.value as string) : null };
  });
  if (!d0) notFound();
  const { row } = d0;
  const pii = piiView(shouldMaskPii(s.roles, d0.bg));
  const template = row.template as string;
  let rendered: { subject: string; html: string } | null = null;
  let renderError: string | null = null;
  if (d0.bg && row.data && isTemplateName(template)) {
    try {
      rendered = await renderEmail(template as TemplateName, row.data as never, { supportEmail: d0.support });
    } catch (e) {
      renderError = (e as Error).message;
    }
  }
  const events = (row.events as { type?: string; at?: string; error?: string }[]) ?? [];
  const back = `/tenants/${id}?tab=emails`;
  return (
    <Page
      title={rendered?.subject ?? template}
      sub={<><Link href={back}>Emails</Link> · to {pii.email(row.to_email)} · {row.stream as string} · {row.status as string} · {dt(row.created_at)}</>}
      actions={staffCan(s.roles, 'email.manage') && row.data && canResendTemplate(template) ? <ActButton action="email.resend" payload={{ logId, requestId: newId() }} reason="Why resend (ticket #)">Resend</ActButton> : null}
    >
      <Table head={['', '']} rows={[
        ['Template', <Mono key="t">{template}</Mono>],
        ['Provider id', <Mono key="p">{(row.provider_id as string) ?? '—'}</Mono>],
        ['Idempotency key', <Mono key="k">{row.idempotency_key as string}</Mono>],
      ]} />
      <Section title="Delivery events">
        <Table head={['When', 'Event', 'Detail']} rows={events.map((e, i) => [dt(e.at), e.type ?? '—', <span key={i} className="ak-small">{e.error ?? ''}</span>])} empty="No provider events yet." />
      </Section>
      <Section title="Rendered email">
        {!d0.bg ? (
          <p className="ak-small ak-muted">The email body is tenant content. Start break-glass on the tenant’s Brands & SKUs tab to view it (the customer sees this in their access log).</p>
        ) : !row.data ? (
          <p className="ak-small ak-muted">This email was sent before its content was recorded.</p>
        ) : renderError ? (
          <p className="ak-small ak-error">Could not render: {renderError}</p>
        ) : rendered ? (
          // Sandboxed with no permissions: no scripts, no same-origin access, links don't navigate the console.
          <iframe title="Rendered email" sandbox="" srcDoc={rendered.html} style={{ width: '100%', maxWidth: 640, height: 720, border: '1px solid var(--rule)', background: '#fff' }} />
        ) : (
          <p className="ak-small ak-muted">Unknown template.</p>
        )}
      </Section>
    </Page>
  );
}
