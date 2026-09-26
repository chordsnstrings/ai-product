import type { TemplateMap, TemplateName } from './templates';

/**
 * Sample data for every template (plan 05 §18 "the admin shows preview with sample data and test-send to staff").
 * Typed as a complete record, so a new template can't ship without a sample. Links point at the given app URL.
 */
export function templateSamples(appUrl: string): { [K in TemplateName]: TemplateMap[K] } {
  const w = `${appUrl}/w/sample-brand`;
  return {
    magic_link: { url: `${appUrl}/auth/magic/sample`, purpose: 'login' },
    invite: { url: `${appUrl}/invite/sample`, workspaceName: 'Sample Brand', inviterName: 'Alex Rivera', role: 'EDITOR' },
    receipt: { productName: 'Dew Serum', amount: '$19.00', description: '15-second ad · intro price', url: `${appUrl}/produce/sample` },
    asset_ready: { productName: 'Dew Serum', url: `${appUrl}/deliver/sample`, catalogueNo: 'No. 014' },
    offer_ending: { productName: 'Dew Serum', url: `${appUrl}/storyboard/sample`, endsAt: '3:45 PM', price: '$19', regular: '$49' },
    storyboard_saved: { productName: 'Dew Serum', url: `${appUrl}/storyboard/sample`, standalonePrice: '$49' },
    new_concept: { productName: 'Dew Serum', url: `${appUrl}/concepts/sample`, hook: 'The 10-second routine that replaced three products' },
    export_ready: { url: `${appUrl}/files/sample`, workspaceName: 'Sample Brand' },
    refund_issued: { amount: '$19.00', description: 'Dew Serum · 15-second ad', note: 'We couldn’t produce your ad to our quality standard, so you don’t pay for it.', url: `${w}/settings/billing` },
    flag_expired: { flagKey: 'kill.free_preview', owner: 'ops', expiredOn: '2026-09-20', url: `${appUrl}/flags` },
    integration_disconnected: { provider: 'Meta', url: `${w}/settings/integrations`, workspaceName: 'Sample Brand' },
    integration_expiring: { provider: 'Meta', url: `${w}/settings/integrations`, workspaceName: 'Sample Brand', expiresOn: 'October 1' },
    shop_transfer_request: { shop: 'sample-brand.myshopify.com', requester: 'j•••@example.com', url: `${w}/settings/integrations`, workspaceName: 'Sample Brand' },
    claim_review_result: { claim: 'Visibly smoother skin in 2 weeks', outcome: 'Approved with a qualifier', url: `${w}/claims` },
    claim_evidence_request: { claim: 'Clinically proven to reduce redness', productName: 'Calm Balm', note: 'Please upload the study summary and panel size.', url: `${w}/claims` },
    sku_out_of_scope: { productName: 'Daily SPF 50', reason: 'Sunscreens are regulated as OTC drugs and are outside what we make ads for.', url: `${w}/products` },
    claims_guidance: { workspaceName: 'Sample Brand', blocked: 4, examples: ['Cures acne', 'Heals eczema'], url: `${w}/claims` },
    media_review_result: { productName: 'Dew Serum', outcome: 'approved', note: 'The before/after pair is labelled and consented.', url: `${w}/products` },
    cancellation_confirmed: { planName: 'Growth', endsOn: 'October 23', exportUrl: `${w}/settings/data` },
    plan_ended_payment_failed: { planName: 'Growth', deletesOn: 'December 22', reactivateUrl: `${w}/settings/billing`, exportUrl: `${w}/settings/data` },
    subscription_started: { planName: 'Launch', tests: 4, price: '$149', renewsOn: 'October 24', url: `${w}/this-week` },
    price_change_notice: { planName: 'Growth', oldPrice: '$299', newPrice: '$329', effectiveOn: 'November 1', url: `${w}/settings/billing` },
    payment_failed: { url: `${w}/settings/billing`, workspaceName: 'Sample Brand' },
    security_alert: { event: 'New sign-in from Chrome on macOS', when: 'Sep 24, 14:02 UTC', url: `${w}/settings/profile` },
    weekly_brief: { workspaceName: 'Sample Brand', week: 'Week 39', recommendations: [{ hypothesis: 'Texture close-ups beat talking heads for serums', slot: 'EXPLOIT' }, { hypothesis: 'An ingredient myth-bust opens a new angle', slot: 'EXPLORE' }], url: `${w}/this-week` },
    friday_summary: { workspaceName: 'Sample Brand', lines: ['Texture demo is ahead on hold rate (directional).', 'Two tests are still gathering signal.'], url: `${w}/results` },
    signal_update: { workspaceName: 'Sample Brand', changes: [{ test: 'Texture vs routine', from: 'gathering signal', to: 'directional' }], url: `${w}/results` },
    day30_review: { productName: 'Dew Serum', tested: 6, actionable: 2, url: `${w}/products/sample/review` },
    rights_expired: { productName: 'Dew Serum', files: 2, expiredOn: 'Sep 24, 2026', url: `${w}/products/sample?tab=assets` },
    production_delayed: { productName: 'Dew Serum', minutes: 24, url: `${appUrl}/produce/sample` },
    staff_invite: { name: 'Riley', inviterName: 'Sam', url: `${appUrl}/invite/sample`, expiresIn: '48 hours' },
    review_text_erased: { workspaceName: 'Sample Brand', deleted: 3, reference: 'Privacy request 2291', url: `${w}/settings/access-log` },
    staff_break_glass: { staffName: 'Sam (Arkiv support)', reason: 'Support ticket #812: export failed', when: 'Sep 24, 14:02 UTC', url: `${w}/settings/access-log` },
    ownership_transfer_confirm: { workspaceName: 'Sample Brand', newOwner: 'jordan@example.com', reason: 'Founder handing over the account', url: `${appUrl}/ownership/sample`, expiresIn: '72 hours' },
    intervention: { label: 'Your ad is ready', headline: 'Upload your ad to Meta in 2 minutes', body: 'Your finished ad is waiting. Here’s the fastest way to get it live.', cta: 'Show me how', url: `${w}/this-week` },
  };
}
