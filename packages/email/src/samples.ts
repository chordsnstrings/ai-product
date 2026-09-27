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
    receipt: { workspaceName: 'Sample Brand', productName: 'Dew Serum', amount: '$19.00', description: '15-second ad · intro price', url: `${appUrl}/produce/sample`, paidAt: '24 Sep 2026, 14:02 ET', reference: 'pi_sample' },
    invoice_receipt: { workspaceName: 'Sample Brand', planName: 'Growth', amount: '$299.00', tax: null, paidAt: '24 Sep 2026', periodStart: '24 Sep 2026', periodEnd: '24 Oct 2026', invoiceNumber: 'ARK-0042', hostedInvoiceUrl: null, url: `${w}/settings/billing` },
    asset_ready: { workspaceName: 'Sample Brand', productName: 'Dew Serum', url: `${appUrl}/deliver/sample`, catalogueNo: 'No. 014' },
    qa_needs_you: { workspaceName: 'Sample Brand', productName: 'Dew Serum', headline: 'Your ad needs one decision', reason: 'One claim in the script can’t be used in ads as written. Change the line and production continues.', cta: 'Fix the line', url: `${appUrl}/produce/sample` },
    offer_ending: { workspaceName: 'Sample Brand', productName: 'Dew Serum', url: `${appUrl}/storyboard/sample`, endsAt: '15:45 ET', price: '$19', regular: '$49' },
    storyboard_saved: { workspaceName: 'Sample Brand', productName: 'Dew Serum', url: `${appUrl}/storyboard/sample`, standalonePrice: '$49' },
    new_concept: { workspaceName: 'Sample Brand', productName: 'Dew Serum', url: `${appUrl}/concepts/sample`, hook: 'The 10-second routine that replaced three products' },
    export_ready: { url: `${appUrl}/files/sample`, workspaceName: 'Sample Brand' },
    refund_issued: { workspaceName: 'Sample Brand', amount: '$19.00', description: 'Dew Serum · 15-second ad', note: 'We couldn’t produce your ad to our quality standard, so you don’t pay for it.', url: `${w}/settings/billing` },
    flag_expired: { flagKey: 'kill.free_preview', owner: 'ops', expiredOn: '2026-09-20', url: `${appUrl}/flags` },
    integration_disconnected: { provider: 'Meta', url: `${w}/settings/integrations`, workspaceName: 'Sample Brand' },
    integration_expiring: { provider: 'Meta', url: `${w}/settings/integrations`, workspaceName: 'Sample Brand', expiresOn: '1 Oct 2026' },
    shop_transfer_request: { shop: 'sample-brand.myshopify.com', requester: 'j•••@example.com', url: `${w}/settings/integrations`, workspaceName: 'Sample Brand' },
    claim_review_result: { workspaceName: 'Sample Brand', productName: 'Dew Serum', claim: 'Visibly smoother-looking skin in 2 weeks', originalWording: 'Smoother skin in 2 weeks', outcome: 'approved', platforms: ['TikTok', 'Meta'], markets: ['US'], qualifier: 'In a 4-week consumer study', note: null, url: `${w}/products/sample/claims` },
    claim_evidence_request: { workspaceName: 'Sample Brand', claim: 'Clinically proven to reduce redness', productName: 'Calm Balm', note: 'Please upload the study summary and panel size.', url: `${w}/claims` },
    sku_out_of_scope: { workspaceName: 'Sample Brand', productName: 'Daily SPF 50', reason: 'Sunscreens are regulated as OTC drugs and are outside what we make ads for.', url: `${w}/products` },
    claims_guidance: { workspaceName: 'Sample Brand', blocked: 4, examples: ['Cures acne', 'Heals eczema'], url: `${w}/claims` },
    media_review_result: { workspaceName: 'Sample Brand', productName: 'Dew Serum', outcome: 'approved', note: 'The before/after pair is labelled and consented.', url: `${w}/products` },
    cancellation_confirmed: { workspaceName: 'Sample Brand', planName: 'Growth', endsOn: '23 Oct 2026', exportUrl: `${w}/settings/data` },
    plan_ended: { workspaceName: 'Sample Brand', planName: 'Growth', deletesOn: '22 Jan 2027', reactivateUrl: `${w}/settings/billing`, exportUrl: `${w}/settings/data` },
    plan_ended_payment_failed: { workspaceName: 'Sample Brand', planName: 'Growth', deletesOn: '22 Dec 2026', reactivateUrl: `${w}/settings/billing`, exportUrl: `${w}/settings/data` },
    subscription_started: { workspaceName: 'Sample Brand', planName: 'Launch', tests: 4, price: '$149', renewsOn: '24 Oct 2026', url: `${w}/this-week` },
    price_change_notice: { workspaceName: 'Sample Brand', planName: 'Growth', oldPrice: '$299', newPrice: '$329', effectiveOn: '1 Nov 2026', url: `${w}/settings/billing` },
    payment_failed: { url: `${w}/settings/billing`, workspaceName: 'Sample Brand' },
    security_alert: { event: 'New sign-in from Chrome on macOS', when: '24 Sep 2026, 14:02 ET', url: `${w}/settings/profile` },
    weekly_brief: { workspaceName: 'Sample Brand', week: 'Week 39', recommendations: [{ hypothesis: 'Texture close-ups beat talking heads for serums', slot: 'EXPLOIT' }, { hypothesis: 'An ingredient myth-bust opens a new angle', slot: 'EXPLORE' }], url: `${w}/this-week` },
    friday_summary: { workspaceName: 'Sample Brand', learned: ['Directional: texture demo is ahead on hold rate.'], uncertain: ['Routine vs ingredient: gathering signal (2 of 4 days).'], fatiguing: ['Before/after angle: CTR down 28% over 14 days.'], nextLikely: 'Test a texture close-up on the moisturiser.', url: `${w}/results` },
    signal_update: { workspaceName: 'Sample Brand', changes: [{ test: 'Texture vs routine', from: 'gathering signal', to: 'directional' }], url: `${w}/results` },
    day30_review: { workspaceName: 'Sample Brand', productName: 'Dew Serum', tested: 6, actionable: 2, url: `${w}/products/sample/review` },
    rights_expired: { workspaceName: 'Sample Brand', productName: 'Dew Serum', files: 2, expiredOn: '24 Sep 2026', url: `${w}/products/sample?tab=assets` },
    production_delayed: { workspaceName: 'Sample Brand', productName: 'Dew Serum', minutes: 24, url: `${appUrl}/produce/sample` },
    staff_invite: { name: 'Riley', inviterName: 'Sam', url: `${appUrl}/invite/sample`, expiresIn: '48 hours' },
    review_text_erased: { workspaceName: 'Sample Brand', deleted: 3, reference: 'Privacy request 2291', url: `${w}/settings/access-log` },
    staff_break_glass: { workspaceName: 'Sample Brand', staffName: 'Sam (Arkiv support)', reason: 'Support ticket #812: export failed', when: '24 Sep 2026, 14:02 ET', url: `${w}/settings/access-log` },
    ownership_transfer_confirm: { workspaceName: 'Sample Brand', newOwner: 'jordan@example.com', reason: 'Founder handing over the account', url: `${appUrl}/ownership/sample`, expiresIn: '72 hours' },
    purge_scheduled: { workspaceName: 'Sample Brand', stage: 'scheduled', purgeOn: '3 Oct 2026', cancelUrl: `${w}/settings/data`, exportUrl: `${w}/settings/data` },
    intervention: { workspaceName: 'Sample Brand', label: 'Your ad is ready', headline: 'Upload your ad to Meta in 2 minutes', body: 'Your finished ad is waiting. Here’s the fastest way to get it live.', cta: 'Show me how', url: `${w}/this-week` },
  };
}
