import Link from 'next/link';
import { notFound } from 'next/navigation';
import { withAdmin } from '@arkiv/db';
import { activeBreakGlass, assertBreakGlass, assetUrl, qaVerdictKey, type CheckResult } from '@arkiv/core';
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
    return { p, content: { refs, outputs, label: fp?.label_text as string, scenes } };
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
  return (
    <Page title={`QA case ${projectId.slice(0, 8)}`} sub={<><Link href={`/tenants/${ws}?tab=skus`}>Tenant</Link> · {d0.p.state as string}</>}>
      <Table head={['#', 'Check', 'Result', 'Severity', 'Palette distance', 'Detail']} rows={checks.map((c, i) => [i + 1, <Mono key="c">{c.check}</Mono>, c.pass ? '✓ pass' : '✗ fail', c.hard ? 'hard' : 'soft', palette(c), <span key="d" className="ak-small">{c.detail ?? ''}</span>])} empty="No QA report stored." />
      {d0.content ? (
        <>
          <div className="ak-grid-2" style={{ marginTop: 16 }}>
            <div><p className="ak-label">Reference photos</p><div className="ak-row">{d0.content.refs.map((u) => <img key={u} src={u} alt="reference" style={{ width: 140, border: '1px solid var(--rule)' }} />)}</div><p className="ak-small">Label: <Mono>{d0.content.label ?? '—'}</Mono></p></div>
            <div><p className="ak-label">Output</p>{d0.content.outputs[0] ? <video src={d0.content.outputs[0]} controls style={{ width: 240 }} /> : <p className="ak-small ak-muted">No output.</p>}</div>
          </div>
          <Section title="Claim mapping (spoken + overlay lines)"><Table head={['#', 'Spoken', 'Overlay', 'Claim IDs', 'Mode']} rows={d0.content.scenes.map((x) => {
            const flag = (line: unknown) => (typeof line === 'string' && unmapped.has(line.trim()) ? ' ⚠ unmapped' : '');
            return [Number(x.position) + 1, `${(x.spoken_line as string) ?? '—'}${flag(x.spoken_line)}`, `${(x.overlay_text as string) ?? '—'}${flag(x.overlay_text)}`, <Mono key="c">{((x.claim_ids as string[]) ?? []).map((id) => id.slice(0, 8)).join(', ') || '—'}</Mono>, x.production_mode as string];
          })} /></Section>
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
