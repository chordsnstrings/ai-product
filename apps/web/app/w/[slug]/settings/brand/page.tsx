import type { Metadata } from 'next';
import Link from 'next/link';
import { withTenant } from '@arkiv/db';
import { assetUrl, brandBrainHistory, listBrands, planQuota, toBrain } from '@arkiv/core';
import type { PlanCode } from '@arkiv/shared';
import { ActionButton, ActionForm } from '@/components/actions';
import { workspacePage } from '@/lib/tenant';
import { formatDate } from '@arkiv/shared/format';

export const metadata: Metadata = { title: 'Brand' };

const MARKETS = [['US', 'United States'], ['CA', 'Canada'], ['GB', 'United Kingdom'], ['IE', 'Ireland'], ['AU', 'Australia'], ['NZ', 'New Zealand'], ['EU', 'European Union']] as const;
const FIELD: Record<string, string> = {
  name: 'name',
  tone: 'tone',
  colors: 'colours',
  fonts: 'fonts',
  logoAssetId: 'logo',
  visualReferenceAssetIds: 'visual references',
  prohibited: 'never show or say',
  talentTypes: 'talent',
  disclosures: 'disclosures',
  cta: 'call to action',
  ctaVocabulary: 'CTA vocabulary',
  claims: 'brand-wide claims',
  restrictions: 'restrictions',
  market: 'market',
  voice: 'voice',
};

/**
 * Brand Brain (standard §16): logo, colours, font rules, tone, visual references, prohibited aesthetics, approved
 * talent types, disclosures, CTA vocabulary and brand-wide claims or restrictions — per brand, as many brands as the
 * plan allows. Everything here feeds every concept and storyboard of the brand's products. Every save is a version.
 */
export default async function Brand({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ brand?: string }> }) {
  const { slug } = await params;
  const { brand: wanted } = await searchParams;
  const w = await workspacePage(slug);
  const d = await withTenant(w.ctx.workspaceId, async (tx) => {
    const brands = await listBrands(tx);
    const row = brands.find((b) => b.id === wanted) ?? brands[0];
    const brain = toBrain(row?.brain);
    const [ws] = await tx`select plan_code from workspaces where id = ${w.ctx.workspaceId}`;
    const quota = await planQuota(tx, (ws?.plan_code as PlanCode | null) ?? null);
    const files = [brain.logoAssetId, ...brain.visualReferenceAssetIds].filter((x): x is string => !!x);
    const live = files.length ? await tx`select id from assets where id = any(${files}::uuid[]) and deleted_at is null` : [];
    const url = async (id: string | null) => (id && live.some((a) => a.id === id) ? assetUrl(tx, id) : null);
    return {
      brands,
      row,
      brain,
      maxBrands: quota.brands,
      logo: await url(brain.logoAssetId),
      references: (await Promise.all(brain.visualReferenceAssetIds.map(async (id) => ({ id, url: await url(id) })))).filter((r) => r.url),
      history: row ? await brandBrainHistory(tx, row.id as string) : [],
    };
  });
  const { row, brain } = d;
  const brandId = (row?.id as string | undefined) ?? null;
  const canEdit = ['OWNER', 'ADMIN', 'MEMBER'].includes(w.ctx.role);
  const canAdd = ['OWNER', 'ADMIN'].includes(w.ctx.role) && d.brands.length < d.maxBrands;
  return (
    <div className="ak-grid-2" style={{ alignItems: 'start' }}>
      <div className="ak-stack">
        {d.brands.length > 1 ? (
          <nav className="ak-row" aria-label="Brands" style={{ flexWrap: 'wrap' }}>
            {d.brands.map((b) => (
              <Link key={b.id as string} href={`?brand=${b.id as string}`} aria-current={b.id === brandId ? 'page' : undefined} className="ak-textbtn" style={{ borderBottom: b.id === brandId ? '1px solid var(--ink)' : '1px solid transparent' }}>
                {b.name as string} <span className="ak-index">{Number(b.skus)} product{Number(b.skus) === 1 ? '' : 's'}</span>
              </Link>
            ))}
          </nav>
        ) : null}
        <div className="ak-panel">
          <h2 className="ak-label">Brand brain</h2>
          {canEdit ? (
            <ActionForm slug={slug} action="brand" submit="Save brand" extra={brandId ? { brandId } : {}} fields={[
              { name: 'name', label: 'Brand name', required: true, defaultValue: (row?.name as string) ?? w.name, max: 80 },
              { name: 'tone', label: 'Tone of voice', type: 'textarea', defaultValue: brain.tone ?? '', max: 300, placeholder: 'e.g. calm, clinical, never hypey' },
              { name: 'colors', label: 'Brand colours', defaultValue: brain.colors.join(', '), max: 200, placeholder: '#1F2A44, #F4EDE4', hint: 'Hex codes, up to six.' },
              { name: 'headingFont', label: 'Heading font', defaultValue: brain.fonts.heading ?? '', max: 60, placeholder: 'e.g. Canela' },
              { name: 'bodyFont', label: 'Body font', defaultValue: brain.fonts.body ?? '', max: 60, placeholder: 'e.g. Inter' },
              { name: 'prohibited', label: 'Never show or say', type: 'textarea', defaultValue: brain.prohibited ?? '', max: 500, placeholder: 'e.g. before/after splits, bathroom selfies, “miracle”' },
              { name: 'talentTypes', label: 'Approved talent (one per line)', type: 'textarea', defaultValue: brain.talentTypes.join('\n'), max: 800, placeholder: 'e.g. women 30–45, natural makeup' },
              { name: 'disclosures', label: 'Required disclosures', type: 'textarea', defaultValue: brain.disclosures ?? '', max: 500 },
              { name: 'cta', label: 'Preferred call to action', defaultValue: brain.cta ?? '', max: 40, placeholder: 'e.g. Shop the serum' },
              { name: 'ctaVocabulary', label: 'Other calls to action you use (one per line)', type: 'textarea', defaultValue: brain.ctaVocabulary.join('\n'), max: 600 },
              { name: 'claims', label: 'Brand-wide claims (one per line)', type: 'textarea', defaultValue: brain.claims.join('\n'), max: 2000, placeholder: 'e.g. Cruelty-free', hint: 'Added to each of this brand’s products for you to approve there. Nothing is approved automatically.' },
              { name: 'restrictions', label: 'Brand-wide restrictions (one per line)', type: 'textarea', defaultValue: brain.restrictions.join('\n'), max: 1500, placeholder: 'e.g. never say “clean beauty”' },
              { name: 'market', label: 'Market you sell in (claims are approved per market)', type: 'select', defaultValue: brain.market, options: MARKETS.map(([value, label]) => ({ value, label })) },
              { name: 'reason', label: 'What changed (optional)', max: 200 },
            ]} />
          ) : <p className="ak-muted">Only members can edit the brand.</p>}
        </div>
        {canEdit && brandId ? (
          <div className="ak-panel ak-stack">
            <h2 className="ak-label">Logo and visual references</h2>
            {d.logo ? <img src={d.logo} alt={`${(row?.name as string) ?? 'Brand'} logo`} style={{ maxWidth: 160, maxHeight: 80, objectFit: 'contain' }} /> : <p className="ak-small ak-muted" style={{ margin: 0 }}>No logo yet.</p>}
            <ActionForm slug={slug} action="brand-logo" multipart extra={{ brandId }} submit={d.logo ? 'Replace logo' : 'Add logo'} fields={[{ name: 'file', label: 'Logo (PNG or JPG)', type: 'file', accept: 'image/*', required: true }]} />
            {d.references.length ? (
              <div className="ak-grid-3">
                {d.references.map((r) => (
                  <figure key={r.id} className="ak-frame" style={{ margin: 0 }}>
                    <div className="ak-well" style={{ aspectRatio: '1' }}><img src={r.url!} alt="Visual reference" style={{ objectFit: 'cover', width: '100%', height: '100%' }} /></div>
                    <ActionButton slug={slug} action="brand-reference-remove" variant="text" body={{ brandId, assetId: r.id }}>Remove</ActionButton>
                  </figure>
                ))}
              </div>
            ) : null}
            <ActionForm slug={slug} action="brand-reference" multipart extra={{ brandId }} submit="Add reference" fields={[{ name: 'file', label: 'A photo or ad whose look you want (mood, light, styling)', type: 'file', accept: 'image/*', required: true }]} />
          </div>
        ) : null}
      </div>
      <div className="ak-small ak-muted">
        <p>Everything here is sent with each concept and storyboard request for this brand’s products. It shapes voice and visuals; it never overrides claim rules, and a product’s own facts win over brand guidance.</p>
        <p>Workspace name: <strong>{w.name}</strong></p>
        {canAdd ? (
          <ActionForm slug={slug} action="brand-create" submit="Add a brand" fields={[{ name: 'name', label: `Another brand (${d.brands.length} of ${d.maxBrands})`, required: true, max: 80 }]} />
        ) : d.brands.length >= d.maxBrands && d.maxBrands > 1 ? <p>Your plan includes {d.maxBrands} brands.</p> : null}
        {d.history.length ? (
          <>
            <p className="ak-label">History</p>
            {d.history.slice(0, 8).map((h) => (
              <div key={h.id as string} className="ak-index-row">
                <span>
                  v{h.version as number} · {Object.keys((h.diff as Record<string, unknown>) ?? {}).map((k) => FIELD[k] ?? k).join(', ') || 'first version'}
                  {h.reason ? ` — ${h.reason as string}` : ''}
                </span>
                <span className="ak-index">{formatDate(h.created_at as string)}</span>
              </div>
            ))}
          </>
        ) : null}
        {['OWNER', 'ADMIN'].includes(w.ctx.role) ? <ActionForm slug={slug} action="rename" submit="Rename workspace" fields={[{ name: 'name', label: 'Workspace name', defaultValue: w.name, required: true, max: 80 }]} /> : null}
      </div>
    </div>
  );
}
