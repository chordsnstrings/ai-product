import Link from 'next/link';
import { notFound } from 'next/navigation';
import { withAdmin } from '@arkiv/db';
import { activeBreakGlass, assertBreakGlass, assetUrl, labelDiff, qaVerdictKey, staffCan, type CheckResult, type LineMapping } from '@arkiv/core';
import { ActForm } from '@/components/act';
import { Mono, Page, Section, Table } from '@/components/ui';
import { requireStaff } from '@/lib/staff';

export const metadata = { title: 'QA case' };

export default async function QaCase({ params, searchParams }: { params: Promise<{ projectId: string }>; searchParams: Promise<{ ws?: string }> }) {
  const s = await requireStaff('qa.review');
  const { projectId } = await params;
  const ws = (await searchParams).ws ?? '';
  if (!/^[0-9a-f-]{36}$/i.test(projectId) || !/^[0-9a-f-]{36}$/i.test(ws)) notFound();
  const d0 = await withAdmin(async (tx) => {
    const [p] = await tx`select * from projects where id = ${projectId} and workspace_id = ${ws}`;
    if (!p) return null;
    const bg = await activeBreakGlass(tx, s, ws);
    if (!bg) return { p, content: null };
    await assertBreakGlass(tx, s, ws, `QA case ${projectId}`);
    const [fp] = await tx`select reference_asset_ids, cutout_asset_id, label_text from visual_fingerprints where sku_id = ${p.sku_id} and active`;
    const refs = await Promise.all(((fp?.reference_asset_ids as string[]) ?? []).slice(0, 3).map((a) => assetUrl(tx, a, 900)));
    const [cr] = p.final_creative_id ? await tx`select final_asset_ids from creatives where id = ${p.final_creative_id}` : [null];
    const outputs = await Promise.all(((cr?.final_asset_ids as string[]) ?? []).slice(0, 1).map((a) => assetUrl(tx, a, 900)));
    const scenes = p.storyboard_id ? await tx`select position, spoken_line, overlay_text, production_mode, claim_ids from scenes where storyboard_id = ${p.storyboard_id} and workspace_id = ${ws} order by position` : [];
    // Claim IDs the stored line mapping refers to, with their approved wording (this workspace only).
    const mapped = ((p.qa_report as { checks?: CheckResult[] } | null)?.checks ?? [])
      .filter((c) => c.check === 'claims')
      .flatMap((c) => ((c.data as { mapping?: LineMapping[] } | undefined)?.mapping ?? []).map((m) => m.claimId))
      .filter((x): x is string => !!x && /^[0-9a-f-]{36}$/i.test(x));
    const claims = mapped.length ? await tx`select id, preferred_wording, status from claims where workspace_id = ${ws} and id = any(${[...new Set(mapped)]}::uuid[])` : [];
    return { p, content: { refs, outputs, label: fp?.label_text as string, scenes, claims } };
  });
  if (!d0) notFound();
  // Stored QA reports are summarize(CheckResult[]) from the QA Gateway (packages/core qa.ts).
  const checks = (d0.p.qa_report as { checks?: CheckResult[] } | null)?.checks ?? [];
  // Lines the claims check could not map to an approved Claim ID (plan 05 §13 "⚠ unmapped").
  type ClaimsData = { unmapped?: string[]; platforms?: { unmapped?: string[] }[] };
  const unmapped = new Set(
    checks
      .filter((c) => c.check === 'claims')
      .flatMap((c) => {
        const d = (c.data ?? {}) as ClaimsData;
        return [...(d.unmapped ?? []), ...(d.platforms ?? []).flatMap((p) => p.unmapped ?? [])];
      })
      .map((u) => u.trim()),
  );
  const palette = (c: CheckResult) => (typeof c.data?.paletteDistance === 'number' ? (c.data.paletteDistance as number).toFixed(1) : '—');
  // Every spoken / overlay line the claims check scanned, with the Claim ID it mapped to (plan 05 §13).
  const mapping = checks.filter((c) => c.check === 'claims').flatMap((c) => ((c.data ?? {}) as { mapping?: LineMapping[] }).mapping ?? []);
  const lines = [...new Map(mapping.map((m) => [`${m.line}\u0000${m.claimId ?? ''}\u0000${m.status}`, m])).values()];
  // Label-OCR diff per inspected scene: reference label vs the text read on the output.
  const ocr = checks.map((c, i) => ({ n: i + 1, detail: c.detail, read: c.check === 'product_fidelity' ? ((c.data?.labelTextRead as string | null | undefined) ?? null) : null })).filter((x) => x.read !== null);
  const canGolden = staffCan(s.roles, 'golden.add');
  return (
    <Page title={`QA case ${projectId.slice(0, 8)}`} sub={<><Link href={`/tenants/${ws}?tab=skus`}>Tenant</Link> · {d0.p.state as string}</>}>
      <Table head={['#', 'Check', 'Result', 'Severity', 'Palette distance', 'Detail']} rows={checks.map((c, i) => [i + 1, <Mono key="c">{c.check}</Mono>, c.pass ? '✓ pass' : '✗ fail', c.hard ? 'hard' : 'soft', palette(c), <span key="d" className="ak-small">{c.detail ?? ''}</span>])} empty="No QA report stored." />
      {d0.content ? (
        <>
          <div className="ak-grid-2" style={{ marginTop: 16 }}>
            <div><p className="ak-label">Reference photos</p><div className="ak-row">{d0.content.refs.map((u) => <img key={u} src={u} alt="reference" style={{ width: 140, border: '1px solid var(--rule)' }} />)}</div><p className="ak-small">Label: <Mono>{d0.content.label ?? '—'}</Mono></p></div>
            <div><p className="ak-label">Output</p>{d0.content.outputs[0] ? <video src={d0.content.outputs[0]} controls style={{ width: 240 }} /> : <p className="ak-small ak-muted">No output.</p>}</div>
          </div>
          <Section title="Label OCR diff (reference → read on output)">
            <p className="ak-small">Reference: <Mono>{d0.content.label ?? '—'}</Mono></p>
            <Table head={['Check #', 'Read on output', 'Diff', 'Detail']} rows={ocr.map((o) => [o.n, <Mono key="r">{o.read || '(nothing legible)'}</Mono>,
              <span key="d">{labelDiff(d0.content!.label, o.read).map((w, k) => <span key={k} style={{ marginRight: 4, ...(w.status === 'missing' ? { textDecoration: 'line-through', color: 'var(--signal-risk)' } : w.status === 'extra' ? { background: 'var(--signal-risk)', color: 'var(--paper)', padding: '0 2px' } : {}) }}>{w.word}</span>)}</span>,
              <span key="t" className="ak-small">{o.detail}</span>])} empty="No label read recorded (inspections before fidelity@1.1.0 don't return one)." />
          </Section>
          <Section title="Claim mapping (each spoken or overlay line → Claim ID)">
            <Table head={['Line', 'Maps to', 'Status', canGolden ? 'Golden set (compliance.scan)' : '']} rows={lines.map((m) => {
              const c = d0.content!.claims.find((x) => x.id === m.claimId);
              return [
                `“${m.line}”`,
                m.claimId ? <span key="c"><Mono>{m.claimId.slice(0, 8)}</Mono>{c ? <span className="ak-small"> · “{c.preferred_wording as string}” ({c.status as string})</span> : null}</span> : m.status === 'neutral' ? <span key="c" className="ak-muted">neutral (no claim)</span> : '—',
                m.status === 'unmapped' ? <span key="s" className="ak-chip ak-chip--risk">⚠ unmapped</span> : m.status === 'violation' ? <span key="s" className="ak-chip ak-chip--risk">violation</span> : m.status,
                canGolden ? (
                  <details key="g"><summary className="ak-small">Add as a case</summary>
                    <ActForm action="golden.add" extra={{ dataset: 'compliance.scan', input: m.line, source: 'production', workspaceId: ws, projectId }} submit="Add" fields={[
                      { name: 'expected', label: 'Correct verdict', type: 'select', options: ['block', 'pass'], defaultValue: m.status === 'violation' || m.status === 'unmapped' ? 'pass' : 'block' },
                      { name: 'consentRef', label: 'Tenant consent (ticket / document ref)', required: true },
                      { name: 'note', label: 'Why (the disagreement)' },
                    ]} />
                  </details>
                ) : null,
              ];
            })} empty="No line mapping stored for this report." />
            <Table head={['#', 'Spoken', 'Overlay', 'Scene claim IDs', 'Mode']} rows={d0.content.scenes.map((x) => {
              const flag = (line: unknown) => (typeof line === 'string' && unmapped.has(line.trim()) ? ' ⚠ unmapped' : '');
              return [Number(x.position) + 1, `${(x.spoken_line as string) ?? '—'}${flag(x.spoken_line)}`, `${(x.overlay_text as string) ?? '—'}${flag(x.overlay_text)}`, <Mono key="c">{((x.claim_ids as string[]) ?? []).map((id) => id.slice(0, 8)).join(', ') || '—'}</Mono>, x.production_mode as string];
            })} />
          </Section>
          <Section title="Verdict">
            <div className="ak-panel" style={{ maxWidth: 560 }}>
              <ActForm action="qa.review" extra={{ workspaceId: ws, projectId }} submit="Save verdict" fields={[
                { name: 'verdicts', label: 'Per check (JSON: {"<#>:<check>": "agree"|"disagree"})', type: 'json', defaultValue: JSON.stringify(Object.fromEntries(checks.map((c, i) => [qaVerdictKey(i, c.check), 'agree'])), null, 2) },
                { name: 'failureLabel', label: 'Failure taxonomy label', type: 'select', options: ['', 'label_drift', 'color_shift', 'shape_warp', 'extra_product', 'hands_artifact', 'claim_unmapped', 'audio', 'platform_spec', 'false_positive'] },
                { name: 'notes', label: 'Notes', type: 'textarea' },
              ]} />
            </div>
          </Section>
        </>
      ) : <p className="ak-banner" style={{ marginTop: 16 }}>Open break-glass on the <Link href={`/tenants/${ws}?tab=skus`}>tenant</Link> to view output and references.</p>}
    </Page>
  );
}
