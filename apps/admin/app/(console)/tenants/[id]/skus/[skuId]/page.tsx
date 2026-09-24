import Link from 'next/link';
import { notFound } from 'next/navigation';
import { withAdmin } from '@arkiv/db';
import { activeBreakGlass, assertBreakGlass, storage } from '@arkiv/core';
import { d, dt, Mono, Page, Section, Table } from '@/components/ui';
import { requireStaff } from '@/lib/staff';

export const metadata = { title: 'SKU (read-only)' };

const IMAGE_KINDS = new Set(['product_photo', 'cutout', 'reference_view', 'label_crop', 'brand_logo', 'thumbnail']);

/**
 * Plan 05 §2.2 Brands & SKUs → "Break-glass → open read-only SKU view": the SKU's product facts, claims with
 * their evidence, visual fingerprint, assets and experiments. Tenant content, so it needs an active break-glass
 * session and each view is audited as content access. Every query is scoped to this workspace explicitly (the
 * staff role's policies see every tenant).
 */
export default async function SkuView({ params }: { params: Promise<{ id: string; skuId: string }> }) {
  const s = await requireStaff('tenant.read');
  const { id, skuId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id) || !/^[0-9a-f-]{36}$/i.test(skuId)) notFound();
  const data = await withAdmin(async (tx) => {
    const [sku] = await tx`select s.*, b.name as brand from skus s left join brands b on b.id = s.brand_id and b.workspace_id = s.workspace_id
                           where s.id = ${skuId} and s.workspace_id = ${id}`;
    if (!sku) return null;
    if (!(await activeBreakGlass(tx, s, id))) return { sku: null };
    await assertBreakGlass(tx, s, id, `read-only SKU view ${skuId}`);
    const facts = await tx`select normalized_key, fact_type, value_text, value_number, value_json, source_type, source_url, state, status, confidence, merchant_confirmed, observed_at, created_by
                           from product_facts where workspace_id = ${id} and sku_id = ${skuId} and status <> 'SUPERSEDED' order by normalized_key, observed_at desc`;
    const claims = await tx`select c.id, c.preferred_wording, c.canonical_meaning, c.status, c.risk_level, c.allowed_markets, c.allowed_platforms, c.mandatory_qualifier, c.block_reason, c.origin, c.reviewed_at,
                                   coalesce((select json_agg(json_build_object('type', e.evidence_type, 'strength', e.evidence_strength, 'location', e.source_location,
                                                                               'applicability', e.applicability, 'expiry', e.expiry_date, 'asset', e.source_asset_id, 'by', e.supplied_by) order by e.created_at)
                                             from claim_evidence e where e.workspace_id = c.workspace_id and e.claim_id = c.id), '[]') as evidence
                            from claims c where c.workspace_id = ${id} and c.sku_id = ${skuId} order by c.status, c.created_at`;
    const [fp] = await tx`select version, label_text, brand_text, package_type, closure, dominant_colors, liquid_color, transparency, reference_asset_ids, cutout_asset_id, created_at
                          from visual_fingerprints where workspace_id = ${id} and sku_id = ${skuId} and active order by version desc limit 1`;
    const assets = await tx`select id, kind, mime, bytes, width, height, source, storage_key, rights_expires_at, created_at from assets
                            where workspace_id = ${id} and deleted_at is null
                              and (sku_id = ${skuId} or id in (select e.source_asset_id from claim_evidence e join claims c on c.id = e.claim_id and c.workspace_id = e.workspace_id
                                                               where c.workspace_id = ${id} and c.sku_id = ${skuId} and e.source_asset_id is not null))
                            order by kind, created_at desc limit 200`;
    // Short-lived links, signed from this workspace's own rows.
    const urls = new Map<string, string>();
    for (const a of assets) urls.set(a.id as string, await storage().signedGetUrl(a.storage_key as string, 600));
    const experiments = await tx`select id, state, mode, portfolio_slot, primary_variable, hypothesis, created_at, updated_at from experiments
                                 where workspace_id = ${id} and sku_id = ${skuId} order by created_at desc limit 50`;
    return { sku, facts, claims, fp, assets, urls, experiments };
  });
  if (!data) notFound();
  const back = `/tenants/${id}?tab=skus`;
  if (!data.sku) {
    return (
      <Page title="SKU (read-only)" sub={<Link href={back}>Back to Brands & SKUs</Link>}>
        <p className="ak-small">Tenant content needs break-glass. Start it from the Brands & SKUs tab; the customer sees it in their access log.</p>
      </Page>
    );
  }
  const { sku, facts, claims, fp, assets, urls, experiments } = data;
  const value = (f: Record<string, unknown>) => (f.value_text as string) ?? (f.value_number != null ? String(f.value_number) : f.value_json != null ? JSON.stringify(f.value_json).slice(0, 160) : '—');
  const refs = new Set<string>([...(((fp?.reference_asset_ids as string[]) ?? [])), ...(fp?.cutout_asset_id ? [fp.cutout_asset_id as string] : [])]);
  return (
    <Page
      title={`No. ${String(sku.catalogue_no).padStart(3, '0')} · ${sku.name as string}`}
      sub={<><Link href={back}>Brands & SKUs</Link> · {(sku.brand as string) ?? 'no brand'} · {sku.status as string} · {String(sku.maturity).toLowerCase()} · {(sku.category as string) ?? 'uncategorised'} · read-only (break-glass)</>}
    >
      <Table head={['', '']} rows={[
        ['Source', <span key="s" className="ak-small">{(sku.source_kind as string) ?? '—'} · {(sku.source_url as string) ?? '—'}</span>],
        ['Created', dt(sku.created_at)],
        ['Fidelity confidence', sku.fidelity_confidence != null ? String(sku.fidelity_confidence) : '—'],
      ]} />
      <Section title={`Product facts (${facts.length})`}>
        <Table head={['Key', 'Value', 'Source', 'State', 'Status', 'Confidence', 'Observed']} rows={facts.map((f) => [<Mono key="k">{f.normalized_key as string}</Mono>, <span key="v" className="ak-small">{value(f)}</span>, `${f.source_type as string}${f.merchant_confirmed ? ' · confirmed' : ''}`, f.state as string, f.status as string, String(f.confidence), d(f.observed_at)])} empty="No facts." />
      </Section>
      <Section title={`Claims (${claims.length})`}>
        <Table head={['Wording', 'Status', 'Risk', 'Markets · platforms', 'Qualifier', 'Evidence']} rows={claims.map((c) => [
          <span key="w">“{c.preferred_wording as string}”{c.block_reason ? <span className="ak-small ak-muted"> — {c.block_reason as string}</span> : null}</span>,
          c.status as string,
          c.risk_level as string,
          <span key="m" className="ak-small">{((c.allowed_markets as string[]) ?? []).join(', ')} · {((c.allowed_platforms as string[]) ?? []).join(', ')}</span>,
          (c.mandatory_qualifier as string) ?? '—',
          <span key="e" className="ak-small">{((c.evidence as { type: string; strength: string | null; location: string | null; asset: string | null; expiry: string | null }[]) ?? []).map((e, i) => (
            <span key={i} style={{ display: 'block' }}>{e.type}{e.strength ? ` (${e.strength})` : ''}{e.location ? ` · ${e.location}` : ''}{e.expiry ? ` · expires ${e.expiry}` : ''}{e.asset && urls.get(e.asset) ? <> · <a href={urls.get(e.asset)} target="_blank" rel="noreferrer">file</a></> : null}</span>
          ))}{(c.evidence as unknown[]).length ? null : '—'}</span>,
        ])} empty="No claims." />
      </Section>
      <Section title="Visual fingerprint">
        {fp ? (
          <Table head={['', '']} rows={[
            ['Version', `v${fp.version as number} · ${d(fp.created_at)}`],
            ['Label text (OCR)', <Mono key="l">{(fp.label_text as string) ?? '—'}</Mono>],
            ['Brand text', (fp.brand_text as string) ?? '—'],
            ['Package', `${(fp.package_type as string) ?? '—'} · closure ${(fp.closure as string) ?? '—'} · ${(fp.transparency as string) ?? '—'}`],
            ['Colours', <Mono key="c">{JSON.stringify(fp.dominant_colors)}{fp.liquid_color ? ` · liquid ${fp.liquid_color as string}` : ''}</Mono>],
          ]} />
        ) : <p className="ak-small ak-muted">No active fingerprint.</p>}
      </Section>
      <Section title={`Assets (${assets.length})`}>
        <Table head={['', 'Kind', 'Type', 'Size', 'Source', 'Rights until', 'Added']} rows={assets.map((a) => {
          const url = urls.get(a.id as string);
          return [
            IMAGE_KINDS.has(a.kind as string) && String(a.mime).startsWith('image/') && url ? <a key="i" href={url} target="_blank" rel="noreferrer"><img src={url} alt={a.kind as string} style={{ width: 64, border: '1px solid var(--rule)' }} /></a> : url ? <a key="i" href={url} target="_blank" rel="noreferrer">open</a> : '—',
            `${a.kind as string}${refs.has(a.id as string) ? ' · fingerprint reference' : ''}`,
            <Mono key="m">{a.mime as string}{a.width ? ` · ${a.width}×${a.height}` : ''}</Mono>,
            `${(Number(a.bytes) / 1024).toFixed(0)} KB`,
            a.source as string,
            a.rights_expires_at ? d(a.rights_expires_at) : '—',
            d(a.created_at),
          ];
        })} empty="No assets." />
      </Section>
      <Section title={`Experiments (${experiments.length})`}>
        <Table head={['Experiment', 'State', 'Mode', 'Slot', 'Variable', 'Hypothesis', 'Updated']} rows={experiments.map((e) => [<Mono key="i">{String(e.id).slice(0, 8)}</Mono>, String(e.state).toLowerCase(), String(e.mode).toLowerCase(), (e.portfolio_slot as string)?.toLowerCase() ?? '—', <Mono key="v">{e.primary_variable as string}</Mono>, <span key="h" className="ak-small">{e.hypothesis as string}</span>, d(e.updated_at)])} empty="No experiments." />
      </Section>
    </Page>
  );
}
