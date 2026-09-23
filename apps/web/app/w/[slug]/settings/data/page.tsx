import type { Metadata } from 'next';
import { withTenant } from '@arkiv/db';
import { setting } from '@arkiv/core';
import { PROVISIONAL } from '@arkiv/shared';
import { Banner } from '@arkiv/ui';
import { ActionButton, ActionForm } from '@/components/actions';
import { workspacePage } from '@/lib/tenant';

export const metadata: Metadata = { title: 'Data · Arkiv' };

export default async function Data({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const w = await workspacePage(slug);
  const { ws, archiveDays, graceDays } = await withTenant(w.ctx.workspaceId, async (tx) => ({
    ws: (await tx`select state, purge_at from workspaces where id = ${w.ctx.workspaceId}`)[0],
    archiveDays: await setting(tx, 'retention.cancelled_archive_days'),
    graceDays: await setting(tx, 'retention.purge_grace_days'),
  }));
  const isOwner = w.ctx.role === 'OWNER';
  const canExport = ['OWNER', 'ADMIN'].includes(w.ctx.role);
  return (
    <div className="ak-stack" style={{ ['--stack' as string]: '32px', maxWidth: 680 }}>
      <section className="ak-panel">
        <h2 className="ak-label">Export everything</h2>
        <p className="ak-small">A ZIP of your products, facts, claims and evidence, tests, results, learnings and files. We email a download link (valid 24 hours) when it’s ready.</p>
        {canExport ? <ActionButton slug={slug} action="export">Request export</ActionButton> : <p className="ak-small ak-muted">Owners and admins can export.</p>}
      </section>
      <section className="ak-panel">
        <h2 className="ak-label">Retention</h2>
        <p className="ak-small">After a plan ends, your archive is kept for {archiveDays} days. Anonymous previews are deleted after {PROVISIONAL.TTL_DAYS} days. Deleting a workspace removes all files and records after a {graceDays}-day grace period; payment and consent records are kept as the law requires, without your content.</p>
      </section>
      <section className="ak-panel">
        <h2 className="ak-label">Delete workspace</h2>
        {ws?.state === 'PURGE_SCHEDULED' ? (
          <>
            <Banner tone="risk">Scheduled for deletion on {new Date(ws.purge_at as string).toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}.</Banner>
            {isOwner ? <ActionButton slug={slug} action="undelete" variant="primary">Cancel deletion</ActionButton> : null}
          </>
        ) : isOwner ? (
          <ActionForm slug={slug} action="delete" submit="Delete workspace" fields={[{ name: 'confirm', label: `Type ${slug} to confirm`, required: true, hint: 'Cancel your plan first. You can undo this during the grace period.' }]} />
        ) : (
          <p className="ak-small ak-muted">Only the owner can delete the workspace.</p>
        )}
      </section>
    </div>
  );
}
