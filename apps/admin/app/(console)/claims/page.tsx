import Link from 'next/link';
import { withAdmin } from '@arkiv/db';
import { audit, RULES, RULES_VERSION } from '@arkiv/core';
import { ActForm } from '@/components/act';
import { ago, Mono, Page, Section, Table } from '@/components/ui';
import { requireStaff } from '@/lib/staff';

export const metadata = { title: 'Claims & compliance' };

/**
 * Plan 05 §14. Tenants route RESTRICTED claims to us for review, so the compliance team sees claim text and
 * evidence metadata without break-glass; every page view is still audited as content access.
 */
export default async function Claims() {
  const s = await requireStaff('claims.review');
  const d0 = await withAdmin(async (tx) => {
    await audit(tx, s, 'content.view', { type: 'queue', id: 'claims' }, { reason: 'compliance review queues' });
    return {
      restricted: await tx`select c.id, c.workspace_id, c.preferred_wording, c.claim_category, c.block_reason, c.created_at, w.name, s.catalogue_no,
                                  (select count(*) from claim_evidence e where e.claim_id = c.id)::int as evidence
                           from claims c join workspaces w on w.id = c.workspace_id join skus s on s.id = c.sku_id where c.status = 'RESTRICTED' order by c.created_at`,
      blocked: await tx`select w.id, w.name, count(*)::int as n, max(c.created_at) as last from claims c join workspaces w on w.id = c.workspace_id
                        where c.status = 'BLOCKED' and c.origin = 'merchant' and c.created_at > now() - interval '30 days' group by w.id, w.name having count(*) >= 3 order by n desc`,
      implied: await tx`select p.id, p.workspace_id, w.name, p.qa_report->'impliedClaims' as flags, p.updated_at from projects p join workspaces w on w.id = p.workspace_id
                        where jsonb_array_length(coalesce(p.qa_report->'impliedClaims', '[]'::jsonb)) > 0 order by p.updated_at desc limit 50`,
      excluded: await tx`select s.id, s.workspace_id, w.name, s.reject_reason, s.created_at from skus s join workspaces w on w.id = s.workspace_id where s.status = 'rejected' order by s.created_at desc limit 50`,
      staffBlocked: await tx`select c.id, c.workspace_id, c.preferred_wording, c.block_reason, w.name from claims c join workspaces w on w.id = c.workspace_id where c.status = 'BLOCKED' and c.approved_by like 'staff:%' order by c.reviewed_at desc limit 30`,
    };
  });
  return (
    <Page title="Claims & compliance" sub={`Rules ${RULES_VERSION} · ${RULES.length} deterministic rules decide; the LLM only suggests.`}>
      <Section title={`Restricted queue (${d0.restricted.length})`}>
        <Table head={['Since', 'Workspace', 'SKU', 'Claim', 'Category', 'Evidence', 'Decision']} rows={d0.restricted.map((c) => [
          ago(c.created_at), <Link key="w" href={`/tenants/${c.workspace_id}`}>{c.name as string}</Link>, String(c.catalogue_no).padStart(3, '0'), `“${c.preferred_wording}”`, c.claim_category as string, c.evidence as number,
          <ActForm key="f" inline action="claim.decide" extra={{ workspaceId: c.workspace_id, claimId: c.id }} submit="Decide" fields={[
            { name: 'decision', label: 'Decision', type: 'select', options: ['approve', 'block'] },
            { name: 'wording', label: 'Exact wording', defaultValue: c.preferred_wording as string },
            { name: 'qualifier', label: 'Qualifier' },
            { name: 'platforms', label: 'Platforms', defaultValue: 'meta,tiktok' },
            { name: 'reason', label: 'Reason', required: true },
          ]} />,
        ])} empty="Nothing waiting for compliance review." />
      </Section>
      <Section title="Implied-claim flags (whole-creative scan)"><Table head={['Project', 'Workspace', 'Flags', 'When']} rows={d0.implied.map((p) => [<Link key="p" href={`/qa/${p.id}?ws=${p.workspace_id}`}><Mono>{String(p.id).slice(0, 8)}</Mono></Link>, p.name as string, <Mono key="f">{JSON.stringify(p.flags).slice(0, 160)}</Mono>, ago(p.updated_at)])} empty="No implied-claim flags." /></Section>
      <Section title="Repeated blocked-claim attempts (education, not punishment)"><Table head={['Workspace', 'Blocked (30d)', 'Last']} rows={d0.blocked.map((b) => [<Link key="w" href={`/tenants/${b.id}`}>{b.name as string}</Link>, b.n as number, ago(b.last)])} empty="No repeated patterns." /></Section>
      <Section title="Out-of-scope products (drug/OTC/non-skincare detector)"><Table head={['Workspace', 'Reason', 'When']} rows={d0.excluded.map((x) => [<Link key="w" href={`/tenants/${x.workspace_id}`}>{x.name as string}</Link>, (x.reject_reason as string) ?? '—', ago(x.created_at)])} empty="None." /></Section>
      <Section title="Blocked by compliance (unblock needs a second approver)">
        <Table head={['Workspace', 'Claim', 'Reason', '']} rows={d0.staffBlocked.map((c) => [c.name as string, `“${c.preferred_wording}”`, (c.block_reason as string) ?? '', <ActForm key="u" inline action="claim.decide" extra={{ workspaceId: c.workspace_id, claimId: c.id, decision: 'unblock' }} submit="Request unblock" fields={[{ name: 'reason', label: 'Reason', required: true }]} />])} empty="None." />
      </Section>
      <Section title="Rule check sandbox"><div className="ak-panel" style={{ maxWidth: 560 }}><ActForm action="claim.check" submit="Classify" fields={[{ name: 'text', label: 'Claim text', required: true }]} /></div></Section>
      <Section title="Rule set"><Table head={['Rule', 'Status', 'Risk', 'Reason']} rows={RULES.map((r) => [<Mono key="i">{r.id}</Mono>, r.status, r.risk, <span key="r" className="ak-small">{r.reason}</span>])} /></Section>
    </Page>
  );
}
