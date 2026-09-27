import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { withTenant } from '@arkiv/db';
import { assetUrl, currentFacts, freshness, isPartFactKey, verifiedIngredients } from '@arkiv/core';
import { formatUsd } from '@arkiv/shared';
import { MetadataTable, SpecimenCard } from '@arkiv/ui';
import { ProvenanceChip } from '@arkiv/ui/client';
import { formatDate } from '@arkiv/shared/format';
import { ActionButton, ActionForm } from '@/components/actions';
import { disputeChoices } from '@/lib/flow-helpers';
import { rightsStatus, yesNo } from '@/lib/product-view';
import { skuTitle } from '@/lib/page-title';
import { denyPage, workspacePage } from '@/lib/tenant';

export async function generateMetadata({ params }: { params: Promise<{ slug: string; skuId: string }> }): Promise<Metadata> {
  const { slug, skuId } = await params;
  return skuTitle(slug, skuId, 'Product');
}

const LABEL: Record<string, string> = { name: 'Name', brand: 'Brand', size: 'Size', price: 'Price', compare_at_price: 'Compare-at price', category: 'Category', key_ingredients: 'Key ingredients', ingredients: 'Ingredients (INCI)', texture: 'Texture', format: 'Format', sku_code: 'SKU', gtin: 'GTIN', description: 'Description', usage_directions: 'How to use' };
/** Read-only facts that are shown but never corrected from the fact form (store/structured signals). */
const INFO_LABEL: Record<string, string> = { product_type: 'Store category', subscription_available: 'Subscription', bundle_eligible: 'Bundles', tags: 'Store tags' };
const VIEW_WORDS: Record<string, string> = { front: 'Front', side: 'Side', back: 'Back', closure: 'Closure', swatch: 'Swatch', in_hand: 'In hand', other: 'Other' };
const REASON_WORDS: Record<string, string> = { analysis: 'analysed', added_views: 'views added', segmented_cutout: 'cleaner cut-out', packaging_refresh: 'packaging refresh', views_approved: 'views approved', merged: 'merged import' };
/** Where a value that disagrees with the merchant's correction came from. */
const SOURCE_WORDS: Record<string, string> = { shopify: 'Shopify', product_page: 'Your product page', json_ld: 'Your product page', photo_ocr: 'The label', import: 'Your import' };
/** Files the customer uploaded (deleteAsset refuses generated work). */
const DELETABLE_KINDS = new Set(['product_photo', 'reference_view', 'creator_footage', 'evidence_doc', 'brand_logo', 'historical_creative']);
const TABS = ['facts', 'offer', 'look', 'language', 'assets', 'history', 'sources'] as const;
const TAB_LABEL: Record<(typeof TABS)[number], string> = { facts: 'Facts', offer: 'Offer', look: 'Packaging', language: 'Customer language', assets: 'Assets', history: 'Past ads', sources: 'Sources' };
const PLATFORM_NAME: Record<string, string> = { meta: 'Meta', tiktok: 'TikTok', shopify: 'Shopify', manual: 'Uploaded CSV' };
/** A fact's value as text (number, text or JSON). */
const factText = (f: { valueText: string | null; valueNumber: number | null; valueJson: unknown } | undefined) =>
  !f ? null : f.valueText ?? (f.valueNumber != null ? String(f.valueNumber) : f.valueJson != null ? JSON.stringify(f.valueJson) : null);
const money = (n: number | null | undefined) => (n == null ? '—' : formatUsd(Number(n), 2));

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
    const fps = await tx`select version, created_at, reason from visual_fingerprints where sku_id = ${skuId} order by version desc`;
    const brands = await tx`select id, name from brands order by created_at`;
    // §16 reference views with the view each shows and whether the merchant approved it; the label crop.
    const refIds = ((fp?.reference_asset_ids as string[] | undefined) ?? []);
    const refs = refIds.length ? await tx`select id, review_status from assets where id = any(${refIds}::uuid[]) and deleted_at is null` : [];
    const views = await Promise.all(
      refIds.filter((id) => refs.some((r) => r.id === id)).map(async (id) => ({
        id,
        view: ((fp?.views as Record<string, string> | undefined) ?? {})[id] ?? null,
        approved: ((fp?.approved_view_ids as string[] | undefined) ?? []).includes(id),
        pending: refs.find((r) => r.id === id)?.review_status === 'pending',
        url: await assetUrl(tx, id),
      })),
    );
    const labelCrop = fp?.label_crop_asset_id ? await assetUrl(tx, fp.label_crop_asset_id as string) : null;
    const themes = await tx`select * from customer_themes where sku_id = ${skuId} order by prevalence * relevance desc limit 20`;
    // A few customer words per theme (already stripped of personal data on import), newest first.
    const snippetIds = [...new Set(themes.flatMap((t) => ((t.snippet_ids as string[] | null) ?? []).slice(0, 3)))];
    const snippetRows = snippetIds.length ? await tx`select id, text from customer_signals where id = any(${snippetIds}::uuid[]) and sku_id = ${skuId}` : [];
    const snippets = new Map(snippetRows.map((r) => [r.id as string, String(r.text)]));
    const signals = await tx`select count(*)::int as n from customer_signals where sku_id = ${skuId}`;
    const assets = await tx`select id, kind, mime, created_at, source, rights_expires_at <= now() as rights_expired, review_status, rights_attested_at, rights_expires_at, rights_frozen_at from assets where sku_id = ${skuId} and deleted_at is null and kind in ('product_photo','cutout','reference_view','final_export','creator_footage','historical_creative') order by created_at desc limit 48`;
    const imported = await tx`select c.id, c.genome, c.platform_refs, c.secondary_sku_ids, c.created_at, c.source_deleted_at,
                                   exists (select 1 from assets a where a.id = any(c.final_asset_ids) and a.rights_expires_at <= now()) as rights_expired
                            from creatives c where c.sku_id = ${skuId} and c.origin = 'imported' order by c.created_at desc limit 20`;
    const otherSkus = await tx`select id, name from skus where id <> ${skuId} and status <> 'archived' order by catalogue_no limit 50`;
    // Offer context (plan 03 A4): the store's variants with their prices.
    const variants = await tx`select title, size, shade, price_micros, compare_at_micros, currency, available from sku_variants where sku_id = ${skuId} order by title limit 50`;
    // Sources: connected accounts, and the ad accounts whose ads are this product's variants or imported creatives.
    const integrations = await tx`select provider, display_name, external_account_id, status from integrations where status <> 'disconnected' order by provider`;
    const adAccounts = await tx`select po.platform, po.account_id, count(distinct po.ad_id)::int as ads, max(po.date) as last_date
                                from performance_observations po
                                where po.superseded_at is null
                                  and (po.variant_id in (select v.id from variants v join experiments e on e.id = v.experiment_id and e.workspace_id = v.workspace_id where e.sku_id = ${skuId})
                                       or po.creative_id in (select c.id from creatives c where c.sku_id = ${skuId}))
                                group by po.platform, po.account_id order by ads desc limit 20`;
    return {
      sku,
      facts,
      fp,
      fps,
      brands: brands.map((b) => ({ value: b.id as string, label: b.name as string })),
      views,
      labelCrop,
      themes,
      signalCount: signals[0]!.n as number,
      cutout: fp?.cutout_asset_id ? await assetUrl(tx, fp.cutout_asset_id as string) : null,
      assets: await Promise.all(assets.map(async (a) => ({
        id: a.id as string,
        kind: a.kind as string,
        mime: a.mime as string,
        created_at: a.created_at as string,
        rightsExpired: !!a.rights_expired,
        rights: rightsStatus({ kind: a.kind as string, source: a.source as string, rightsAttestedAt: a.rights_attested_at as string | null, rightsExpiresAt: a.rights_expires_at as string | null, rightsFrozenAt: a.rights_frozen_at as string | null }),
        reviewStatus: (a.review_status as string | null) ?? null,
        url: String(a.mime).startsWith('image/') ? await assetUrl(tx, a.id as string) : null,
      }))),
      snippets,
      variants,
      integrations,
      adAccounts,
      fresh: await freshness(tx),
      imported,
      otherSkus: otherSkus.map((s) => ({ value: s.id as string, label: s.name as string })),
    };
  });
  if (!d) return denyPage('sku', skuId, w);
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
            {TAB_LABEL[t]}
          </Link>
        ))}
      </nav>

      {tab === 'facts' ? (
        <div className="ak-grid-2" style={{ alignItems: 'start' }}>
          <MetadataTable
            rows={Object.entries(d.facts).filter(([k]) => !isPartFactKey(k) && !['tags', 'properties', 'source_snapshot', 'images', 'options', 'variants'].includes(k)).map(([k, f]) => ({
              key: k,
              label: LABEL[k] ?? INFO_LABEL[k] ?? k.replace(/_/g, ' '),
              value: (
                <span>
                  {f.value.valueText ? (f.value.valueText.length > 240 ? `${f.value.valueText.slice(0, 240)}…` : f.value.valueText) : f.value.valueNumber != null ? String(f.value.valueNumber) : JSON.stringify(f.value.valueJson)}
                  {f.disputed ? (
                    <span className="ak-small ak-muted" style={{ display: 'block' }}>
                      Your sources disagree. Which is right?
                      {canEdit ? (
                        <span className="ak-row" style={{ gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
                          {disputeChoices(k, f.candidates.map((c) => ({ value: c.valueText ?? String(c.valueNumber ?? ''), source: c.sourceType }))).map((c) => (
                            <ActionButton key={c.value} slug={slug} action="fact" size="sm" variant="secondary" body={{ skuId, key: k, value: c.value }}>{c.label}</ActionButton>
                          ))}
                        </span>
                      ) : (
                        <> {f.candidates.map((c) => `${c.valueText ?? c.valueNumber} (${c.sourceType})`).join(' vs ')}</>
                      )}
                    </span>
                  ) : null}
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
            {d.brands.length > 1 ? (
              <div className="ak-panel">
                <h2 className="ak-label">Brand</h2>
                <p className="ak-small ak-muted">The Brand Brain this product’s ads follow. Its brand-wide claims are added to this product for your approval.</p>
                <ActionForm slug={slug} action="sku-brand" extra={{ skuId }} submit="Save brand" fields={[{ name: 'brandId', label: 'Brand', type: 'select', defaultValue: (d.sku.brand_id as string | null) ?? d.brands[0]!.value, options: d.brands }]} />
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

      {tab === 'offer' ? (
        // Plan 03 A4 "Offer context (price, bundles, subscription availability)".
        <div className="ak-grid-2" style={{ alignItems: 'start' }}>
          <div className="ak-stack">
            <MetadataTable rows={[
              { label: 'Price', value: factText(d.facts.price?.value) ?? '—', chip: d.facts.price ? <ProvenanceChip state={d.facts.price.value.state as 'OBSERVED' | 'INFERRED' | 'DECIDED'} source={d.facts.price.value.sourceType} at={d.facts.price.value.observedAt} /> : undefined },
              { label: 'Compare-at price', value: factText(d.facts.compare_at_price?.value) ?? '—' },
              { label: 'Subscription', value: yesNo(d.facts.subscription_available?.value) == null ? 'Not known' : yesNo(d.facts.subscription_available?.value) ? 'Available' : 'Not offered' },
              { label: 'Bundles', value: yesNo(d.facts.bundle_eligible?.value) == null ? 'Not known' : yesNo(d.facts.bundle_eligible?.value) ? 'Sold in bundles' : 'Not in bundles' },
            ]} />
            {d.variants.length ? (
              <div className="ak-scroll-x">
                <table className="ak-table">
                  <caption className="ak-label" style={{ textAlign: 'left' }}>Variants at your store</caption>
                  <thead><tr><th>Variant</th><th>Size / shade</th><th>Price</th><th>Compare-at</th><th>In stock</th></tr></thead>
                  <tbody>
                    {d.variants.map((v, i) => (
                      <tr key={i}>
                        <td>{v.title as string}</td>
                        <td>{[v.size, v.shade].filter(Boolean).join(' · ') || '—'}</td>
                        <td className="ak-mono">{money(v.price_micros as number | null)}</td>
                        <td className="ak-mono">{money(v.compare_at_micros as number | null)}</td>
                        <td>{v.available == null ? '—' : v.available ? 'Yes' : 'No'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <p className="ak-small ak-muted">No variants imported. Connect Shopify to bring in sizes, shades and prices.</p>}
          </div>
          {canEdit ? (
            <div className="ak-panel">
              <h2 className="ak-label">Correct the offer</h2>
              <p className="ak-small ak-muted">Ads only mention a subscription or bundle you actually sell.</p>
              <ActionForm slug={slug} action="fact" extra={{ skuId, key: 'subscription_available' }} submit="Save subscription" fields={[{ name: 'value', label: 'Subscribe & save', type: 'select', defaultValue: yesNo(d.facts.subscription_available?.value) ? 'yes' : 'no', options: [{ value: 'yes', label: 'Available' }, { value: 'no', label: 'Not offered' }] }]} />
              <ActionForm slug={slug} action="fact" extra={{ skuId, key: 'bundle_eligible' }} submit="Save bundles" fields={[{ name: 'value', label: 'Bundles', type: 'select', defaultValue: yesNo(d.facts.bundle_eligible?.value) ? 'yes' : 'no', options: [{ value: 'yes', label: 'Sold in bundles' }, { value: 'no', label: 'Not in bundles' }] }]} />
              <ActionForm slug={slug} action="fact" extra={{ skuId, key: 'price' }} submit="Save price" fields={[{ name: 'value', label: 'Price', required: true, max: 20, placeholder: '38.00', defaultValue: factText(d.facts.price?.value) ?? '' }]} />
            </div>
          ) : null}
        </div>
      ) : null}

      {tab === 'sources' ? (
        // Plan 03 A4 "Integrations (source status)": where this product's facts and results come from, and how fresh.
        <div className="ak-stack">
          <MetadataTable rows={[
            { label: 'Product page', value: d.sku.source_url ? <a href={String(d.sku.source_url)} target="_blank" rel="noreferrer noopener">{String(d.sku.source_url)}</a> : '—' },
            { label: 'Shopify product', value: d.sku.shopify_product_id ? `${String(d.sku.shopify_product_id)} · ${d.fresh.find((f) => f.provider === 'shopify')?.label ?? 'store not connected'}` : 'Not linked to a Shopify product' },
          ]} />
          {(() => {
            const disputed = Object.entries(d.facts).filter(([, f]) => f.disputed || f.sourceConflict);
            return disputed.length ? (
              <div className="ak-panel">
                <h2 className="ak-label">Where your sources disagree</h2>
                <ul className="ak-small" style={{ margin: 0, paddingLeft: 18 }}>
                  {disputed.map(([k, f]) => (
                    <li key={k}>
                      {LABEL[k] ?? k.replace(/_/g, ' ')}: {f.sourceConflict ? `${SOURCE_WORDS[f.sourceConflict.fact.sourceType] ?? f.sourceConflict.fact.sourceType} says “${f.sourceConflict.fact.valueText ?? f.sourceConflict.fact.valueNumber}”, yours is “${factText(f.value) ?? ''}”` : f.candidates.map((c) => `${SOURCE_WORDS[c.sourceType] ?? c.sourceType}: “${c.valueText ?? c.valueNumber}”`).join(' vs ')}
                    </li>
                  ))}
                </ul>
                <p className="ak-small"><Link href="?tab=facts">Resolve in Facts</Link></p>
              </div>
            ) : <p className="ak-small ak-muted">Your sources agree on every fact.</p>;
          })()}
          <div className="ak-panel">
            <h2 className="ak-label">Ad accounts with results for this product</h2>
            {d.adAccounts.length ? d.adAccounts.map((a) => {
              const conn = d.integrations.find((i) => i.provider === a.platform && i.external_account_id === a.account_id);
              return (
                <div key={`${a.platform}:${a.account_id}`} className="ak-index-row">
                  <span>{PLATFORM_NAME[a.platform as string] ?? String(a.platform)} · {(conn?.display_name as string | undefined) ?? String(a.account_id)}</span>
                  <span className="ak-index">{a.ads as number} ad{a.ads === 1 ? '' : 's'} · last data {formatDate(a.last_date as string)}{a.platform === 'manual' ? '' : conn ? ` · ${d.fresh.find((f) => f.provider === a.platform)?.label ?? String(conn.status)}` : ' · not connected'}</span>
                </div>
              );
            }) : <p className="ak-small ak-muted">No ad results for this product yet. Launch its ads with the variant codes in their names, or upload a CSV from Results.</p>}
            <p className="ak-small"><Link href={`/w/${slug}/settings/integrations`}>Manage connections</Link></p>
          </div>
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
            <div className="ak-stack">
              <MetadataTable rows={[
                { label: 'Package', value: String(d.fp.package_type ?? '—') },
                { label: 'Closure', value: String(d.fp.closure ?? '—') },
                { label: 'Shape', value: (() => {
                  const g = (d.fp.geometry ?? {}) as { silhouette?: string; aspectRatio?: number | null; measuredAspectRatio?: number };
                  const ratio = g.measuredAspectRatio ?? g.aspectRatio;
                  return g.silhouette || ratio ? `${g.silhouette ?? ''}${ratio ? ` · ${ratio}× taller than wide` : ''}`.replace(/^ · /, '') : '—';
                })() },
                { label: 'Label text', value: String(d.fp.label_text ?? '—') },
                { label: 'Label crop', value: d.labelCrop ? <img src={d.labelCrop} alt="The label, cropped from your photo" style={{ maxWidth: 220, maxHeight: 120, objectFit: 'contain' }} /> : '—' },
                { label: 'Product colour', value: String(d.fp.liquid_color ?? '—') },
                { label: 'Colours', value: <span className="ak-row">{(d.fp.dominant_colors as string[]).map((c) => <span key={c} title={c} style={{ width: 18, height: 18, background: c, border: '1px solid var(--rule)', display: 'inline-block' }} />)}</span> },
                { label: 'Versions', value: d.fps.map((f) => `v${f.version} · ${formatDate(f.created_at as string)}${f.reason ? ` (${REASON_WORDS[f.reason as string] ?? String(f.reason)})` : ''}`).join(', ') },
              ]} />
              {d.views.length ? (
                <div className="ak-panel">
                  <h2 className="ak-label">Reference views</h2>
                  <div className="ak-grid-3">
                    {d.views.map((v) => (
                      <figure key={v.id} className="ak-frame" style={{ margin: 0 }}>
                        <div className="ak-well" style={{ aspectRatio: '1' }}><img src={v.url} alt={`${VIEW_WORDS[v.view ?? 'other'] ?? 'Reference'} view`} style={{ objectFit: 'contain', width: '100%', height: '100%' }} /></div>
                        <figcaption className="ak-index">{VIEW_WORDS[v.view ?? ''] ?? 'View'}{v.approved ? ' · approved' : ''}{v.pending ? ' · waiting for review' : ''}</figcaption>
                      </figure>
                    ))}
                  </div>
                  {canEdit ? (
                    <ActionForm slug={slug} action="approve-views" extra={{ skuId }} submit="Save approved views" fields={[{
                      name: 'assetIds',
                      label: 'These photos show the product as it is sold today',
                      type: 'checkboxes',
                      options: d.views.filter((v) => !v.pending).map((v, i) => ({ value: v.id, label: `${VIEW_WORDS[v.view ?? ''] ?? 'View'} ${i + 1}` })),
                      checked: d.views.filter((v) => v.approved).map((v) => v.id),
                      hint: 'Approved views are what every ad is checked against.',
                    }]} />
                  ) : null}
                </div>
              ) : null}
              {canEdit ? (
                <div className="ak-panel">
                  <h2 className="ak-label">New packaging?</h2>
                  <p className="ak-small ak-muted">Add a photo of the new pack. Ads you’ve already made keep the packaging they were made with; new ones use this.</p>
                  <ActionForm slug={slug} action="packaging-refresh" multipart extra={{ skuId }} submit="Update packaging" fields={[
                    { name: 'file', label: 'Photo of the new packaging (front)', type: 'file', accept: 'image/*', required: true },
                    { name: 'labelText', label: 'What the new label says (if it changed)', type: 'textarea', max: 400 },
                    { name: 'note', label: 'What changed (optional)', max: 200 },
                  ]} />
                </div>
              ) : null}
            </div>
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
                </span>
                {((t.snippet_ids as string[] | null) ?? []).slice(0, 3).map((id) => d.snippets.get(id)).filter(Boolean).map((q, i) => (
                  <q key={i} className="ak-small" style={{ display: 'block', marginTop: 4 }}>{q!.length > 160 ? `${q!.slice(0, 160)}…` : q}</q>
                ))}
                </span>
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
              <figcaption className="ak-index">
                {String(a.kind).replace(/_/g, ' ')} · {formatDate(a.created_at as string)}
                {/* §40/§48: uploaded footage shows its rights status; expired rights keep history and results only. */}
                {a.rights.label ? (a.rights.state === 'attested' ? ` · ${a.rights.label}` : <strong> · {a.rights.label}</strong>) : null}
                {a.reviewStatus === 'pending' ? ' · Waiting for compliance review' : a.reviewStatus === 'rejected' ? ' · Not approved for use' : null}
              </figcaption>
              {canEdit && a.rights.state === 'missing' ? (
                <ActionButton slug={slug} action="asset-attest" body={{ assetId: a.id }} variant="text" confirm="I own this footage, or have written permission from whoever made it and everyone who appears in it, to use and edit it in ads for this brand.">Attest rights</ActionButton>
              ) : null}
              {canEdit && a.rightsExpired ? (
                <ActionForm slug={slug} action="asset-replace" multipart extra={{ assetId: a.id }} submit="Replace footage" fields={[{ name: 'file', label: 'Replacement file', type: 'file', accept: a.kind.includes('footage') || a.kind === 'historical_creative' ? 'video/mp4,video/quicktime' : 'image/*', required: true }]} />
              ) : null}
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
              return <div key={c.id as string} className="ak-index-row"><span>{String((c.platform_refs as { copy?: string }).copy ?? '').slice(0, 90)}</span><span className="ak-index">{g.angle ? `${g.angle} · ${g.hookMechanism}` : 'analysing…'}{c.source_deleted_at ? ' · Deleted on platform' : ''}{(c.secondary_sku_ids as string[] | null)?.length ? ` · also shows ${(c.secondary_sku_ids as string[]).length} other product${(c.secondary_sku_ids as string[]).length === 1 ? '' : 's'}` : ''}{(c.platform_refs as { minorsDeclared?: boolean }).minorsDeclared ? ' · under-18 review' : ''}{c.rights_expired ? ' · Rights expired: results kept, not reused' : ''}</span></div>;
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
                { name: 'creatorHandle', label: 'Creator (optional)', placeholder: '@handle', max: 80, hint: 'Who made the footage, if it is creator or customer content.' },
                { name: 'sourceUrl', label: 'Original post (optional)', placeholder: 'https://…', max: 500 },
                ...(d.otherSkus.length ? [{ name: 'secondarySkuIds', label: 'Other products shown in this ad', type: 'checkboxes' as const, options: d.otherSkus, checked: [], hint: 'Results and learnings stay with this product.' }] : []),
                { name: 'minors', label: 'People in this ad', type: 'checkboxes', options: [{ value: 'yes', label: 'Someone under 18 appears' }], checked: [], hint: 'We check rights and platform policy before this footage can be used.' },
                {
                  name: 'beforeAfter',
                  label: 'Before/after footage',
                  type: 'checkboxes',
                  checked: [],
                  hint: 'Before/after is reviewed by our compliance team before any ad uses it. We never generate before/after results.',
                  options: [
                    { value: 'before_after', label: 'This video shows a before/after comparison' },
                    { value: 'consent', label: 'The person shown gave written permission for ads' },
                    { value: 'unretouched', label: 'The images are unretouched' },
                    { value: 'same_conditions', label: 'Before and after were taken under the same lighting, angle and conditions' },
                  ],
                },
                {
                  name: 'rights',
                  label: 'Rights',
                  type: 'checkboxes',
                  checked: [],
                  hint: 'Required when you add a video. We keep this confirmation with the file.',
                  options: [{ value: 'attested', label: 'I own this footage, or have written permission from whoever made it and everyone who appears in it, to use and edit it in ads for this brand' }],
                },
              ]} />
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
