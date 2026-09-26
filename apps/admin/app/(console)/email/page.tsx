import { withAdmin } from '@arkiv/db';
import { auditView, shouldMaskPii, staffCan } from '@arkiv/core';
import Link from 'next/link';
import { isTemplateName, MARKETING_TEMPLATES, QUIET_HOURS, resendDomains, SEQUENCES, templateSamples, type SendingDomain } from '@arkiv/email';
import { env } from '@arkiv/shared';
import { ActButton, ActForm } from '@/components/act';
import { dt, Mono, Page, pct, Section, Table } from '@/components/ui';
import { emailKey } from '@/lib/email-key';
import { piiView } from '@/lib/mask';
import { consolePrefs } from '@/lib/prefs';
import { notTest } from '@/lib/sql';
import { requireStaff } from '@/lib/staff';

export const metadata = { title: 'Email' };

const TEMPLATES = Object.keys(templateSamples('')).filter(isTemplateName).sort();

/** Plan 05 §18: Resend domains and stats, suppressions, complaint-rate guard, lifecycle sequences, previews and test sends. Templates live in git. */
export default async function Email() {
  const s = await requireStaff('email.read');
  const prefs = await consolePrefs();
  const pii = piiView(shouldMaskPii(s.roles));
  const d0 = await withAdmin(async (tx) => {
    await auditView(tx, s, 'email', { includeTest: prefs.includeTest });
    return {
      stats: await tx`select stream, count(*)::int as sent, count(*) filter (where status = 'bounced')::int as bounced, count(*) filter (where status = 'complained')::int as complained,
                             count(*) filter (where status in ('delivered','opened','clicked'))::int as delivered from email_log where created_at > now() - interval '30 days' ${notTest(tx, prefs)} group by stream`,
      byTemplate: await tx`select template, count(*)::int as n, max(created_at) as last from email_log where created_at > now() - interval '30 days' ${notTest(tx, prefs)} group by 1 order by 2 desc`,
      suppressions: await tx`select * from email_suppressions order by created_at desc limit 200`,
      failed: await tx`select to_email, template, events, created_at from email_log where status = 'failed' ${notTest(tx, prefs)} order by created_at desc limit 20`,
      paused: ((await tx`select value from platform_settings where key = 'email.marketing_paused'`)[0]?.value ?? null) as { at?: string; rate?: number; complaints?: number; sent?: number } | null,
      ownerBounces: await tx`select id, name, owner_email_bouncing_at from workspaces where owner_email_bouncing_at is not null ${notTest(tx, prefs, 'id')} order by owner_email_bouncing_at desc limit 50`,
    };
  });
  let domains: SendingDomain[] = [];
  let domainError: string | null = null;
  try {
    domains = await resendDomains();
  } catch (e) {
    domainError = (e as Error).message;
  }
  const status = (v: string) => (v === 'verified' ? 'verified' : <strong key={v}>{v}</strong>);
  return (
    <Page title="Email & lifecycle" sub={`Transactional (mail.) and marketing (news.) are separate streams. Marketing auto-pauses above 0.1% complaints (30 days). Test accounts ${prefs.includeTest ? 'included' : 'excluded'}.${pii.mask ? ' Addresses are masked for your role.' : ''}`}>
      {d0.paused && typeof d0.paused === 'object' ? (
        <div className="ak-banner ak-banner--risk" style={{ marginBottom: 16 }}>
          Marketing email is paused since {dt(d0.paused.at)}: complaint rate {pct(Number(d0.paused.rate ?? 0), 2)} ({d0.paused.complaints ?? '?'} of {d0.paused.sent ?? '?'} in 30 days). Transactional email is unaffected.{' '}
          {staffCan(s.roles, 'email.manage') ? <ActButton small action="email.marketing_resume" payload={{}} reason="What was fixed (list cleaned, content changed)?">Resume marketing</ActButton> : null}
        </div>
      ) : null}
      <Table head={['Stream (30d)', 'Sent', 'Delivered', 'Bounced', 'Complaints', 'Complaint rate']} rows={d0.stats.map((r) => {
        const high = Number(r.complained) / Number(r.sent) > 0.001;
        return [r.stream as string, r.sent as number, r.delivered as number, r.bounced as number, r.complained as number, <span key="c" style={{ color: high ? 'var(--risk)' : undefined }}>{pct(Number(r.complained) / Number(r.sent), 2)}{high ? ' ⚠ above 0.1%' : ''}</span>];
      })} empty="Nothing sent in 30 days." />
      <Section title="Sending domains (Resend)">
        {domainError ? <p className="ak-small ak-error">Couldn’t reach Resend: {domainError}</p> : null}
        <Table head={['Domain', 'Status', 'SPF', 'DKIM', 'DMARC']} rows={domains.map((x) => [<Mono key="d">{x.name}</Mono>, x.status, status(x.spf), status(x.dkim), <span key="m">{status(x.dmarc)}{x.dmarcPolicy ? ` (p=${x.dmarcPolicy})` : ''}</span>])} empty="No sending domains." />
        {domains.some((x) => x.fixture) ? <p className="ak-small ak-muted">No Resend key in this environment: statuses aren’t checked here.</p> : null}
      </Section>
      <Section title="Lifecycle sequences">
        <Table head={['Sequence', 'Trigger', 'Audience', 'Timing', 'Caps']} rows={SEQUENCES.map((q) => [<Link key="t" href={`/email/preview/${q.template}`}>{q.key.replace(/_/g, ' ')}</Link>, <span key="tr" className="ak-small">{q.trigger}</span>, <span key="a" className="ak-small">{q.audience}</span>, q.delayHours < 0 ? `${Math.round(-q.delayHours * 60)} min before` : q.delayHours >= 24 ? `${q.delayHours / 24} days after` : q.delayHours ? `${q.delayHours} h after` : 'on trigger', <span key="c" className="ak-small">{q.caps}</span>])} />
        <p className="ak-small ak-muted">Marketing frequency caps: at most 1 email a day and 3 a week per address. Quiet hours: marketing email waits between {QUIET_HOURS.start}:00 and 0{QUIET_HOURS.end}:00 in the workspace’s timezone.</p>
      </Section>
      <div className="ak-grid-2" style={{ alignItems: 'start' }}>
        <Section title="By template (30d)"><Table head={['Template', 'Sent', 'Last']} rows={d0.byTemplate.map((t) => [t.template as string, t.n as number, dt(t.last)])} /></Section>
        <Section title="Templates: preview and test send">
          <Table head={['Template', 'Stream', '']} rows={TEMPLATES.map((t) => [<Link key="p" href={`/email/preview/${t}`}>{t}</Link>, MARKETING_TEMPLATES.has(t) ? 'marketing' : 'transactional', <ActButton key="s" small action="email.test" payload={{ template: t }}>Send test to me</ActButton>])} />
          <p className="ak-small ak-muted">Previews and test sends use sample data ({env().APP_URL} links), never tenant content.</p>
        </Section>
      </div>
      <Section title="Owner addresses bouncing">
        <Table head={['Workspace', 'Bouncing since']} rows={d0.ownerBounces.map((w) => [<Link key="w" href={`/tenants/${w.id}`}>{w.name as string}</Link>, dt(w.owner_email_bouncing_at)])} empty="No owner addresses bouncing." />
        <p className="ak-small ak-muted">The workspace shows the owner a banner until mail to the address is delivered again.</p>
      </Section>
      <Section title="Suppressions">
        <Table head={['Email', 'Reason', 'Stream', 'Since', '']} rows={d0.suppressions.map((x) => [pii.email(x.email), x.reason as string, x.stream as string, dt(x.created_at), staffCan(s.roles, 'email.manage') ? <ActButton key="u" small action="email.unsuppress" payload={{ emailKey: emailKey(x.email as string) }} reason>Unsuppress</ActButton> : null])} />
      </Section>
      <Section title="Failed sends"><Table head={['When', 'To', 'Template', 'Error']} rows={d0.failed.map((f) => [dt(f.created_at), pii.email(f.to_email), f.template as string, JSON.stringify(f.events).slice(0, 120)])} /></Section>
    </Page>
  );
}
