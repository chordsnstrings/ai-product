import Link from 'next/link';
import { cookies } from 'next/headers';
import type { ReactNode } from 'react';
import { withTenant } from '@arkiv/db';
import { freshness, periodUsage, setting } from '@arkiv/core';
import { Banner } from '@arkiv/ui';
import { Announcer, ConfirmHost, ThemeScope, Toaster } from '@arkiv/ui/client';
import { formatDate } from '@arkiv/shared/format';
import { ActionButton } from '@/components/actions';
import { AppNav, TabBar } from '@/components/app-nav';
import { StatusBanner } from '@/components/status-banner';
import { requireUser } from '@/lib/session';
import { userWorkspaces, workspacePage } from '@/lib/tenant';
import { parseTheme, THEME_COOKIE } from '@/lib/theme';
import { freshnessChips } from '@/lib/freshness-chip';

/** Workspace chrome (plan 03 Part B): left rail on desktop, bottom tabs on phone, freshness + entitlement meter. */
export default async function WorkspaceLayout({ children, params }: { children: ReactNode; params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const user = await requireUser(`/w/${slug}/this-week`);
  const w = await workspacePage(slug);
  const all = await userWorkspaces(user.userId);
  const { meter, fresh, ws, notices, providers, support } = await withTenant(w.ctx.workspaceId, async (tx) => {
    const [sub] = await tx`select current_period_start, current_period_end from subscriptions where status in ('active','trialing','past_due') order by created_at desc limit 1`;
    let meter: string | null = null;
    if (sub) {
      const u = await periodUsage(tx, new Date(sub.current_period_start as string).toISOString().slice(0, 10));
      meter = `${u.remaining} of ${u.granted} tests left · renews ${formatDate(sub.current_period_end as string)}`;
    }
    const [ws] = await tx`select state, purge_at, owner_email_bouncing_at, plan_code from workspaces where id = ${w.ctx.workspaceId}`;
    // In-app notices from Arkiv (retention playbooks, plan 05 §17), until dismissed or expired.
    const notices = await tx`select id, title, body, link_path, link_label from workspace_notices
                             where workspace_id = ${w.ctx.workspaceId} and dismissed_at is null and expires_at > now() order by created_at desc limit 2`;
    // Connected platforms, for incident banners aimed at one connector (plan 05 §22).
    const providers = (await tx`select distinct provider from integrations where status <> 'disconnected'`).map((r) => r.provider as string);
    // Where to write about a hold (plan 02 §2: SUSPENDED — "login shows a notice").
    const support = ws?.state === 'SUSPENDED' || ws?.state === 'LOCKED' ? await setting(tx, 'support.email') : null;
    return { meter, fresh: await freshness(tx), ws, notices, providers, support };
  });
  const stale = fresh.filter((f) => f.stale);
  // The viewer's manual light/dark choice (design §2.1); without one the app follows the system setting.
  const theme = parseTheme((await cookies()).get(THEME_COOKIE)?.value);
  const shell = (
    <div className="ak-shell">
      <AppNav slug={slug} current={w.name} meter={meter} workspaces={all.map((x) => ({ slug: x.slug as string, name: x.name as string }))} />
      <header className="ak-topbar ak-topbar--mobile">
        <Link href={`/w/${slug}/this-week`} className="ak-wordmark">Arkiv</Link>
        <span className="ak-small ak-muted">{meter ?? w.name}</span>
        <Link href={`/w/${slug}/settings/members`} className="ak-small">Settings</Link>
      </header>
      <main className="ak-main">
        {/* Plan 03 Part B: the page header always shows the workspace and how fresh its data is. */}
        <div className="ak-row ak-small ak-muted" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 16 }} aria-label="Data freshness">
          <span>{w.name}</span>
          {freshnessChips(fresh).map((c) => (
            <Link key={c.key} href={`/w/${slug}/settings/integrations`} className={`ak-chip${c.stale ? ' ak-chip--warn' : ''}`}>{c.text}</Link>
          ))}
        </div>
        <StatusBanner viewer={{ workspaceId: w.ctx.workspaceId, planCode: (ws?.plan_code as string | null) ?? null, providers }} />
        {ws?.state === 'SUSPENDED' ? (
          <Banner tone="risk">
            <strong>This workspace is paused while our team reviews it.</strong> Your data is untouched, nothing runs and billing is paused until the review ends.
            {support ? <> Questions? <a href={`mailto:${support}`}>{support}</a></> : null}
          </Banner>
        ) : null}
        {ws?.state === 'LOCKED' ? (
          <Banner tone="warn">
            <strong>This workspace is read-only while a payment dispute is reviewed.</strong> You can still view and export everything; changes and new ads are paused.
            {support ? <> Questions? <a href={`mailto:${support}`}>{support}</a></> : null}
          </Banner>
        ) : null}
        {ws?.state === 'PURGE_SCHEDULED' ? (
          <Banner tone="risk">This workspace is scheduled for deletion on {formatDate(ws.purge_at as string)}. <Link href={`/w/${slug}/settings/data`}>Cancel deletion</Link></Banner>
        ) : null}
        {ws?.owner_email_bouncing_at ? (
          // Plan 05 §18 / 02 M13: mail to the Owner's address bounced, so billing and security notices aren't arriving.
          <Banner tone="warn">Email to this workspace’s owner is bouncing, so receipts and security notices aren’t arriving. {w.ctx.role === 'OWNER' ? <Link href={`/w/${slug}/settings/profile`}>Update your email address</Link> : 'Ask the owner to update their email address.'}</Banner>
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
      <ConfirmHost />
      <Toaster />
      <Announcer />
    </div>
  );
  return theme ? <ThemeScope theme={theme}>{shell}</ThemeScope> : shell;
}
