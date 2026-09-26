import Link from 'next/link';
import { withAdmin } from '@arkiv/db';
import { activeBreakGlass, assetUrl, audit, RULES, RULES_VERSION } from '@arkiv/core';
import { ActButton, ActForm } from '@/components/act';
import { ago, d, Mono, Page, Section, Table } from '@/components/ui';
import { requireStaff } from '@/lib/staff';

export const metadata = { title: 'Claims & compliance' };

type Evidence = { id: string; type: string; strength: string | null; location: string | null; supplied_by: string; expiry: string | null };

/**
 * Plan 05 §14. Tenants route RESTRICTED claims to us for review, so the compliance team sees claim text and
 * evidence metadata without break-glass; every page view is still audited as content access. Held media
 * (before/after, possible minors) is shown only under break-glass on its workspace.
 */
export default async function Claims() {
  const s = await requireStaff('claims.review');
  const d0 = await withAdmin(async (tx) => {
    await audit(tx, s, 'content.view', { type: 'queue', id: 'claims' }, { reason: 'compliance review queues' });
    const media = await tx`select a.id, a.workspace_id, a.kind, a.mime, a.review_flags, a.created_at, a.origin->>'filename' as filename, a.origin->'beforeAfter' as attestation, w.name, k.name as sku_name, k.catalogue_no
                           from assets a join workspaces w on w.id = a.workspace_id left join skus k on k.id = a.sku_id and k.workspace_id = a.workspace_id
                           where a.review_status = 'pending' and a.deleted_at is null order by a.created_at limit 50`;
    // Media is tenant content: a preview only where this staff member holds break-glass on the workspace.
    const previews = new Map<string, string>();
    for (const m of media) {
      if (String(m.mime).startsWith('image/') && (await activeBreakGlass(tx, s, m.workspace_id as string))) previews.set(m.id as string, await assetUrl(tx, m.id as string, 600));
    }
    return {
      restricted: await tx`select c.id, c.workspace_id, c.preferred_wording, c.claim_category, c.block_reason, c.created_at, c.allowed_markets, c.allowed_platforms,
                                  c.compliance_note, c.evidence_requested_at, w.name, s.catalogue_no, s.name as sku_name,
                                  coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'type', e.evidence_type, 'strength', e.evidence_strength, 'location', e.source_location,
                                                                                'supplied_by', e.supplied_by, 'expiry', e.expiry_date) order by e.created_at)
                                            from claim_evidence e where e.claim_id = c.id and e.workspace_id = c.workspace_id), '[]'::jsonb) as evidence
                           from claims c join workspaces w on w.id = c.workspace_id join skus s on s.id = c.sku_id and s.workspace_id = c.workspace_id
                           where c.status = 'RESTRICTED' order by c.created_at`,
      blocked: await tx`select w.id, w.name, count(*)::int as n, max(c.created_at) as last,
                               (select max(r.created_at) from compliance_reviews r where r.workspace_id = w.id and r.kind = 'blocked_pattern') as escalated_at
                        from claims c join workspaces w on w.id = c.workspace_id
                        where c.status = 'BLOCKED' and c.origin = 'merchant' and c.created_at > now() - interval '30 days' group by w.id, w.name having count(*) >= 3 order by n desc`,
      implied: await tx`select p.id, p.workspace_id, w.name, p.qa_report->'impliedClaims' as flags, p.updated_at from projects p join workspaces w on w.id = p.workspace_id
                        where jsonb_array_length(coalesce(p.qa_report->'impliedClaims', '[]'::jsonb)) > 0
                          and not exists (select 1 from compliance_reviews r where r.workspace_id = p.workspace_id and r.kind = 'implied_claim' and r.subject_id = p.id)
                        order by p.updated_at desc limit 50`,
      excluded: await tx`select s.id, s.workspace_id, s.name as sku_name, w.name, s.reject_reason, s.created_at, s.exclusion_confirmed_at from skus s join workspaces w on w.id = s.workspace_id
                         where s.status = 'rejected' order by s.exclusion_confirmed_at nulls first, s.created_at desc limit 50`,
      staffBlocked: await tx`select c.id, c.workspace_id, c.preferred_wording, c.block_reason, w.name from claims c join workspaces w on w.id = c.workspace_id where c.status = 'BLOCKED' and c.approved_by like 'staff:%' order by c.reviewed_at desc limit 30`,
      media,
      previews,
    };
  });
  return (
    <Page title="Claims & compliance" sub={`Rules ${RULES_VERSION} · ${RULES.length} deterministic rules decide; the LLM only suggests.`}>
      <Section title={`Restricted queue (${d0.restricted.length})`}>
        <Table head={['Since', 'Workspace', 'SKU', 'Claim', 'Evidence attached', 'Requested markets · platforms', 'Decision']} rows={d0.restricted.map((c) => {
          const ev = (c.evidence as Evidence[]) ?? [];
          return [
            ago(c.created_at), <Link key="w" href={`/tenants/${c.workspace_id}`}>{c.name as string}</Link>,
            <span key="k">{String(c.catalogue_no).padStart(3, '0')} <span className="ak-small ak-muted">{(c.sku_name as string) ?? ''}</span></span>,
            <span key="c">“{c.preferred_wording as string}”<br /><span className="ak-small ak-muted">{c.claim_category as string}{c.compliance_note ? ` · note: ${c.compliance_note as string}` : ''}{c.evidence_requested_at ? ` · evidence requested ${d(c.evidence_requested_at)}` : ''}</span></span>,
            ev.length ? <ul key="e" className="ak-small" style={{ margin: 0, paddingLeft: 16 }}>{ev.map((e, n) => <li key={n}><Mono>{e.id}</Mono> {e.type}{e.strength ? ` (${e.strength})` : ''}{e.location ? ` · ${e.location}` : ''}{e.expiry ? ` · expires ${d(e.expiry)}` : ''} · by {e.supplied_by}</li>)}</ul> : <span key="e" className="ak-muted">none</span>,
            <span key="m" className="ak-small">{((c.allowed_markets as string[]) ?? []).join(', ') || '—'} · {((c.allowed_platforms as string[]) ?? []).join(', ') || '—'}</span>,
            <ActForm key="f" inline action="claim.decide" extra={{ workspaceId: c.workspace_id, claimId: c.id }} submit="Decide" fields={[
              { name: 'decision', label: 'Decision', type: 'select', options: [
                { value: 'approve', label: 'Approve (exact wording + qualifier)' },
                { value: 'keep_restricted', label: 'Keep restricted' },
                { value: 'request_evidence', label: 'Request more evidence (emails the brand)' },
                { value: 'block', label: 'Block' },
                { value: 'approve_without_evidence', label: 'Approve without qualifying evidence (second reviewer)' },
              ] },
              { name: 'wording', label: 'Exact wording', defaultValue: c.preferred_wording as string },
              { name: 'qualifier', label: 'Qualifier' },
              { name: 'platforms', label: 'Platforms (TIKTOK, META = Reels + Feed, YOUTUBE, ORGANIC)', defaultValue: ((c.allowed_platforms as string[]) ?? []).join(',') || 'TIKTOK,META' },
              { name: 'markets', label: 'Markets (blank = brand market)', defaultValue: ((c.allowed_markets as string[]) ?? []).join(',') },
              { name: 'evidenceIds', label: 'Evidence ids relied on (blank = every product-specific file on record)' },
              { name: 'reason', label: 'Reason / what evidence we need (approving without evidence goes to a second compliance reviewer)', required: true },
            ]} />,
          ];
        })} empty="Nothing waiting for compliance review." />
      </Section>
      <Section title="Implied-claim flags (whole-creative scan)">
        <Table head={['Project', 'Workspace', 'Flags', 'When', 'Resolve']} rows={d0.implied.map((p) => [
          <Link key="p" href={`/qa/${p.id}?ws=${p.workspace_id}`}><Mono>{String(p.id).slice(0, 8)}</Mono></Link>, p.name as string, <Mono key="f">{JSON.stringify(p.flags).slice(0, 160)}</Mono>, ago(p.updated_at),
          <ActForm key="r" inline action="implied_flag.resolve" extra={{ workspaceId: p.workspace_id, projectId: p.id }} submit="Resolve" fields={[
            { name: 'verdict', label: 'Verdict', type: 'select', options: [{ value: 'dismissed', label: 'False positive' }, { value: 'confirmed', label: 'Confirmed implication' }] },
            { name: 'reason', label: 'Reason', required: true },
          ]} />,
        ])} empty="No open implied-claim flags." />
      </Section>
      <Section title="Repeated blocked-claim attempts (education, not punishment)">
        <Table head={['Workspace', 'Blocked (30d)', 'Last', '']} rows={d0.blocked.map((b) => [
          <Link key="w" href={`/tenants/${b.id}`}>{b.name as string}</Link>, b.n as number, ago(b.last),
          b.escalated_at && Date.now() - new Date(b.escalated_at as string).getTime() < 30 * 86400_000
            ? <span key="e" className="ak-small ak-muted">escalated {ago(b.escalated_at)}</span>
            : <ActButton key="e" small action="blocked_pattern.escalate" payload={{ workspaceId: b.id }} reason="What should the brand know?">Escalate: send guidance</ActButton>,
        ])} empty="No repeated patterns." />
      </Section>
      <Section title="Out-of-scope products (drug/OTC/non-skincare detector)">
        <Table head={['Workspace', 'Product', 'Reason', 'When', '']} rows={d0.excluded.map((x) => [
          <Link key="w" href={`/tenants/${x.workspace_id}`}>{x.name as string}</Link>, (x.sku_name as string) ?? '—', (x.reject_reason as string) ?? '—', ago(x.created_at),
          x.exclusion_confirmed_at ? <span key="c" className="ak-small ak-muted">confirmed {ago(x.exclusion_confirmed_at)}</span>
            : <ActButton key="c" small action="sku.confirm_exclusion" payload={{ workspaceId: x.workspace_id, skuId: x.id }} reason="Why is it out of V1 scope?">Confirm exclusion · tell the owner</ActButton>,
        ])} empty="None." />
      </Section>
      <Section title={`Before/after & possible minors (${d0.media.length})`}>
        <p className="ak-small ak-muted">Merchant media the product analyst or its file name flagged. Held media is never used in production until approved. Viewing it needs break-glass on the workspace.</p>
        <Table head={['Since', 'Workspace', 'Product', 'Media', 'Flags', 'Preview', 'Decision']} rows={d0.media.map((m) => {
          const f = (m.review_flags ?? {}) as { beforeAfter?: boolean; possibleMinor?: boolean; sources?: string[] };
          const preview = d0.previews.get(m.id as string);
          return [
            ago(m.created_at), <Link key="w" href={`/tenants/${m.workspace_id}`}>{m.name as string}</Link>, m.sku_name ? `${String(m.catalogue_no).padStart(3, '0')} ${m.sku_name as string}` : '—',
            <span key="k" className="ak-small">{m.kind as string}{m.filename ? ` · ${m.filename as string}` : ''}</span>,
            <span key="f" className="ak-small">
              {[f.beforeAfter ? 'before/after' : null, f.possibleMinor ? 'possible minor' : null].filter(Boolean).join(', ')} <span className="ak-muted">({(f.sources ?? []).join(', ')})</span>
              {f.beforeAfter ? <><br />{m.attestation ? 'Merchant attested: consent · unretouched · same conditions' : <span style={{ color: 'var(--risk)' }}>No permission attestation: approve only with a written-permission reference</span>}</> : null}
            </span>,
            preview ? <img key="p" src={preview} alt="held media" style={{ width: 120, border: '1px solid var(--rule)' }} /> : <Link key="p" href={`/tenants/${m.workspace_id}`} className="ak-small">open break-glass</Link>,
            <ActForm key="d" inline action="asset.review" extra={{ workspaceId: m.workspace_id, assetId: m.id }} submit="Decide" fields={[
              { name: 'verdict', label: 'Verdict', type: 'select', options: [{ value: 'rejected', label: 'Reject (never used)' }, { value: 'approved', label: 'Approve for use' }] },
              ...(f.beforeAfter && !m.attestation ? [{ name: 'permissionRef', label: 'Written permission (ticket / email ref)' }] : []),
              { name: 'reason', label: 'Reason', required: true },
            ]} />,
          ];
        })} empty="Nothing held for review." />
      </Section>
      <Section title="Blocked by compliance (unblock needs a second approver)">
        <Table head={['Workspace', 'Claim', 'Reason', '']} rows={d0.staffBlocked.map((c) => [c.name as string, `“${c.preferred_wording}”`, (c.block_reason as string) ?? '', <ActForm key="u" inline action="claim.decide" extra={{ workspaceId: c.workspace_id, claimId: c.id, decision: 'unblock' }} submit="Request unblock" fields={[{ name: 'reason', label: 'Reason', required: true }]} />])} empty="None." />
      </Section>
      <Section title="Rule check sandbox"><div className="ak-panel" style={{ maxWidth: 560 }}><ActForm action="claim.check" submit="Classify" fields={[{ name: 'text', label: 'Claim text', required: true }]} /></div></Section>
      <Section title="Rule set"><Table head={['Rule', 'Status', 'Risk', 'Reason']} rows={RULES.map((r) => [<Mono key="i">{r.id}</Mono>, r.status, r.risk, <span key="r" className="ak-small">{r.reason}</span>])} /></Section>
    </Page>
  );
}
