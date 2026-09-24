import { createHash, randomBytes } from 'node:crypto';
import { globalTx, withTenant, type Tx } from '@arkiv/db';
import { DomainError } from '@arkiv/shared';
import { assertCan } from './authz';
import { brandBrainFor } from './brand';
import { AD_PLATFORMS } from './claims';
import { scanCreativeText, scanPasses } from './compliance';
import { systemContext, type TenantContext } from './context';
import { allowedClaimTexts } from './creative-director';
import { emit } from './events';
import type { Proposal } from './intel-schemas';
import { hit } from './rate-limit';
import { ingestBytes } from './uploads';

/**
 * Creator Packs (standard §26; plan 06 Phase 4 D6 "A7"): a strong hypothesis delivered as a structured brief for a
 * human creator — goal, customer tension, 3 hook options, exact first shot, when the product must be visible, the
 * demonstration shots, approved and forbidden claims, CTA, framing/safe-zone notes and an optional voice-over. The
 * merchant shares it by a private link (14 days, revocable); the creator uploads the footage back through the same
 * link, with a rights attestation, and the footage is linked to the experiment (the Creative Genome picks it up
 * when the merchant uses it). Claims and shot rules stay enforced: nothing blocked or unapproved is ever written
 * into the brief's lines.
 */

export const CREATOR_PACK_DAYS = 14;

export interface CreatorPackContent {
  version: 1;
  productName: string;
  brandName: string | null;
  goal: string;
  customerTension: string | null;
  hooks: string[];
  firstShot: string;
  /** The product must be clearly on screen by this second. */
  productVisibleBySec: number;
  requiredShots: { sec: number; shot: string; say: string | null; onScreen: string | null }[];
  approvedClaims: { wording: string; qualifier: string | null }[];
  /** Never say or imply these (blocked or restricted in the Claims Vault, plus the brand's never-say list). */
  forbiddenClaims: string[];
  cta: string;
  framing: string[];
  voiceover: string | null;
}

const SAFE_ZONE = [
  'Shoot vertical 9:16 (1080×1920), 15–30 seconds, natural light, no filters or skin retouching.',
  'Keep the product and any text inside the centre: leave the top 12% and the bottom 20% clear for the app’s buttons and captions.',
  'Show the label facing camera, sharp and unobstructed, at least once for a full second.',
  'Clearly adult presenters only; no before/after comparisons of skin.',
];

const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

/** Build a pack's content from the experiment, its concept and storyboard, and the Claims Vault. */
export async function creatorPackContent(tx: Tx, experimentId: string): Promise<{ content: CreatorPackContent; skuId: string }> {
  const [e] = await tx`select id, sku_id, hypothesis, expected_learning from experiments where id = ${experimentId}`;
  if (!e) throw new DomainError('NOT_FOUND', 'Experiment not found');
  const skuId = e.sku_id as string;
  // The experiment's master production: its concept (tension, hooks) and storyboard (shots, lines).
  const [p] = await tx`select p.selected_concept_id, p.storyboard_id from variants v join projects p on p.id = v.project_id and p.workspace_id = v.workspace_id
                       where v.experiment_id = ${experimentId} and v.project_id is not null order by v.code limit 1`;
  const [concept] = p?.selected_concept_id ? await tx`select proposal from concepts where id = ${p.selected_concept_id}` : [];
  const proposal = (concept?.proposal ?? null) as Proposal | null;
  const scenes = p?.storyboard_id ? await tx`select purpose, duration_ms, visual_plan, spoken_line, overlay_text from scenes where storyboard_id = ${p.storyboard_id} order by position` : [];
  const [sb] = p?.storyboard_id ? await tx`select hook_text, cta_text from storyboards where id = ${p.storyboard_id}` : [];
  const [sku] = await tx`select name from skus where id = ${skuId}`;
  const brand = await brandBrainFor(tx, skuId);
  const allowed = await allowedClaimTexts(tx, skuId, { platforms: AD_PLATFORMS });
  const names = [sku?.name as string, brand?.name ?? null];
  // A line goes into the brief only if it passes the same claims scan as a rendered ad (§26 "claims remain enforced").
  const safe = (line: string | null | undefined) => (line && scanPasses(scanCreativeText([line], allowed, { names })) ? line : null);
  const forbidden = await tx`select preferred_wording from claims where sku_id = ${skuId} and status in ('BLOCKED', 'RESTRICTED') order by created_at`;
  const hooks = [...new Set([...(proposal?.hookOptions ?? []), sb?.hook_text as string | undefined].map(safe).filter((h): h is string => !!h))].slice(0, 3);
  let t = 0;
  const shots = scenes.map((s) => {
    const shot = { sec: Math.round(t / 100) / 10, shot: String(s.visual_plan), say: safe(s.spoken_line as string | null), onScreen: safe(s.overlay_text as string | null), purpose: s.purpose as string };
    t += Number(s.duration_ms);
    return shot;
  });
  const reveal = shots.find((s) => s.purpose === 'product_reveal') ?? shots.find((s) => s.purpose !== 'hook') ?? null;
  const voiceover = shots.map((s) => s.say).filter(Boolean).join(' ') || null;
  const content: CreatorPackContent = {
    version: 1,
    productName: (sku?.name as string) ?? 'the product',
    brandName: brand?.name ?? null,
    goal: `${e.hypothesis as string}${e.expected_learning ? ` We want to learn: ${e.expected_learning as string}` : ''}`,
    customerTension: proposal?.customerTension ?? null,
    hooks,
    firstShot: shots[0]?.shot ?? `Open on ${(sku?.name as string) ?? 'the product'} in hand, label to camera.`,
    productVisibleBySec: Math.min(3, reveal?.sec ?? 3),
    requiredShots: shots.filter((s) => s.purpose !== 'cta').map(({ purpose: _p, ...s }) => s),
    approvedClaims: allowed.map((c) => ({ wording: c.wording, qualifier: c.qualifier ?? null })),
    forbiddenClaims: [...forbidden.map((f) => f.preferred_wording as string), ...(brand?.brain.prohibited ?? '').split(/[\n,;]+/).map((x) => x.trim())].filter(Boolean),
    cta: safe((sb?.cta_text as string | null) ?? null) ?? brand?.brain.cta ?? 'Shop now',
    framing: SAFE_ZONE,
    voiceover: voiceover ? safe(voiceover) : null,
  };
  return { content, skuId };
}

/**
 * Create a Creator Pack for an experiment and its private link (the token is shown once; only its hash is stored).
 * Tenant role: members who can edit products.
 */
export async function createCreatorPack(tx: Tx, ctx: TenantContext, experimentId: string): Promise<{ id: string; token: string; expiresAt: string }> {
  assertCan(ctx, 'sku.edit');
  const { content, skuId } = await creatorPackContent(tx, experimentId);
  const token = randomBytes(24).toString('base64url');
  const [row] = await tx`insert into creator_packs (workspace_id, experiment_id, content, share_token_hash, expires_at)
                         values (${ctx.workspaceId}, ${experimentId}, ${tx.json(content as never)}, ${tokenHash(token)}, now() + make_interval(days => ${CREATOR_PACK_DAYS}))
                         returning id, expires_at`;
  await emit(tx, ctx, 'CREATOR_PACK_CREATED', { type: 'experiment', id: experimentId }, { creatorPackId: row!.id, expiresAt: new Date(row!.expires_at as string).toISOString() }, { experimentId, skuId });
  return { id: row!.id as string, token, expiresAt: new Date(row!.expires_at as string).toISOString() };
}

/** Revoke a pack's link at once (the creator's page and upload stop working). */
export async function revokeCreatorPack(tx: Tx, ctx: TenantContext, packId: string): Promise<void> {
  assertCan(ctx, 'sku.edit');
  const [r] = await tx`update creator_packs set revoked_at = coalesce(revoked_at, now()) where id = ${packId} and workspace_id = ${ctx.workspaceId} returning id`;
  if (!r) throw new DomainError('NOT_FOUND', 'Creator pack not found');
}

/** An experiment's packs, newest first, with their views and footage uploaded back. */
export async function listCreatorPacks(tx: Tx, experimentId: string) {
  return tx`select c.id, c.expires_at, c.revoked_at, c.views, c.created_at,
                   (select count(*)::int from assets a where a.workspace_id = c.workspace_id and a.kind = 'creator_footage' and a.origin->>'creatorPackId' = c.id::text and a.deleted_at is null) as uploads
            from creator_packs c where c.experiment_id = ${experimentId} order by c.created_at desc`;
}

export interface OpenedPack {
  id: string;
  workspaceId: string;
  experimentId: string;
  content: CreatorPackContent;
  expiresAt: string;
}

/**
 * The public side: a live (not expired, not revoked) pack by its link token, counting the view. Runs as the app
 * role through a security-definer lookup that only ever matches the token's hash — no tenant data is reachable
 * without the token.
 */
export async function openCreatorPack(tx: Tx, token: string, opts: { countView?: boolean } = {}): Promise<OpenedPack | null> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  const [p] = await tx`select id, workspace_id, experiment_id, content, expires_at from open_creator_pack(${tokenHash(token)}, ${opts.countView ?? true})`;
  if (!p) return null;
  return { id: p.id as string, workspaceId: p.workspace_id as string, experimentId: p.experiment_id as string, content: p.content as CreatorPackContent, expiresAt: new Date(p.expires_at as string).toISOString() };
}

/**
 * Footage uploaded back by the creator through a live pack link: validated like any upload (re-encoded, never
 * served from quarantine), stored as creator footage of the pack's product with the creator's rights attestation
 * and the experiment it answers, and held for compliance review when named as a before/after or showing minors.
 */
export async function uploadCreatorFootage(token: string, file: { bytes: Buffer; filename: string }, attestation: { name: string; rightsAttested: boolean }): Promise<{ assetId: string }> {
  if (!attestation.rightsAttested) throw new DomainError('INVALID', 'Please confirm you own this footage and grant the brand the right to use it in ads.');
  const name = attestation.name.trim().slice(0, 120);
  if (!name) throw new DomainError('INVALID', 'Please add your name.');
  const pack = await globalTx((tx) => openCreatorPack(tx, token, { countView: false }));
  if (!pack) throw new DomainError('NOT_FOUND', 'This link has expired or was turned off. Ask the brand for a new one.');
  await hit(`creator-pack-upload:${pack.id}`, 20, 3600);
  // The pack's own workspace, scoped explicitly: the creator has no account, the verified link is the authority.
  return withTenant(pack.workspaceId, async (wtx) => {
    const [e] = await wtx`select sku_id from experiments where id = ${pack.experimentId} and workspace_id = ${pack.workspaceId}`;
    if (!e) throw new DomainError('NOT_FOUND', 'This link has expired or was turned off. Ask the brand for a new one.');
    const ctx = systemContext(pack.workspaceId, `creator-pack:${pack.id}`);
    const asset = await ingestBytes(wtx, ctx, file.bytes, 'creator_footage', e.sku_id as string, {
      filename: file.filename.slice(0, 200),
      creatorPackId: pack.id,
      experimentId: pack.experimentId,
      rights: { attested: true, by: name, at: new Date().toISOString(), scope: 'paid and organic ads for this brand' },
    });
    // Rights and provenance (§23 "Real-asset remix: rights/provenance required"): attested now; the creator has no
    // user account, so who attested is recorded in origin.rights (rights_attested_by names a workspace user).
    await wtx`update assets set rights_attested_at = now() where id = ${asset.id} and workspace_id = ${pack.workspaceId}`;
    return { assetId: asset.id };
  });
}
