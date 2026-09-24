import { withAdmin } from '@arkiv/db';
import { auditView, shouldMaskPii, staffCan } from '@arkiv/core';
import { ActButton, ActForm } from '@/components/act';
import { dt, Page, pct, Section, Table } from '@/components/ui';
import { emailKey } from '@/lib/email-key';
import { piiView } from '@/lib/mask';
import { consolePrefs } from '@/lib/prefs';
import { notTest } from '@/lib/sql';
import { requireStaff } from '@/lib/staff';

export const metadata = { title: 'Email' };

/** Plan 05 §18: Resend stats, suppressions, complaint-rate guard, test sends. Templates live in git. */
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
    };
  });
  return (
    <Page title="Email & lifecycle" sub={`Transactional (mail.) and marketing (news.) are separate streams. Marketing auto-pauses above 0.1% complaints. Test accounts ${prefs.includeTest ? 'included' : 'excluded'}.${pii.mask ? ' Addresses are masked for your role.' : ''}`}>
      <Table head={['Stream (30d)', 'Sent', 'Delivered', 'Bounced', 'Complaints', 'Complaint rate']} rows={d0.stats.map((r) => {
        const high = Number(r.complained) / Number(r.sent) > 0.001;
        return [r.stream as string, r.sent as number, r.delivered as number, r.bounced as number, r.complained as number, <span key="c" style={{ color: high ? 'var(--risk)' : undefined }}>{pct(Number(r.complained) / Number(r.sent), 2)}{high ? ' ⚠ above 0.1%' : ''}</span>];
      })} empty="Nothing sent in 30 days." />
      <div className="ak-grid-2" style={{ alignItems: 'start' }}>
        <Section title="By template (30d)"><Table head={['Template', 'Sent', 'Last']} rows={d0.byTemplate.map((t) => [t.template as string, t.n as number, dt(t.last)])} /></Section>
        <Section title="Test send to yourself">
          <div className="ak-panel"><ActForm action="email.test" submit="Send" fields={[{ name: 'template', label: 'Template', type: 'select', options: ['magic_link', 'receipt', 'asset_ready', 'weekly_brief', 'cancellation_confirmed'] }]} /></div>
        </Section>
      </div>
      <Section title="Suppressions">
        <Table head={['Email', 'Reason', 'Stream', 'Since', '']} rows={d0.suppressions.map((x) => [pii.email(x.email), x.reason as string, x.stream as string, dt(x.created_at), staffCan(s.roles, 'email.manage') ? <ActButton key="u" small action="email.unsuppress" payload={{ emailKey: emailKey(x.email as string) }} reason>Unsuppress</ActButton> : null])} />
      </Section>
      <Section title="Failed sends"><Table head={['When', 'To', 'Template', 'Error']} rows={d0.failed.map((f) => [dt(f.created_at), pii.email(f.to_email), f.template as string, JSON.stringify(f.events).slice(0, 120)])} /></Section>
    </Page>
  );
}
