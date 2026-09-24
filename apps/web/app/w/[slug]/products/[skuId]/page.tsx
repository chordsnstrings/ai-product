import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { withTenant } from '@arkiv/db';
import { assetUrl, currentFacts, verifiedIngredients } from '@arkiv/core';
import { MetadataTable, SpecimenCard } from '@arkiv/ui';
import { ProvenanceChip } from '@arkiv/ui/client';
import { formatDate } from '@arkiv/shared/format';
import { ActionButton, ActionForm } from '@/components/actions';
import { workspacePage } from '@/lib/tenant';

export const metadata: Metadata = { title: 'Product · Arkiv' };

const LABEL: Record<string, string> = { name: 'Name', brand: 'Brand', size: 'Size', price: 'Price', compare_at_price: 'Compare-at price', category: 'Category', texture: 'Texture', ingredients: 'Ingredients', sku_code: 'SKU', gtin: 'GTIN', description: 'Description' };
/** Where a value that disagrees with the merchant's correction came from. */
const SOURCE_WORDS: Record<string, string> = { shopify: 'Shopify', product_page: 'Your product page', json_ld: 'Your product page', photo_ocr: 'The label', import: 'Your import' };
/** Files the customer uploaded (deleteAsset refuses generated work). */
const DELETABLE_KINDS = new Set(['product_photo', 'reference_view', 'creator_footage', 'evidence_doc', 'brand_logo', 'historical_creative']);
const TABS = ['facts', 'look', 'language', 'assets', 'history'] as const;

/** A4 Product Brain: facts with provenance, visual fingerprint, customer language, assets, imported history. */
export default async function Product({ params, searchParams }: { params: Promise<{ slug: string; skuId: string }>; searchParams: Promise<{ tab?: string }> }) {
  const { slug, skuId } = await params;
  const tab = (TABS as readonly string[]).includes((await searchParams).tab ?? '') ? (await searchParams).tab! : 'facts';
  if (!/^[0-9a-f-]{36}$/i.test(skuId)) notFound();
  const w = await workspacePage(slug);
  const d = await withTenant(w.ctx.workspaceId, async (tx) => {
    const [sku] = await tx`select * from skus where id = ${skuId}`;
    if (!sku) return null;
    const facts = await currentFacts(tx, skuId);
    const [fp] = await tx`select * from visual_fingerprints where sku_id = ${skuId} and active`;
    const fps = await tx`select version, created_at from visual_fingerprints where sku_id = ${skuId} order by version desc`;
    const themes = await tx`select * from customer_themes where sku_id = ${skuId} order by prevalence * relevance desc limit 20`;
    const signals = await tx`select count(*)::int as n from customer_signals where sku_id = ${skuId}`;
    const assets = await tx`select id, kind, mime, created_at, source from assets where sku_id = ${skuId} and deleted_at is null and kind in ('product_photo','cutout','reference_view','final_export','creator_footage') order by created_at desc limit 48`;
    const imported = await tx`select id, genome, platform_refs, created_at, source_deleted_at from creatives where sku_id = ${skuId} and origin = 'imported' order by created_at desc limit 20`;
    return {
      sku,
      facts,
      fp,
      fps,
      themes,
      signalCount: signals[0]!.n as number,
      cutout: fp?.cutout_asset_id ? await assetUrl(tx, fp.cutout_asset_id as string) : null,
      assets: await Promise.all(assets.map(async (a) => ({ id: a.id as string, kind: a.kind as string, mime: a.mime as string, created_at: a.created_at as string, url: String(a.mime).startsWith('image/') ? await assetUrl(tx, a.id as string) : null }))),
      imported,
    };
  });
  if (!d) notFound();
  const canEdit = ['OWNER', 'ADMIN', 'MEMBER'].includes(w.ctx.role);
  return (
    <>
      <p className="ak-index"><Link href={`/w/${slug}/products`}>Products</Link> / No. {String(d.sku.catalogue_no).padStart(3, '0')}</p>
      <div className="ak-between" style={{ flexWrap: 'wrap', gap: 12 }}>
        <h1 className="ak-h1" style={{ margin: 0 }}>{d.sku.name as string}</h1>
        <div className="ak-row">
          <Link className="ak-btn ak-btn--secondary" href={`/w/${slug}/products/${skuId}/claims`}>Claims</Link>
          <Link className="ak-btn ak-btn--secondary" href={`/w/${slug}/products/${skuId}/review`}>Review</Link>
          <Link className="ak-btn ak-btn--secondary" href={`/w/${slug}/map?sku=${skuId}`}>Map</Link>
        </div>
      </div>
      {d.sku.in_stock === false ? (
        <div className="ak-banner ak-banner--warn" role="status" style={{ marginTop: 16 }}>
          <p style={{ margin: 0 }}>
            <strong>Out of stock at your store.</strong>{' '}
            {d.sku.stock_intent
              ? `Ads for it are made for your ${d.sku.stock_intent === 'waitlist' ? 'waitlist' : 'launch'}: they build interest, never “buy now”.`
              : 'An ad can’t sell it right now, so production and recommendations wait. If the ad is for a waitlist or a relaunch, say so.'}
          </p>
          {canEdit ? (
            <div className="ak-row" style={{ marginTop: 8 }}>
              {d.sku.stock_intent !== 'waitlist' ? <ActionButton slug={slug} action="stock-intent" body={{ skuId, intent: 'waitlist' }} size="sm">It’s for a waitlist</ActionButton> : null}
              {d.sku.stock_intent !== 'launch' ? <ActionButton slug={slug} action="stock-intent" body={{ skuId, intent: 'launch' }} size="sm">It’s for a launch</ActionButton> : null}
              {d.sku.stock_intent ? <ActionButton slug={slug} action="stock-intent" body={{ skuId, intent: null }} size="sm">Hold ads until restocked</ActionButton> : null}
            </div>
          ) : null}
        </div>
      ) : null}
      <nav className="ak-row" style={{ margin: '24px 0', borderBottom: '1px solid var(--rule)' }} aria-label="Product sections">
        {TABS.map((t) => (
          <Link key={t} href={`?tab=${t}`} aria-current={t === tab ? 'page' : undefined} className="ak-textbtn" style={{ paddingBottom: 8, borderBottom: t === tab ? '1px solid var(--ink)' : '1px solid transparent' }}>
            {{ facts: 'Facts', look: 'Packaging', language: 'Customer language', assets: 'Assets', history: 'Past ads' }[t]}
          </Link>
        ))}
      </nav>

      {tab === 'facts' ? (
        <div className="ak-grid-2" style={{ alignItems: 'start' }}>
          <MetadataTable
            rows={Object.entries(d.facts).map(([k, f]) => ({
              key: k,
              label: LABEL[k] ?? k.replace(/_/g, ' '),
              value: (
                <span>
                  {f.value.valueText ? (f.value.valueText.length > 240 ? `${f.value.valueText.slice(0, 240)}…` : f.value.valueText) : f.value.valueNumber != null ? String(f.value.valueNumber) : JSON.stringify(f.value.valueJson)}
                  {f.disputed ? <span className="ak-small ak-muted" style={{ display: 'block' }}>Disputed: {f.candidates.map((c) => `${c.valueText ?? c.valueNumber} (${c.sourceType})`).join(' vs ')}</span> : null}
                  {f.sourceConflict ? (
                    <span className="ak-small ak-muted" style={{ display: 'block' }}>
                      {SOURCE_WORDS[f.sourceConflict.fact.sourceType] ?? f.sourceConflict.fact.sourceType} {f.sourceConflict.newer ? 'now says' : 'says'} “{f.sourceConflict.fact.valueText ?? f.sourceConflict.fact.valueNumber}”
                      {' '}({formatDate(f.sourceConflict.fact.observedAt)}).
                      {canEdit ? (
                        <span className="ak-row" style={{ gap: 8, marginTop: 4 }}>
                          {f.sourceConflict.newer ? (
                            <ActionButton slug={slug} action="fact" variant="text" body={{ skuId, key: k, value: f.value.valueText ?? String(f.value.valueNumber ?? '') }}>Keep yours</ActionButton>
                          ) : null}
                          <ActionButton slug={slug} action="fact-accept-source" variant="text" body={{ skuId, factId: f.sourceConflict.fact.id }}>Use store value</ActionButton>
                        </span>
                      ) : null}
                    </span>
                  ) : null}
                </span>
              ),
              chip: <ProvenanceChip state={f.value.state as 'OBSERVED' | 'INFERRED' | 'DECIDED'} source={f.value.sourceType} at={f.value.observedAt} />,
            }))}
          />
          {canEdit ? (
            <div className="ak-stack">
            {!verifiedIngredients(d.facts).verified ? (
              <div className="ak-panel" id="ingredients">
                <h2 className="ak-label">Add your ingredient list to unlock ingredient tests</h2>
                <p className="ak-small ak-muted">We only use ingredients from your page, label or your own entry — never guessed from the category. Until then we won’t suggest ingredient-led ads.</p>
                <ActionForm slug={slug} action="fact" extra={{ skuId, key: 'ingredients' }} submit="Save ingredients" fields={[{ name: 'value', label: 'Ingredients', type: 'textarea', required: true, max: 2000 }]} />
              </div>
            ) : null}
            {((d.sku.analysis as { missingEvidence?: string[] } | null)?.missingEvidence ?? []).length ? (
              <div className="ak-panel">
                <h2 className="ak-label">What would make these ads stronger</h2>
                <ul className="ak-small" style={{ margin: 0 }}>{((d.sku.analysis as { missingEvidence: string[] }).missingEvidence).slice(0, 6).map((m) => <li key={m}>{m}</li>)}</ul>
              </div>
            ) : null}
            <div className="ak-panel">
              <h2 className="ak-label">Correct a fact</h2>
              <p className="ak-small ak-muted">Your value becomes the decided truth and wins over page and photo readings. If your store says something different, we keep showing it next to your value so you can switch back.</p>
              <ActionForm slug={slug} action="fact" extra={{ skuId }} submit="Save" fields={[{ name: 'key', label: 'Field', type: 'select', options: Object.entries(LABEL).map(([value, label]) => ({ value, label })) }, { name: 'value', label: 'Value', type: 'textarea', required: true, max: 2000 }]} />
            </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {tab === 'look' ? (
        d.fp ? (
          <div className="ak-grid-2" style={{ alignItems: 'start' }}>
            <SpecimenCard
              index={`No. ${String(d.sku.catalogue_no).padStart(3, '0')}`}
              title={d.sku.name as string}
              meta={[['Fingerprint', `v${d.fp.version as number}`], ['Package', String(d.fp.package_type ?? '—')]]}
              image={d.cutout ? { src: d.cutout, alt: `${d.sku.name as string} product cutout` } : null}
            />
            <MetadataTable rows={[
              { label: 'Package', value: String(d.fp.package_type ?? '—') },
              { label: 'Closure', value: String(d.fp.closure ?? '—') },
              { label: 'Label text', value: String(d.fp.label_text ?? '—') },
              { label: 'Colours', value: <span className="ak-row">{(d.fp.dominant_colors as string[]).map((c) => <span key={c} title={c} style={{ width: 18, height: 18, background: c, border: '1px solid var(--rule)', display: 'inline-block' }} />)}</span> },
              { label: 'Versions', value: d.fps.map((f) => `v${f.version} · ${formatDate(f.created_at as string)}`).join(', ') },
            ]} />
          </div>
        ) : <p className="ak-muted">No packaging fingerprint yet — add a clear product photo.</p>
      ) : null}

      {tab === 'language' ? (
        <div className="ak-grid-2" style={{ alignItems: 'start' }}>
          <div>
            <p className="ak-small ak-muted">{d.signalCount} customer comments imported. Themes guide hooks and angles; customer words are never turned into product claims.</p>
            {d.themes.length === 0 ? <p className="ak-muted">No themes yet.</p> : d.themes.map((t) => (
              <div key={t.id as string} className="ak-index-row">
                <span>{t.label as string}<span className="ak-small ak-muted" style={{ display: 'block' }}>
                  {t.signal_type as string} · {t.trend as string}
                  {t.sentiment != null ? ` · ${Number(t.sentiment) > 0.2 ? 'positive' : Number(t.sentiment) < -0.2 ? 'negative' : 'mixed'}` : ''}
                  {Number(t.relevance) < 0.5 ? ' · mostly not about the product' : ''}
                </span></span>
                <span className="ak-index" title="Recency-weighted share of comments · comments in this theme">{Math.round(Number(t.prevalence) * 100)}% · n={t.sample_size as number}</span>
              </div>
            ))}
          </div>
          {canEdit ? (
            <div className="ak-panel">
              <h2 className="ak-label">Import reviews</h2>
              <ActionForm slug={slug} action="reviews" extra={{ skuId }} submit="Import" fields={[{ name: 'text', label: 'Paste reviews (one per line or a CSV export)', type: 'textarea', required: true, hint: 'We keep only the review text, rating and date. Reviewer names are hashed, other columns are dropped, and emails, phone numbers and addresses in the text are removed.' }]} />
            </div>
          ) : null}
        </div>
      ) : null}

      {tab === 'assets' ? (
        <div className="ak-grid-3">
          {d.assets.map((a) => (
            <figure key={a.id as string} className="ak-frame" style={{ margin: 0 }}>
              <div className="ak-well" style={{ aspectRatio: '1' }}>{a.url ? <img src={a.url} alt={String(a.kind)} style={{ objectFit: 'contain', width: '100%', height: '100%' }} /> : <span className="ak-index">{String(a.mime)}</span>}</div>
              <figcaption className="ak-index">{String(a.kind).replace(/_/g, ' ')} · {formatDate(a.created_at as string)}</figcaption>
              {canEdit && DELETABLE_KINDS.has(a.kind) ? (
                <ActionButton slug={slug} action="asset-delete" variant="text" danger body={{ assetId: a.id }} confirm="Delete this file? It disappears from Arkiv. Evidence behind an approved claim and delivered ads are kept for our records.">Delete</ActionButton>
              ) : null}
            </figure>
          ))}
        </div>
      ) : null}

      {tab === 'history' ? (
        <div className="ak-grid-2" style={{ alignItems: 'start' }}>
          <div>
            {d.imported.length === 0 ? <p className="ak-muted">Import past ads so recommendations start from what you’ve already tried.</p> : d.imported.map((c) => {
              const g = (c.genome ?? {}) as { angle?: string; hookMechanism?: string; treatment?: string };
              return <div key={c.id as string} className="ak-index-row"><span>{String((c.platform_refs as { copy?: string }).copy ?? '').slice(0, 90)}</span><span className="ak-index">{g.angle ? `${g.angle} · ${g.hookMechanism}` : 'analysing…'}{c.source_deleted_at ? ' · Deleted on platform' : ''}</span></div>;
            })}
          </div>
          {canEdit ? (
            <div className="ak-panel">
              <h2 className="ak-label">Import a past ad</h2>
              <ActionForm slug={slug} action="import-creative" multipart extra={{ skuId }} submit="Import" fields={[
                { name: 'copy', label: 'Ad copy / script', type: 'textarea', required: true },
                { name: 'file', label: 'Video (optional)', type: 'file', accept: 'video/mp4,video/quicktime' },
                { name: 'platform', label: 'Platform', type: 'select', options: [{ value: '', label: '—' }, { value: 'meta', label: 'Meta' }, { value: 'tiktok', label: 'TikTok' }] },
                { name: 'adId', label: 'Ad ID (optional)' },
              ]} />
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
