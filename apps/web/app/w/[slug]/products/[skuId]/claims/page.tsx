import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { withTenant } from '@arkiv/db';
import { claimMarket, listClaims } from '@arkiv/core';
import { ClaimChip } from '@arkiv/ui';
import { ActionForm, SheetButton } from '@/components/actions';
import { workspacePage } from '@/lib/tenant';

export const metadata: Metadata = { title: 'Claims · Arkiv' };

/** Stored as canonical platform codes; META covers Instagram Reels + Facebook/Instagram feed. */
const CLAIM_PLATFORM_OPTIONS = [
  { value: 'TIKTOK', label: 'TikTok' },
  { value: 'META', label: 'Meta (Reels + Feed)' },
  { value: 'YOUTUBE', label: 'YouTube' },
  { value: 'ORGANIC', label: 'Organic posts' },
];
const PLATFORM_LABEL: Record<string, string> = { TIKTOK: 'TikTok', INSTAGRAM_REELS: 'Reels', FACEBOOK_FEED: 'Feed', YOUTUBE: 'YouTube', ORGANIC: 'Organic' };

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
    const ev = await tx`select claim_id, evidence_type, expiry_date, created_at from claim_evidence where claim_id in ${tx(claims.length ? claims.map((c) => c.id) : ['00000000-0000-0000-0000-000000000000'])}`;
    return { sku, claims, ev, market: await claimMarket(tx, skuId) };
  });
  if (!d) notFound();
  const canApprove = ['OWNER', 'ADMIN'].includes(w.ctx.role);
  const canEdit = canApprove || w.ctx.role === 'MEMBER';
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
                {c.blockReason ? <p className="ak-small">{c.blockReason}</p> : null}
                <p className="ak-small ak-muted">{c.category} · {c.riskLevel} risk · {c.origin}{c.allowedPlatforms.length ? ` · ${c.allowedPlatforms.map((x) => PLATFORM_LABEL[x.toUpperCase()] ?? x).join(', ')} · ${c.allowedMarkets.join(', ')}` : ''}{ev.length ? ` · ${ev.length} evidence file${ev.length > 1 ? 's' : ''}` : ''}</p>
                {canEdit && !['BLOCKED', 'INFERRED_ONLY'].includes(c.status) ? (
                  <div className="ak-row">
                    {canApprove && ['MERCHANT_REVIEW_REQUIRED', 'VERIFIED', 'VERIFIED_WITH_QUALIFIER'].includes(c.status) ? (
                      <SheetButton variant="text" label="Approve / scope" title="Approve this claim" description="Choose where it may be used.">
                        <ActionForm slug={slug} action="claim-approve" extra={{ claimId: c.id, markets: [d.market] }} submit={`Approve for ${d.market}`} fields={[
                          { name: 'platforms', label: 'Platforms', type: 'checkboxes', options: CLAIM_PLATFORM_OPTIONS },
                          { name: 'qualifier', label: 'Qualifier (optional)', placeholder: 'e.g. in a consumer study of 32 women', defaultValue: c.mandatoryQualifier ?? '' },
                        ]} />
                      </SheetButton>
                    ) : null}
                    <SheetButton variant="text" label="Attach evidence" title="Attach evidence" description="A study, lab report or certificate supporting this claim.">
                      <ActionForm slug={slug} action="evidence" multipart extra={{ claimId: c.id }} submit="Attach" fields={[
                        { name: 'type', label: 'Type', type: 'select', options: [['clinical_study', 'Clinical study'], ['consumer_perception', 'Consumer perception study'], ['lab_test', 'Lab test'], ['certificate', 'Certificate'], ['ingredient_spec', 'Ingredient spec'], ['other', 'Other']].map(([value, label]) => ({ value: value!, label: label! })) },
                        { name: 'file', label: 'File (PDF or image)', type: 'file', accept: 'application/pdf,image/*' },
                        { name: 'location', label: 'Page / section (optional)' },
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
