import { z } from 'zod';
import { withTenant } from '@arkiv/db';
import {
  acceptSourceFact,
  idempotent,
  renderQuote,
  confirmFacts,
  approveClaim,
  approveExperiment,
  assertCan,
  attachEvidence,
  cancelDeletion,
  changeRole,
  connectSelectedAccounts,
  decideShopTransfer,
  requestShopTransfer,
  acceptCreatorFootage, createCreatorPack,
  createExperiment,
  decideConfounder,
  decideFact,
  deleteAsset,
  disconnectIntegration,
  EVIDENCE_APPLICABILITY,
  dismissNotice,
  dismissRecommendation,
  enqueue,
  importHistoricalCreative,
  beforeAfterAttestation,
  importSignals,
  ingestBytes,
  ingestObservations,
  inviteMember,
  linkAdToVariant,
  markConfounder,
  parsePerformanceCsv,
  parseReviewPaste,
  Proposal,
  proposeClaim,
  Queues,
  removeMember,
  replaceAsset,
  revokeCreatorPack,
  requestExport,
  saveIntegration,
  scheduleDeletion,
  setExperimentState,
  archiveExperiment,
  setStockIntent,
  STOCK_INTENTS,
  transferOwnership,
  updateBrandBrain,
  createBrand,
  assignSkuBrand,
  toBrain,
  refreshPackaging,
  approveFingerprintViews,
  weekOf,
} from '@arkiv/core';
import { billingGateway, CANCEL_REASONS, changePlan, recordAutoRenewConsent, setCancellation, startSubscriptionCheckout } from '@arkiv/billing';
import { sendEmail } from '@arkiv/email';
import { CSV_PLATFORMS, CSV_SOURCES, DomainError, env, formatDate, PLANS, type PlanCode } from '@arkiv/shared';
import { body, clientIp, fileIdentity, idempotencyKeyOf, json, route, withIdempotency } from '@/lib/http';
import { workspaceBySlug } from '@/lib/tenant';

const uuid = z.string().uuid();
const PLAN = z.enum(['LAUNCH', 'GROWTH', 'SCALE']);
const MULTIPART = new Set(['performance-csv', 'evidence', 'import-creative', 'asset-replace', 'brand-logo', 'brand-reference', 'packaging-refresh']);
/** A textarea of one item per line (or comma-separated) → a clean list. */
const lines = (v: string | undefined, max: number, len: number) => [...new Set((v ?? '').split(/\n|,(?![^(]*\))/).map((x) => x.trim()).filter(Boolean).map((x) => x.slice(0, len)))].slice(0, max);
/** Brand colours as the form writes them (#hex, comma or space separated). */
const hexes = (v: string | string[] | undefined) => {
  const all = (Array.isArray(v) ? v : (v ?? '').split(/[\s,]+/)).map((x) => x.trim()).filter(Boolean);
  const bad = all.find((x) => !/^#[0-9a-f]{6}$/i.test(x));
  if (bad) throw new DomainError('INVALID', `“${bad}” isn’t a colour. Use hex codes like #1F2A44.`);
  return [...new Set(all.map((x) => x.toUpperCase()))].slice(0, 6);
};

/**
 * Workspace-scoped mutations (plan 03 Part B). Every action resolves membership from the session (layer 1),
 * runs inside the tenant transaction (RLS, layer 2) and is authorised by role (authz matrix).
 */
export const POST = route(async (req, { params }: { params: Promise<{ slug: string; action: string }> }) => {
  const { slug, action } = await params;
  const w = await workspaceBySlug(slug);
  const ctx = w.ctx;
  const t = <T>(fn: Parameters<typeof withTenant<T>>[1]) => withTenant<T>(ctx.workspaceId, fn);
  // §39: creates carry the client's Idempotency-Key (one per submission); a replay returns the first answer.
  const idemKey = idempotencyKeyOf(req);
  const once = <T>(tx: Parameters<Parameters<typeof withTenant<T>>[1]>[0], request: unknown, fn: () => Promise<T>) => withIdempotency(tx, ctx.workspaceId, action, idemKey, request, fn);

  // Multipart actions first (files). Each one is authorised by role, here or inside the core function.
  if (MULTIPART.has(action)) {
    const form = await req.formData();
    const file = form.get('file');
    switch (action) {
      case 'performance-csv': {
        assertCan(ctx, 'integration.manage');
        if (!(file instanceof File)) throw new DomainError('INVALID', 'Choose a CSV file');
        if (file.size > 10 * 1024 * 1024) throw new DomainError('INVALID', 'CSV must be under 10 MB');
        // Which Ads Manager the export is from: each platform's rows are measured (and learned from) separately.
        const platform = z.enum(CSV_PLATFORMS, { error: 'Choose whether this export is from Meta or TikTok.' }).parse(form.get('platform'));
                // The day column is in the ad account's reporting timezone (§47); the uploader can name it.
        const tz = z.string().trim().max(64).regex(/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$/).optional().parse((form.get('timezone') as string | null) || undefined) ?? null;
        // §48: organic or affiliate delivery is kept in its own measurement context, never mixed with paid.
        const source = z.enum(CSV_SOURCES).default('paid').parse((form.get('source') as string | null) || undefined);
        const rows = parsePerformanceCsv(await file.text(), platform, { timezone: tz, source });
        if (!rows.length) throw new DomainError('INVALID', 'No rows found. Export “Ad name, Day, Spend, Impressions, Clicks, Purchases” from Ads Manager.');
        const r = await t((tx) => once(tx, { platform, tz, source, file: fileIdentity(file), rows: rows.length }, () => ingestObservations(tx, ctx, null, rows)));
        return json({ ok: true, ...r });
      }
      case 'evidence': {
        const claimId = uuid.parse(form.get('claimId'));
        const type = z.enum(['clinical_study', 'consumer_perception', 'lab_test', 'certificate', 'ingredient_spec', 'other']).parse(form.get('type'));
        // §43: evidence is a document (or a link to one) and says whether it is about this product.
        const applicability = z.enum(EVIDENCE_APPLICABILITY).parse(form.get('applicability'));
        const location = z.string().trim().max(500).optional().parse((form.get('location') as string | null) || undefined) || null;
        const wording = z.string().trim().max(200).optional().parse((form.get('wording') as string | null) || undefined) || null;
        const expiry = z.string().date().optional().parse((form.get('expiry') as string | null) || undefined) ?? null;
        const hasFile = file instanceof File && file.size > 0;
        if (!hasFile && !/^https?:\/\/\S+$/i.test(location ?? '')) throw new DomainError('INVALID', 'Attach the document, or paste a link to it. A description alone isn’t evidence.');
        assertCan(ctx, 'sku.edit');
        await t((tx) =>
          once(tx, { claimId, type, applicability, location, wording, expiry, file: fileIdentity(file) }, async () => {
            const assetId = hasFile ? (await ingestBytes(tx, ctx, Buffer.from(await (file as File).arrayBuffer()), 'evidence_doc', null, { filename: (file as File).name })).id : null;
            await attachEvidence(tx, ctx, claimId, { type, assetId, location, applicability, expiry, wording });
            return { ok: true };
          }),
        );
        return json({ ok: true });
      }
      case 'asset-replace': {
        // §48: replacement footage for a file whose creator rights ended; the old file is kept for history.
        assertCan(ctx, 'sku.edit');
        const assetId = uuid.parse(form.get('assetId'));
        if (!(file instanceof File) || !file.size) throw new DomainError('INVALID', 'Choose the replacement file.');
        const r = await t((tx) => once(tx, { assetId, file: fileIdentity(file) }, async () => replaceAsset(tx, ctx, assetId, Buffer.from(await file.arrayBuffer()), file.name)));
        return json({ ok: true, ...r });
      }
      case 'brand-logo':
        assertCan(ctx, 'sku.edit');
      // falls through: the logo and the visual references are stored the same way
      case 'brand-reference': {
        // Brand Brain (§16) logo and visual references: stored as brand files, referenced by a new Brand Brain version.
        assertCan(ctx, 'sku.edit');
        const brandId = uuid.parse(form.get('brandId'));
        if (!(file instanceof File) || !file.size) throw new DomainError('INVALID', 'Choose an image.');
        const kind = action === 'brand-logo' ? 'brand_logo' : 'brand_reference';
        const r = await t((tx) =>
          once(tx, { brandId, kind, file: fileIdentity(file) }, async () => {
            const [b] = await tx`select name, brain from brands where id = ${brandId} and workspace_id = ${ctx.workspaceId}`;
            if (!b) throw new DomainError('NOT_FOUND', 'Brand not found');
            const brain = toBrain(b.brain);
            if (kind === 'brand_reference' && brain.visualReferenceAssetIds.length >= 12) throw new DomainError('INVALID', 'A brand keeps up to 12 visual references. Remove one first.');
            const a = await ingestBytes(tx, ctx, Buffer.from(await file.arrayBuffer()), kind, null, { filename: file.name, brandId });
            return updateBrandBrain(tx, ctx, {
              ...brain,
              brandId,
              name: b.name as string,
              ...(kind === 'brand_logo' ? { logoAssetId: a.id } : { visualReferenceAssetIds: [...brain.visualReferenceAssetIds, a.id] }),
            }, kind === 'brand_logo' ? 'logo updated' : 'visual reference added');
          }),
        );
        return json({ ok: true, version: r.version });
      }
      case 'packaging-refresh': {
        // §42 packaging refresh: new photos → a new Visual Fingerprint version; ads already made keep the old one.
        const skuId = uuid.parse(form.get('skuId'));
        const labelText = z.string().trim().max(400).optional().parse((form.get('labelText') as string | null) || undefined) ?? null;
        const note = z.string().trim().max(200).optional().parse((form.get('note') as string | null) || undefined) ?? null;
        const photos = form.getAll('photos').concat(file ? [file] : []).filter((f): f is File => f instanceof File && f.size > 0);
        if (photos.length > 6) throw new DomainError('INVALID', 'Add up to 6 photos at a time.');
        const r = await t((tx) =>
          once(tx, { skuId, labelText, files: photos.map(fileIdentity) }, async () =>
            refreshPackaging(tx, ctx, skuId, await Promise.all(photos.map(async (f) => ({ bytes: Buffer.from(await f.arrayBuffer()), filename: f.name }))), { labelText, note }),
          ),
        );
        return json({ ok: true, ...r });
      }
      case 'import-creative': {
        // A past ad (copy + optional video) → genome extraction (standard §6 cold start).
        const skuId = uuid.parse(form.get('skuId'));
        const copy = z.string().trim().min(3).max(2000).parse(form.get('copy'));
        assertCan(ctx, 'sku.create');
        const platform = (form.get('platform') as 'meta' | 'tiktok') || null;
        const adId = (form.get('adId') as string) || null;
        // §48: the other products the ad shows, and whether people under 18 appear in it.
        const secondarySkuIds = z.array(uuid).max(10).parse(form.getAll('secondarySkuIds'));
        const minorsPresent = form.getAll('minors').includes('yes');
        // §43: a before/after is declared with its provenance/permission attestation and goes to policy review.
        const beforeAfter = beforeAfterAttestation(form.getAll('beforeAfter').map(String));
        const id = await t((tx) =>
          once(tx, { skuId, copy, platform, adId, secondarySkuIds, minorsPresent, beforeAfter: !!beforeAfter, file: fileIdentity(file) }, async () => {
            const assetId = file instanceof File && file.size ? (await ingestBytes(tx, ctx, Buffer.from(await file.arrayBuffer()), 'creator_footage', skuId, { filename: file.name, ...(beforeAfter ? { beforeAfter } : {}) })).id : null;
            return importHistoricalCreative(tx, ctx, { skuId, copy, assetId, platform, adId, secondarySkuIds, minorsPresent });
          }),
        );
        return json({ ok: true, creativeId: id });
      }
    }
  }

  switch (action) {
    /* ── This Week ── */
    case 'rec-accept': {
      const { id } = await body(req, z.object({ id: uuid }));
      // Authorise before looking the recommendation up: a Viewer gets 403, not "already handled".
      assertCan(ctx, 'experiment.create');
      const r = await t((tx) =>
        once(tx, { id }, async () => {
          const [rec] = await tx`select * from recommendations where id = ${id} and status = 'open' for update`;
          if (!rec) throw new DomainError('CONFLICT', 'This recommendation was already handled.');
          // A refresh of a fatigued winner runs the winner as the control (§45 "controlled refresh").
          return createExperiment(tx, ctx, { skuId: rec.sku_id as string, proposal: Proposal.parse(rec.proposal), recommendationId: id, slot: rec.slot as 'EXPLOIT', controlCreativeId: (rec.control_creative_id as string | null) ?? null });
        }),
      );
      return json({ ...r, next: `/w/${slug}/studio/${r.experimentId}` });
    }
    case 'rec-dismiss': {
      const { id, reason } = await body(req, z.object({ id: uuid, reason: z.string().min(2).max(200) }));
      assertCan(ctx, 'experiment.create');
      await t((tx) => dismissRecommendation(tx, ctx, id, reason));
      return json({ ok: true });
    }
    case 'rec-refresh': {
      assertCan(ctx, 'experiment.create');
      const week = weekOf();
      await t((tx) => enqueue(tx, ctx.workspaceId, Queues.weeklyRecommendations, { week, actor: ctx.actor }, { singletonKey: `recs:${ctx.workspaceId}:${week}` }));
      return json({ ok: true });
    }
    /* ── Studio ── */
    case 'render-estimate': {
      // §38 POST /experiments/:id/render-estimate: cost at today's rates + whether it would be authorised, no reservation.
      const { experimentId } = await body(req, z.object({ experimentId: uuid }));
      return json({ ok: true, ...(await t((tx) => renderQuote(tx, ctx, experimentId))) });
    }
    case 'experiment-approve': {
      // §38 "render endpoint requires cost authorization and idempotency key": a live quote from render-estimate and
      // an Idempotency-Key; a retried request with the same key returns the first answer.
      const i = await body(req, z.object({ experimentId: uuid, quoteId: uuid, idempotencyKey: z.string().min(8).max(100).optional() }));
      const key = req.headers.get('idempotency-key') ?? i.idempotencyKey;
      if (!key || key.length < 8 || key.length > 100) throw new DomainError('INVALID', 'An Idempotency-Key is required to approve production.');
      assertCan(ctx, 'spend.creative_test');
      const r = await t((tx) => idempotent(tx, ctx.workspaceId, 'experiment-approve', key, { experimentId: i.experimentId, quoteId: i.quoteId }, () => approveExperiment(tx, ctx, i.experimentId, { quoteId: i.quoteId })));
      return json({ ok: true, replayed: r.replayed, ...r.result });
    }
    /* ── Creator Packs (§26) ── */
    case 'creator-pack': {
      const { experimentId } = await body(req, z.object({ experimentId: uuid }));
      const r = await t((tx) => createCreatorPack(tx, ctx, experimentId));
      // The link is shown once: only its hash is stored.
      return json({ ok: true, id: r.id, url: new URL(`/pack/${r.token}`, env().APP_URL).toString(), expiresAt: r.expiresAt });
    }
    case 'creator-footage-accept': {
      // §26: the merchant takes creator footage into the test it answers (Owner/Admin, rights attested on accept).
      const { assetId } = await body(req, z.object({ assetId: uuid }));
      const r = await t((tx) => acceptCreatorFootage(tx, ctx, assetId));
      return json({ ok: true, ...r });
    }
    case 'creator-pack-revoke': {
      const { id } = await body(req, z.object({ id: uuid }));
      await t((tx) => revokeCreatorPack(tx, ctx, id));
      return json({ ok: true });
    }
    case 'experiment-archive': {
      const { experimentId } = await body(req, z.object({ experimentId: uuid }));
      assertCan(ctx, 'experiment.create');
      // Its production (if still running or waiting) is cancelled first: no produce job or reserved credit survives.
      const r = await t((tx) => archiveExperiment(tx, ctx, experimentId));
      return json({ ok: true, ...r });
    }
    case 'experiment-live': {
      const { experimentId } = await body(req, z.object({ experimentId: uuid }));
      assertCan(ctx, 'experiment.create');
      await t((tx) => setExperimentState(tx, ctx, experimentId, 'GATHERING_SIGNAL', 'merchant marked as running'));
      return json({ ok: true });
    }
    case 'link-ad': {
      const i = await body(req, z.object({ platform: z.enum(['meta', 'tiktok']), adId: z.string().min(3).max(64), variantId: uuid }));
      assertCan(ctx, 'experiment.create');
      await t((tx) => linkAdToVariant(tx, ctx, i.platform, i.adId, i.variantId));
      return json({ ok: true });
    }
    case 'confounder': {
      const i = await body(req, z.object({ skuId: uuid.nullish(), kind: z.enum(['stockout', 'site_outage', 'price_change', 'offer_change', 'influencer_event', 'audience_change', 'bid_change', 'landing_change', 'viral_event', 'other']), startsAt: z.string().date(), endsAt: z.string().date().nullish(), note: z.string().max(300).nullish() }));
      await t((tx) => markConfounder(tx, ctx, i));
      return json({ ok: true });
    }
    case 'confounder-decide': {
      // Confirm an automatic candidate (a detected sales spike) or dismiss a confounder that didn't happen (§45).
      const i = await body(req, z.object({ id: uuid, decision: z.enum(['confirm', 'dismiss']) }));
      return json({ ok: true, ...(await t((tx) => decideConfounder(tx, ctx, i.id, i.decision))) });
    }
    /* ── Product Brain + Claims ── */
    case 'fact': {
      const i = await body(req, z.object({ skuId: uuid, key: z.string().regex(/^[a-z_]{2,40}$/), value: z.string().trim().min(1).max(2000) }));
      assertCan(ctx, 'sku.edit');
      const n = i.key.includes('price') ? Number(i.value.replace(/[^0-9.]/g, '')) : null;
      await t((tx) => decideFact(tx, ctx, i.skuId, i.key, n != null && n > 0 ? { number: n } : { text: i.value }));
      return json({ ok: true });
    }
    case 'stock-intent': {
      const i = await body(req, z.object({ skuId: uuid, intent: z.enum(STOCK_INTENTS).nullable() }));
      return json({ ok: true, ...(await t((tx) => setStockIntent(tx, ctx, i.skuId, i.intent))) });
    }
    case 'fact-confirm': {
      const i = await body(req, z.object({ skuId: uuid, factIds: z.array(uuid).min(1).max(50) }));
      return json({ ok: true, confirmed: (await t((tx) => confirmFacts(tx, ctx, i.skuId, i.factIds))).length });
    }
    case 'asset-delete': {
      const i = await body(req, z.object({ assetId: uuid }));
      return json({ ok: true, ...(await t((tx) => deleteAsset(tx, ctx, i.assetId))) });
    }
    case 'fact-accept-source': {
      // "Use the store's value": a source reading that changed after the merchant's decision becomes the truth again.
      const i = await body(req, z.object({ skuId: uuid, factId: uuid }));
      await t((tx) => acceptSourceFact(tx, ctx, i.skuId, i.factId));
      return json({ ok: true });
    }
    case 'claim-propose': {
      const i = await body(req, z.object({ skuId: uuid, wording: z.string().trim().min(3).max(200) }));
      assertCan(ctx, 'sku.edit');
      return json(await t((tx) => once(tx, i, () => proposeClaim(tx, ctx, i.skuId, { wording: i.wording, origin: 'merchant' }))));
    }
    case 'claim-approve': {
      // Scope values are normalised (and unknown ones refused) by approveClaim: TIKTOK, META (= Reels + Feed), YOUTUBE, ORGANIC…
      const i = await body(req, z.object({ claimId: uuid, markets: z.array(z.string().trim().min(2).max(3)).min(1).max(20), platforms: z.array(z.string().trim().min(2).max(32)).min(1).max(10), qualifier: z.string().max(120).nullish(), wording: z.string().max(200).optional() }));
      return json(await t((tx) => approveClaim(tx, ctx, i.claimId, i)));
    }
    case 'reviews': {
      const i = await body(req, z.object({ skuId: uuid, text: z.string().min(10).max(200_000) }));
      assertCan(ctx, 'sku.edit');
      const items = parseReviewPaste(i.text);
      if (!items.length) throw new DomainError('INVALID', 'We couldn’t find any reviews in that text.');
      await t((tx) =>
        once(tx, i, async () => {
          await importSignals(tx, ctx, i.skuId, items);
          await enqueue(tx, ctx.workspaceId, Queues.customerThemes, { skuId: i.skuId, actor: ctx.actor }, { singletonKey: `themes:${i.skuId}` });
          return { imported: items.length };
        }),
      );
      return json({ ok: true, imported: items.length });
    }
    /* ── Members ── */
    case 'invite': {
      const i = await body(req, z.object({ email: z.string().email(), role: z.enum(['ADMIN', 'MEMBER', 'VIEWER']) }));
      const r = await t((tx) => inviteMember(tx, ctx, i.email, i.role));
      await sendEmail('invite', i.email.toLowerCase(), { url: `${env().APP_URL}/invite/${r.token}`, workspaceName: w.name, inviterName: w.user?.name ?? w.user?.email ?? 'A teammate', role: i.role }, { idempotencyKey: `invite:${r.inviteId}` });
      return json({ ok: true });
    }
    case 'invite-revoke': {
      const { id } = await body(req, z.object({ id: uuid }));
      assertCan(ctx, 'member.invite');
      await t((tx) => tx`update invites set revoked_at = now() where id = ${id} and accepted_at is null`);
      return json({ ok: true });
    }
    case 'member-role': {
      const i = await body(req, z.object({ userId: uuid, role: z.enum(['ADMIN', 'MEMBER', 'VIEWER']) }));
      await t((tx) => changeRole(tx, ctx, i.userId, i.role));
      return json({ ok: true });
    }
    case 'member-remove': {
      const { userId } = await body(req, z.object({ userId: uuid }));
      await t((tx) => removeMember(tx, ctx, userId));
      return json({ ok: true, next: userId === ctx.actor.id ? '/app' : null });
    }
    case 'transfer': {
      const { userId } = await body(req, z.object({ userId: uuid }));
      await t((tx) => transferOwnership(tx, ctx, userId));
      return json({ ok: true });
    }
    /* ── In-app notices from Arkiv (plan 05 §17 playbooks) ── */
    case 'notice-dismiss': {
      const { id } = await body(req, z.object({ id: uuid }));
      await t((tx) => dismissNotice(tx, ctx, id));
      return json({ ok: true });
    }
    /* ── Billing (plan 04 §3: honest, two-click cancel) ── */
    case 'subscribe': {
      const i = await body(req, z.object({ plan: PLAN, agreed: z.boolean() }));
      if (!w.user) throw new DomainError('UNAUTHENTICATED', 'Please log in.');
      const r = await t(async (tx) => {
        const consentId = await recordAutoRenewConsent(tx, ctx, { userId: w.user!.id, plan: i.plan, agreed: i.agreed, ip: clientIp(req), userAgent: req.headers.get('user-agent') });
        return startSubscriptionCheckout(tx, ctx, i.plan, consentId, { id: w.user!.id, email: w.user!.email });
      });
      return json({ ...r, live: billingGateway().live, publishableKey: billingGateway().live ? (env().STRIPE_PUBLISHABLE_KEY ?? null) : null });
    }
    case 'cancel': {
      // The reason code and the free text are kept apart, so the console can count cancellations by code.
      const i = await body(req, z.object({ reason: z.enum(CANCEL_REASONS).nullish(), detail: z.string().max(500).nullish() }));
      const r = await t((tx) => setCancellation(tx, ctx, true, { code: i.reason ?? null, detail: i.detail ?? null }));
      if (w.user) {
        const plan = PLANS[(ctx.planCode as PlanCode) ?? 'LAUNCH'];
        // A past-due plan ends today (immediate cancel); otherwise access runs to the end of the paid period.
        const endsOn = r.immediate ? 'today' : formatDate(r.endsAt);
        await sendEmail('cancellation_confirmed', w.user.email, { planName: plan?.name ?? 'Your plan', endsOn, exportUrl: `${env().APP_URL}/w/${slug}/settings/data` }, { idempotencyKey: `cancel:${ctx.workspaceId}:${r.immediate ? 'now' : r.endsAt}` });
      }
      return json(r);
    }
    case 'uncancel':
      return json(await t((tx) => setCancellation(tx, ctx, false)));
    case 'change-plan': {
      const { plan } = await body(req, z.object({ plan: PLAN }));
      return json(await t((tx) => changePlan(tx, ctx, plan)));
    }
    case 'portal': {
      assertCan(ctx, 'billing.manage');
      // Always this workspace's own customer (explicit id, not "any row the role can see").
      const [c] = await t((tx) => tx`select customer_id from stripe_customers where workspace_id = ${ctx.workspaceId}`);
      if (!c) throw new DomainError('NOT_FOUND', 'No billing account yet.');
      return json({ url: await billingGateway().portalUrl(c.customer_id as string, `${env().APP_URL}/w/${slug}/settings/billing`) });
    }
    /* ── Integrations ── */
    case 'integration-disconnect': {
      const { id } = await body(req, z.object({ id: uuid }));
      await t((tx) => disconnectIntegration(tx, ctx, id));
      return json({ ok: true });
    }
    case 'integration-sync': {
      const { id } = await body(req, z.object({ id: uuid }));
      assertCan(ctx, 'integration.manage');
      await t((tx) => enqueue(tx, ctx.workspaceId, Queues.syncIntegration, { integrationId: id }, { singletonKey: `sync:${id}` }));
      return json({ ok: true });
    }
    case 'integration-select': {
      // The merchant picks which ad accounts on the login belong to this workspace (§47); `replace` switches.
      const i = await body(req, z.object({ pendingId: uuid, accountIds: z.array(z.string().min(1).max(64)).min(1).max(200), mode: z.enum(['add', 'replace']).default('add') }));
      const r = await t((tx) => connectSelectedAccounts(tx, ctx, i.pendingId, i.accountIds, { replace: i.mode === 'replace' }));
      return json({ ok: true, ...r, next: `/w/${slug}/settings/integrations?${new URLSearchParams({ result: `Connected ${r.connected} account${r.connected === 1 ? '' : 's'}${r.disconnected ? `, disconnected ${r.disconnected}` : ''}. First sync running.` })}` });
    }
    case 'shop-transfer-request': {
      // Plan 02 §3 layer 8: the store is routed to another workspace; the signed proof comes from this user's OAuth.
      const { proof } = await body(req, z.object({ proof: z.string().min(10).max(2000) }));
      if (!w.user) throw new DomainError('UNAUTHENTICATED', 'Please log in.');
      await t((tx) => requestShopTransfer(tx, ctx, proof, w.user!.email));
      return json({ ok: true, next: `/w/${slug}/settings/integrations?${new URLSearchParams({ result: 'Transfer requested. The store’s current workspace owner has been asked to approve it.' })}` });
    }
    case 'shop-transfer-decide': {
      const i = await body(req, z.object({ id: uuid, decision: z.enum(['approve', 'reject']) }));
      await t((tx) => decideShopTransfer(tx, ctx, i.id, i.decision));
      return json({ ok: true });
    }
    case 'integration-demo': {
      // Dev/test only: a demo ad account so the loop can be exercised without platform credentials.
      if (env().PROVIDERS_MODE !== 'mock') throw new DomainError('FORBIDDEN', 'Not available');
      const { provider } = await body(req, z.object({ provider: z.enum(['meta', 'tiktok']) }));
      const id = await t((tx) => saveIntegration(tx, ctx, { provider, externalAccountId: `demo_${provider}`, displayName: `Demo ${provider} account`, token: 'demo', scopes: ['ads_read'], currency: 'USD' }));
      return json({ ok: true, id });
    }
    /* ── Brand, workspace ── */
    case 'brand': {
      const i = await body(
        req,
        z.object({
          brandId: uuid.optional(),
          name: z.string().trim().min(1).max(80),
          tone: z.string().max(300).optional(),
          colors: z.union([z.array(z.string()).max(6), z.string().max(200)]).optional(),
          headingFont: z.string().trim().max(60).optional(),
          bodyFont: z.string().trim().max(60).optional(),
          prohibited: z.string().max(500).optional(),
          talentTypes: z.string().max(800).optional(),
          disclosures: z.string().max(500).optional(),
          cta: z.string().max(40).optional(),
          ctaVocabulary: z.string().max(600).optional(),
          claims: z.string().max(2000).optional(),
          restrictions: z.string().max(1500).optional(),
          market: z.string().trim().min(2).max(3).optional(),
          reason: z.string().max(200).optional(),
        }),
      );
      // The form carries the whole Brand Brain: a field left empty clears it. A new immutable version (with diff +
      // BRAND_BRAIN_VERSIONED), never an in-place overwrite; new brand-wide claims go to each product's vault.
      const r = await t((tx) =>
        updateBrandBrain(tx, ctx, {
          brandId: i.brandId ?? null,
          name: i.name,
          tone: i.tone,
          colors: hexes(i.colors),
          fonts: { heading: i.headingFont || null, body: i.bodyFont || null },
          prohibited: i.prohibited,
          talentTypes: lines(i.talentTypes, 10, 120),
          disclosures: i.disclosures,
          cta: i.cta,
          ctaVocabulary: lines(i.ctaVocabulary, 12, 40),
          claims: lines(i.claims, 20, 200),
          restrictions: lines(i.restrictions, 20, 120),
          market: i.market,
          // The logo and visual references are managed by their own actions: left out, they keep their value.
        }, i.reason?.trim() || null),
      );
      return json({ ok: true, version: r.version, changed: r.changed, claimsProposed: r.claimsProposed });
    }
    case 'brand-create': {
      // Multi-brand plans (PLANS.brands): a new brand with its own Brand Brain.
      const { name } = await body(req, z.object({ name: z.string().trim().min(1).max(80) }));
      const r = await t((tx) => once(tx, { name }, () => createBrand(tx, ctx, name)));
      return json({ ok: true, ...r, next: `/w/${slug}/settings/brand?brand=${r.brandId}` });
    }
    case 'brand-reference-remove': {
      const i = await body(req, z.object({ brandId: uuid, assetId: uuid }));
      const r = await t(async (tx) => {
        const [b] = await tx`select name, brain from brands where id = ${i.brandId} and workspace_id = ${ctx.workspaceId}`;
        if (!b) throw new DomainError('NOT_FOUND', 'Brand not found');
        const brain = toBrain(b.brain);
        return updateBrandBrain(tx, ctx, { ...brain, brandId: i.brandId, name: b.name as string, visualReferenceAssetIds: brain.visualReferenceAssetIds.filter((x) => x !== i.assetId), logoAssetId: brain.logoAssetId === i.assetId ? null : brain.logoAssetId }, 'visual reference removed');
      });
      return json({ ok: true, version: r.version });
    }
    case 'sku-brand': {
      // Which of the workspace's brands a product belongs to (§16 Brand Brain sits above the SKU).
      const i = await body(req, z.object({ skuId: uuid, brandId: uuid }));
      return json({ ok: true, ...(await t((tx) => assignSkuBrand(tx, ctx, i.skuId, i.brandId))) });
    }
    case 'approve-views': {
      // §16 "approved front/side/back views": the reference photos the merchant confirms show today's packaging.
      const i = await body(req, z.object({ skuId: uuid, assetIds: z.array(uuid).max(12) }));
      return json({ ok: true, ...(await t((tx) => approveFingerprintViews(tx, ctx, i.skuId, i.assetIds))) });
    }
    case 'rename': {
      const { name } = await body(req, z.object({ name: z.string().trim().min(1).max(80) }));
      assertCan(ctx, 'billing.manage');
      await t((tx) => tx`update workspaces set name = ${name} where id = ${ctx.workspaceId}`);
      return json({ ok: true });
    }
    /* ── Data ── */
    case 'export':
      await t((tx) => requestExport(tx, ctx));
      return json({ ok: true });
    case 'delete': {
      const { confirm } = await body(req, z.object({ confirm: z.string() }));
      assertCan(ctx, 'workspace.delete');
      if (confirm !== slug) throw new DomainError('INVALID', `Type ${slug} to confirm.`);
      await t((tx) => scheduleDeletion(tx, ctx));
      return json({ ok: true });
    }
    case 'undelete':
      await t((tx) => cancelDeletion(tx, ctx));
      return json({ ok: true });
    default:
      throw new DomainError('NOT_FOUND', 'Unknown action');
  }
});
