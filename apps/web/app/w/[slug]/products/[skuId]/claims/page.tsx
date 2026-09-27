import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { withTenant } from '@arkiv/db';
import { assetUrl, claimHistory, claimMarket, listClaims, listMembers } from '@arkiv/core';
import { formatDate } from '@arkiv/shared/format';
import { ClaimChip } from '@arkiv/ui';
import { ActionForm, SheetButton } from '@/components/actions';
import { suggestedWording } from '@/lib/claim-alternative';
import { addBusinessDays, CLAIM_CHANGE_WORDS, claimActorLabel, COMPLIANCE_REVIEW_BUSINESS_DAYS, marketName } from '@/lib/claims-view';
import { skuTitle } from '@/lib/page-title';
import { denyPage, workspacePage } from '@/lib/tenant';

export async function generateMetadata({ params }: { params: Promise<{ slug: string; skuId: string }> }): Promise<Metadata> {
  const { slug, skuId } = await params;
  return skuTitle(slug, skuId, 'Claims');
}

/** Stored as canonical platform codes; META covers Instagram Reels + Facebook/Instagram feed. */
const CLAIM_PLATFORM_OPTIONS = [
  { value: 'TIKTOK', label: 'TikTok' },
  { value: 'META', label: 'Meta (Reels + Feed)' },
  { value: 'YOUTUBE', label: 'YouTube' },
  { value: 'ORGANIC', label: 'Organic posts' },
];
const PLATFORM_LABEL: Record<string, string> = { TIKTOK: 'TikTok', INSTAGRAM_REELS: 'Reels', FACEBOOK_FEED: 'Feed', YOUTUBE: 'YouTube', ORGANIC: 'Organic' };

const EVIDENCE_TYPE: Record<string, string> = { clinical_study: 'Clinical study', consumer_perception: 'Consumer perception study', lab_test: 'Lab test', certificate: 'Certificate', ingredient_spec: 'Ingredient spec', other: 'Other' };
const APPLICABILITY: Record<string, string> = { product_specific: 'this product', ingredient_level: 'an ingredient', other_formulation: 'another formula' };
const STRENGTH: Record<string, string> = { weak: 'weak', moderate: 'moderate', strong: 'strong' };
/** Wordings that mean the same (case, punctuation and spacing aside). */
const sameText = (a: string, b: string) => a.toLowerCase().replace(/[^a-z0-9%]+/g, ' ').trim() === b.toLowerCase().replace(/[^a-z0-9%]+/g, ' ').trim();

const ORDER = ['MERCHANT_REVIEW_REQUIRED', 'RESTRICTED', 'VERIFIED', 'VERIFIED_WITH_QUALIFIER', 'INFERRED_ONLY', 'BLOCKED'];
const GROUP: Record<string, string> = { MERCHANT_REVIEW_REQUIRED: 'Needs your review', RESTRICTED: 'With our compliance team', VERIFIED: 'Approved', VERIFIED_WITH_QUALIFIER: 'Approved with qualifier', INFERRED_ONLY: 'Customer language (not a claim)', BLOCKED: 'Blocked' };

/** A5 Claims Vault: status groups, scope, evidence. Approval needs Owner/Admin and a market + platform scope. */
export default async function Claims({ params }: { params: Promise<{ slug: string; skuId: string }> }) {
  const { slug, skuId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(skuId)) notFound();
  const w = await workspacePage(slug);
  const d = await withTenant(w.ctx.workspaceId, async (tx) => {
    const [sku] = await tx`select name, catalogue_no from skus where id = ${skuId}`;
    if (!sku) return null;
    const claims = await listClaims(tx, skuId);
    const evRows = await tx`select id, claim_id, evidence_type, source_asset_id, source_location, applicability, evidence_strength, expiry_date, substantiated_wording, created_at
                            from claim_evidence where claim_id in ${tx(claims.length ? claims.map((c) => c.id) : ['00000000-0000-0000-0000-000000000000'])} order by created_at`;
    // Evidence documents open through short-lived signed links (A5 "evidence documents").
    const ev: (Record<string, unknown> & { url: string | null })[] = await Promise.all(
      evRows.map(async (e) => Object.assign({}, e as Record<string, unknown>, { url: e.source_asset_id ? await assetUrl(tx, e.source_asset_id as string, 600).catch(() => null) : null })),
    );
    // Each claim's decision history (every status, wording and scope it has had), with who made each change.
    const history = new Map(await Promise.all(claims.map(async (c) => [c.id, await claimHistory(tx, c.id)] as const)));
    const members = new Map((await listMembers(tx)).map((m) => [m.user_id as string, (m.name as string | null) || (m.email as string)]));
    return { sku, claims, ev, history, members, market: await claimMarket(tx, skuId) };
  });
  if (!d) return denyPage('sku', skuId, w);
  const canApprove = ['OWNER', 'ADMIN'].includes(w.ctx.role);
  const canEdit = canApprove || w.ctx.role === 'MEMBER';
  /** When a claim was sent to our compliance team: the first version of its current RESTRICTED run (history is newest first). */
  const restrictedAt = (id: string) => {
    let at: Date | null = null;
    for (const h of d.history.get(id) ?? []) {
      if (h.status !== 'RESTRICTED') break;
      at = new Date(h.at);
    }
    return at;
  };
  const groups = ORDER.map((s) => ({ s, items: d.claims.filter((c) => c.status === s) })).filter((g) => g.items.length);
  return (
    <>
      <p className="ak-index"><Link href={`/w/${slug}/products/${skuId}`}>No. {String(d.sku.catalogue_no).padStart(3, '0')} {d.sku.name as string}</Link> / Claims</p>
      <div className="ak-between" style={{ flexWrap: 'wrap', gap: 12 }}>
        <h1 className="ak-h1" style={{ margin: 0 }}>Claims</h1>
        {canEdit ? (
          <SheetButton label="Add a claim" title="Add a claim" description="We check it against FDA cosmetic rules immediately. Drug-like claims (treats, cures, repairs skin structure) are blocked with a compliant alternative.">
            <ActionForm slug={slug} action="claim-propose" extra={{ skuId }} submit="Check claim" fields={[{ name: 'wording', label: 'Claim', required: true, max: 200, placeholder: 'e.g. Skin feels hydrated for 24 hours' }]} />
          </SheetButton>
        ) : null}
      </div>
      <p className="ak-small ak-muted" style={{ maxWidth: 640 }}>Only approved claims can appear in ads, and only on the platforms and markets you choose. Evidence expiring within 14 days moves a claim back to review.</p>
      {groups.map((g) => (
        <section key={g.s} className="ak-section">
          <h2 className="ak-label">{GROUP[g.s]}</h2>
          {g.items.map((c) => {
            const ev = d.ev.filter((e) => e.claim_id === c.id);
            return (
              <div key={c.id} className="ak-card" style={{ marginBottom: 12 }}>
                <div className="ak-between" style={{ gap: 12 }}>
                  <strong>“{c.preferredWording}”{c.mandatoryQualifier ? <span className="ak-muted"> ({c.mandatoryQualifier})</span> : null}</strong>
                  <ClaimChip status={c.status} />
                </div>
                {!sameText(c.canonicalMeaning, c.preferredWording) ? <p className="ak-small ak-muted" style={{ margin: '4px 0' }}>Means: {c.canonicalMeaning}</p> : null}
                {c.blockReason ? <p className="ak-small">{c.blockReason}</p> : null}
                {c.status === 'RESTRICTED' ? (
                  // Plan 03 A5 edge / 05 §14: a RESTRICTED claim is reviewed by our compliance team within 2 business days.
                  <p className="ak-small">
                    Our compliance team will review within {COMPLIANCE_REVIEW_BUSINESS_DAYS} business days
                    {restrictedAt(c.id) ? ` (sent ${formatDate(restrictedAt(c.id)!)}, expect an answer by ${formatDate(addBusinessDays(restrictedAt(c.id)!, COMPLIANCE_REVIEW_BUSINESS_DAYS))})` : ''}.
                  </p>
                ) : null}
                {c.status === 'RESTRICTED' && c.complianceNote ? <p className="ak-small">Our compliance team: {c.complianceNote}</p> : null}
                {(c.status === 'BLOCKED' || c.status === 'RESTRICTED') && c.suggestedAlternative ? (
                  // §43 "Merchant insists on blocked claim": explain, and propose a factual / appearance-oriented wording.
                  <div className="ak-small" style={{ margin: '8px 0' }}>
                    <span className="ak-muted">Try instead:</span> {c.suggestedAlternative}
                    {canEdit ? (
                      <div style={{ marginTop: 6 }}>
                        <SheetButton variant="text" label="Use a compliant wording" title="Add a compliant wording" description={c.suggestedAlternative}>
                          <ActionForm slug={slug} action="claim-propose" extra={{ skuId }} submit="Check claim" fields={[{ name: 'wording', label: 'Claim', required: true, max: 200, defaultValue: suggestedWording(c.suggestedAlternative) ?? '' }]} />
                        </SheetButton>
                      </div>
                    ) : null}
                  </div>
                ) : null}
                <p className="ak-small ak-muted">{c.category} · {c.riskLevel} risk · {c.origin}{c.allowedPlatforms.length ? ` · ${c.allowedPlatforms.map((x) => PLATFORM_LABEL[x.toUpperCase()] ?? x).join(', ')} · ${c.allowedMarkets.join(', ')}` : ''}{ev.length ? ` · ${ev.length} evidence file${ev.length > 1 ? 's' : ''}` : ''}</p>
                {ev.length ? (
                  <details className="ak-small">
                    <summary>Evidence</summary>
                    <ul style={{ paddingLeft: 18, margin: '6px 0 0' }}>
                      {ev.map((e) => (
                        <li key={e.id as string}>
                          {EVIDENCE_TYPE[e.evidence_type as string] ?? String(e.evidence_type)}
                          {e.applicability ? ` · about ${APPLICABILITY[e.applicability as string] ?? String(e.applicability)}` : ''}
                          {e.evidence_strength ? ` · ${STRENGTH[e.evidence_strength as string] ?? String(e.evidence_strength)} evidence` : ''}
                          {e.substantiated_wording ? ` · supports “${e.substantiated_wording as string}”` : ''}
                          {e.expiry_date ? ` · expires ${formatDate(e.expiry_date as string)}` : ''}
                          {' · added '}{formatDate(e.created_at as string)}
                          {e.url ? <> · <a href={e.url} target="_blank" rel="noreferrer">Open file</a></> : null}
                          {!e.url && /^https?:\/\//i.test(String(e.source_location ?? '')) ? <> · <a href={String(e.source_location)} target="_blank" rel="noreferrer noopener">Open link</a></> : null}
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
                {(d.history.get(c.id) ?? []).length ? (
                  <details className="ak-small">
                    <summary>History</summary>
                    <ul style={{ paddingLeft: 18, margin: '6px 0 0' }}>
                      {(d.history.get(c.id) ?? []).map((h) => (
                        <li key={h.id}>
                          {CLAIM_CHANGE_WORDS[h.change] ?? h.change.replace(/_/g, ' ')} · {formatDate(h.at)} · {claimActorLabel(h.actor, d.members)}
                          <span className="ak-muted"> — “{h.wording}”{h.platforms.length ? ` · ${h.platforms.map((x) => PLATFORM_LABEL[x.toUpperCase()] ?? x).join(', ')}` : ''}{h.reason ? ` · ${h.reason}` : ''}</span>
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
                {canEdit && !['BLOCKED', 'INFERRED_ONLY'].includes(c.status) ? (
                  <div className="ak-row">
                    {canApprove && ['MERCHANT_REVIEW_REQUIRED', 'VERIFIED', 'VERIFIED_WITH_QUALIFIER'].includes(c.status) ? (
                      <SheetButton variant="text" label="Approve / scope" title="Approve this claim" description="Choose where it may be used.">
                        {/* The market scope is fixed to the brand's market until more markets are enabled. */}
                        <p className="ak-small" style={{ marginTop: 0 }}><span className="ak-label">Market</span><br />{marketName(d.market)}</p>
                        <ActionForm slug={slug} action="claim-approve" extra={{ claimId: c.id, markets: [d.market] }} submit={`Approve for ${d.market}`} fields={[
                          { name: 'platforms', label: 'Platforms', type: 'checkboxes', options: CLAIM_PLATFORM_OPTIONS },
                          { name: 'qualifier', label: 'Qualifier (optional)', placeholder: 'e.g. in a consumer study of 32 women', defaultValue: c.mandatoryQualifier ?? '' },
                        ]} />
                      </SheetButton>
                    ) : null}
                    <SheetButton variant="text" label="Attach evidence" title="Attach evidence" description="A study, lab report or certificate supporting this claim. Your say-so alone keeps a claim pending.">
                      <ActionForm slug={slug} action="evidence" multipart extra={{ claimId: c.id }} submit="Attach" fields={[
                        { name: 'type', label: 'Type', type: 'select', options: [['clinical_study', 'Clinical study'], ['consumer_perception', 'Consumer perception study'], ['lab_test', 'Lab test'], ['certificate', 'Certificate'], ['ingredient_spec', 'Ingredient spec'], ['other', 'Other']].map(([value, label]) => ({ value: value!, label: label! })) },
                        { name: 'applicability', label: 'What it tested', type: 'select', options: [['product_specific', 'This exact product (same formula)'], ['ingredient_level', 'An ingredient, not the finished product'], ['other_formulation', 'A different formula or product']].map(([value, label]) => ({ value: value!, label: label! })), hint: 'Only evidence about this exact product can approve a clinical, quantified or expert claim.' },
                        { name: 'strength', label: 'How strong is it', type: 'select', defaultValue: 'moderate', options: [['strong', 'Strong: a controlled study or accredited lab test'], ['moderate', 'Moderate: a consumer study or test report'], ['weak', 'Weak: informal or anecdotal']].map(([value, label]) => ({ value: value!, label: label! })), hint: 'Weak evidence keeps a clinical, quantified or expert claim pending.' },
                        { name: 'file', label: 'File (PDF or image)', type: 'file', accept: 'application/pdf,image/*' },
                        { name: 'location', label: 'Or a link to it (and page / section)', placeholder: 'https://…' },
                        { name: 'wording', label: 'Claim wording the evidence supports', placeholder: c.preferredWording, hint: 'Required for expert endorsements such as “dermatologist tested”: the exact words the report allows.', max: 200 },
                        { name: 'expiry', label: 'Expires (optional)', type: 'date' },
                      ]} />
                    </SheetButton>
                  </div>
                ) : null}
              </div>
            );
          })}
        </section>
      ))}
    </>
  );
}
