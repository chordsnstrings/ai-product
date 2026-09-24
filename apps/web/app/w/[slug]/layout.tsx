import Link from 'next/link';
import type { ReactNode } from 'react';
import { withTenant } from '@arkiv/db';
import { freshness, periodUsage } from '@arkiv/core';
import { Banner } from '@arkiv/ui';
import { ActionButton } from '@/components/actions';
import { AppNav, TabBar } from '@/components/app-nav';
import { StatusBanner } from '@/components/status-banner';
import { requireUser } from '@/lib/session';
import { userWorkspaces, workspacePage } from '@/lib/tenant';

/** Workspace chrome (plan 03 Part B): left rail on desktop, bottom tabs on phone, freshness + entitlement meter. */
export default async function WorkspaceLayout({ children, params }: { children: ReactNode; params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const user = await requireUser(`/w/${slug}/this-week`);
  const w = await workspacePage(slug);
  const all = await userWorkspaces(user.userId);
  const { meter, fresh, ws, notices } = await withTenant(w.ctx.workspaceId, async (tx) => {
    const [sub] = await tx`select current_period_start, current_period_end from subscriptions where status in ('active','trialing','past_due') order by created_at desc limit 1`;
    let meter: string | null = null;
    if (sub) {
      const u = await periodUsage(tx, new Date(sub.current_period_start as string).toISOString().slice(0, 10));
      meter = `${u.remaining} of ${u.granted} tests left · renews ${new Date(sub.current_period_end as string).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
    }
    const [ws] = await tx`select state, purge_at from workspaces where id = ${w.ctx.workspaceId}`;
    // In-app notices from Arkiv (retention playbooks, plan 05 §17), until dismissed or expired.
    const notices = await tx`select id, title, body, link_path, link_label from workspace_notices
                             where workspace_id = ${w.ctx.workspaceId} and dismissed_at is null and expires_at > now() order by created_at desc limit 2`;
    return { meter, fresh: await freshness(tx), ws, notices };
  });
  const stale = fresh.filter((f) => f.stale);
  return (
    <div className="ak-shell">
      <AppNav slug={slug} current={w.name} meter={meter} workspaces={all.map((x) => ({ slug: x.slug as string, name: x.name as string }))} />
      <header className="ak-topbar ak-topbar--mobile">
        <Link href={`/w/${slug}/this-week`} className="ak-wordmark">Arkiv</Link>
        <span className="ak-small ak-muted">{meter ?? w.name}</span>
      </header>
      <main className="ak-main">
        <StatusBanner />
        {ws?.state === 'PURGE_SCHEDULED' ? (
          <Banner tone="risk">This workspace is scheduled for deletion on {new Date(ws.purge_at as string).toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}. <Link href={`/w/${slug}/settings/data`}>Cancel deletion</Link></Banner>
        ) : null}
        {ws?.state === 'PAST_DUE' ? <Banner tone="warn">Your last payment failed. <Link href={`/w/${slug}/settings/billing`}>Update your card</Link> to keep producing tests.</Banner> : null}
        {stale.length ? <Banner tone="warn">{stale.map((s) => s.provider).join(', ')} data is older than 7 days — recommendations are using a reduced basis. <Link href={`/w/${slug}/settings/integrations`}>Check connections</Link></Banner> : null}
        {notices.map((n) => (
          <Banner key={n.id as string}>
            <strong>{n.title as string}</strong> {n.body as string}{' '}
            {n.link_path ? <Link href={`/w/${slug}${n.link_path as string}`}>{(n.link_label as string) ?? 'Open'}</Link> : null}{' '}
            <ActionButton slug={slug} action="notice-dismiss" body={{ id: n.id }} variant="text">Dismiss</ActionButton>
          </Banner>
        ))}
        {children}
      </main>
      <TabBar slug={slug} />
    </div>
  );
}
