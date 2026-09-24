import sharp from 'sharp';
import type { Tx } from '@arkiv/db';
import { keyBackground, type KeyedCutout } from '@arkiv/media';
import { DomainError } from '@arkiv/shared';

function dist(a: number[], b: number[]) {
  return Math.sqrt((a[0]! - b[0]!) ** 2 + (a[1]! - b[1]!) ** 2 + (a[2]! - b[2]!) ** 2);
}

/**
 * Deterministic image helpers. The product cut-out (design M3, conversion L3) starts with border-colour keying:
 * product photos are usually shot on a plain background. If keying is unreliable the original is returned framed
 * on paper rather than a damaged cut-out (product fidelity outranks spectacle); a background-removal provider
 * then gets a chance at it where the cut-out is first used (see cutout.ts).
 */
export async function cutout(input: Buffer): Promise<KeyedCutout> {
  return keyBackground(input);
}

/** Dominant colours (hex) via coarse quantization; used by the Visual Fingerprint (§16). */
export async function dominantColors(input: Buffer, k = 4): Promise<string[]> {
  const { data, info } = await sharp(input).flatten({ background: '#ffffff' }).resize(48, 48, { fit: 'inside' }).raw().toBuffer({ resolveWithObject: true });
  const counts = new Map<string, number>();
  for (let i = 0; i < info.width * info.height; i++) {
    const q = [0, 1, 2].map((c) => Math.min(255, Math.round(data[i * info.channels + c]! / 32) * 32));
    const key = q.join(',');
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, k)
    .map(([rgb]) => '#' + rgb.split(',').map((v) => Number(v).toString(16).padStart(2, '0')).join(''));
}

/** Mean colour distance between two images' palettes — a cheap, deterministic fidelity signal. */
export async function paletteDistance(a: Buffer, b: Buffer): Promise<number> {
  const [pa, pb] = await Promise.all([dominantColors(a, 3), dominantColors(b, 3)]);
  const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const ds = pa.map((c) => Math.min(...pb.map((d) => dist(rgb(c), rgb(d)))));
  return ds.reduce((s, d) => s + d, 0) / Math.max(1, ds.length);
}

export async function toJpegBase64(input: Buffer, maxEdge = 1024): Promise<string> {
  return (await sharp(input).rotate().flatten({ background: '#ffffff' }).resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer()).toString('base64');
}

export async function toDataUrl(input: Buffer): Promise<string> {
  return `data:image/jpeg;base64,${await toJpegBase64(input, 1536)}`;
}

// ───────────── Before/after and possible minors (plan 05 §14; standard §48) ─────────────

export interface MediaReviewFlags {
  beforeAfter: boolean;
  possibleMinor: boolean;
  /** What raised the flag: the product analyst looking at the photo, the file's name/source, or the merchant. */
  sources: ('vision' | 'name' | 'merchant')[];
}

/**
 * Standard §43 "Before/after images: require provenance/permission and separate policy review". A merchant who
 * uploads a before/after declares it and attests all three; the media is then held for compliance review like any
 * flagged media. Declaring without every attestation is refused.
 */
export const BEFORE_AFTER_ATTESTATIONS = ['consent', 'unretouched', 'same_conditions'] as const;
export type BeforeAfterAttestation = { consent: true; unretouched: true; sameConditions: true; attestedAt: string };

/** Form values (`before_after` + the attestations) → the attestation to store on the asset, or null when undeclared. */
export function beforeAfterAttestation(values: readonly string[]): BeforeAfterAttestation | null {
  if (!values.includes('before_after')) return null;
  const missing = BEFORE_AFTER_ATTESTATIONS.filter((k) => !values.includes(k));
  if (missing.length) {
    throw new DomainError('INVALID', 'A before/after needs the pictured person’s written permission, unretouched images, and both photos taken under the same conditions. Confirm all three, or leave it out.');
  }
  return { consent: true, unretouched: true, sameConditions: true, attestedAt: new Date().toISOString() };
}

/** The attestation recorded on an asset's origin, if complete. */
export function attestationOf(origin: unknown): BeforeAfterAttestation | null {
  const a = (origin as { beforeAfter?: Partial<BeforeAfterAttestation> } | null)?.beforeAfter;
  return a && a.consent === true && a.unretouched === true && a.sameConditions === true ? (a as BeforeAfterAttestation) : null;
}

/** Review flags for a merchant upload: what its name raises, plus a declared before/after. */
export function uploadReviewFlags(origin: Record<string, unknown>): MediaReviewFlags {
  const named = nameReviewFlags(JSON.stringify({ ...origin, beforeAfter: undefined }));
  const declared = !!attestationOf(origin);
  const sources: MediaReviewFlags['sources'] = [];
  if (named.beforeAfter || named.possibleMinor) sources.push('name');
  if (declared) sources.push('merchant');
  return { beforeAfter: named.beforeAfter || declared, possibleMinor: named.possibleMinor, sources: sources.length ? sources : ['name'] };
}

const BEFORE_AFTER = /\bbefore\s*(?:and|&|\+|\/|-|_|vs\.?)?\s*after\b|\bb4\s*(?:&|and|-|_)?\s*after\b/i;
const MINOR = /\b(kids?|child(?:ren)?|teens?|teenagers?|bab(?:y|ies)|toddlers?|minors?|under[-\s]?18|youth)\b/i;

/** Flags a file name, URL or caption raises on its own (cheap, deterministic; the analyst's look comes on top). */
export function nameReviewFlags(text: string | null | undefined): Pick<MediaReviewFlags, 'beforeAfter' | 'possibleMinor'> {
  const t = (text ?? '').replace(/[_+]/g, ' ');
  return { beforeAfter: BEFORE_AFTER.test(t), possibleMinor: MINOR.test(t) };
}

/**
 * Hold flagged merchant media for compliance review: it stays `pending` (never used in production) until staff
 * approve or reject it. Media already decided keeps its decision. Returns the ids newly held.
 */
export async function holdForReview(tx: Tx, items: { assetId: string; flags: MediaReviewFlags }[]): Promise<string[]> {
  const held: string[] = [];
  for (const { assetId, flags } of items) {
    if (!flags.beforeAfter && !flags.possibleMinor) continue;
    const [r] = await tx`update assets set review_flags = ${tx.json(flags as never)}, review_status = 'pending'
                         where id = ${assetId} and review_status is null returning id`;
    if (r) held.push(r.id as string);
  }
  return held;
}

/**
 * The given assets minus media that can't go into new production, in the same order: held for review or rejected by
 * compliance (plan 05 §14), usage rights expired (standard §48 creator rights expiry), or frozen by an open
 * takedown case (plan 05 §15).
 */
export async function usableAssetIds(tx: Tx, ids: string[]): Promise<string[]> {
  if (!ids.length) return [];
  const blocked = new Set(
    (
      await tx`select id from assets where id = any(${ids}::uuid[])
                 and (review_status in ('pending', 'rejected') or rights_frozen_at is not null or rights_expires_at <= now() or deleted_at is not null)`
    ).map((r) => r.id as string),
  );
  return ids.filter((id) => !blocked.has(id));
}
