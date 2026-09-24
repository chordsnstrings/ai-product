import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { probe, withTempDir, extractFrames, ASPECT_SIZE, type Aspect } from '@arkiv/media';
import { scanCreativeText, scanPasses } from './compliance';
import type { TenantContext } from './context';
import { FidelityCheck } from './intel-schemas';
import { llmJson } from './model-gateway';
import { FIDELITY_SYSTEM } from './prompts';
import { paletteDistance, toJpegBase64 } from './vision';

/**
 * QA Gateway (§25). Provider success is not customer success: every output passes product, visual, claims,
 * audio, platform, experiment-integrity and asset-integrity checks before the merchant sees it.
 * Product identity failures are HARD failures regardless of any average score (§16).
 */

export interface CheckResult {
  check: 'product_fidelity' | 'visual' | 'claims' | 'audio' | 'platform' | 'experiment_integrity' | 'asset_integrity';
  pass: boolean;
  hard: boolean;
  detail: string;
  data?: Record<string, unknown>;
}

export interface SceneQaInput {
  ctx: TenantContext;
  token: string;
  sceneId: string;
  sceneText: string;
  videoBytes?: Buffer;
  frameBytes?: Buffer;
  referenceBytes: Buffer[];
  fingerprint: { labelText: string | null; closure: string | null; paletteDistanceMax: number };
  /** Test hook: markers in the visual plan make the mock inspector fail deterministically. */
  planText: string;
  attempt: number;
}

/** Product fidelity + visual integrity for one rendered scene. */
export async function qaScene(i: SceneQaInput): Promise<CheckResult[]> {
  const frame = i.frameBytes ?? (await withTempDir(async (dir) => {
    const f = path.join(dir, 'v.mp4');
    await writeFile(f, i.videoBytes!);
    const [mid] = await extractFrames(f, 1, dir);
    return sharp(mid!).toBuffer();
  }));
  const dist = i.referenceBytes[0] ? await paletteDistance(frame, i.referenceBytes[0]) : 0;
  const failMock = /\[\[qa:fidelity_always\]\]/.test(i.planText) || (/\[\[qa:fidelity\]\]/.test(i.planText) && i.attempt === 1);
  const insp = await llmJson({
    ctx: i.ctx,
    token: i.token,
    task: 'qa.fidelity',
    subject: { type: 'scene', id: i.sceneId },
    system: FIDELITY_SYSTEM,
    content: [
      ...(await Promise.all(i.referenceBytes.slice(0, 2).map(async (b) => ({ type: 'image' as const, mediaType: 'image/jpeg' as const, base64: await toJpegBase64(b, 768) })))),
      { type: 'image', mediaType: 'image/jpeg', base64: await toJpegBase64(frame, 768) },
      { type: 'text', text: `Reference label text: ${i.fingerprint.labelText ?? 'unknown'}. Closure: ${i.fingerprint.closure ?? 'unknown'}. The last image is the generated frame. Scene: ${i.sceneText}` },
    ],
    schema: FidelityCheck,
    mock: () => ({
      sameProduct: !failMock,
      labelTextMatches: !failMock,
      closureMatches: true,
      colorMatches: true,
      productCount: 1,
      handsOrFacesDeformed: false,
      skinAlteredUnnaturally: false,
      impliesMedicalResult: false,
      notes: failMock ? 'Label text differs from reference' : 'Matches reference',
    }),
    effort: 'medium',
    maxTokens: 800,
  });
  const f = insp.data;
  const identityFail = !f.sameProduct || (!!i.fingerprint.labelText && !f.labelTextMatches) || !f.closureMatches || f.productCount > 1;
  return [
    {
      check: 'product_fidelity',
      pass: !identityFail && f.colorMatches,
      hard: identityFail,
      detail: identityFail ? `Product identity mismatch: ${f.notes}` : f.colorMatches ? 'Product matches reference' : 'Product colour drift',
      data: { ...f, paletteDistance: Math.round(dist) },
    },
    {
      check: 'visual',
      pass: !f.handsOrFacesDeformed && !f.skinAlteredUnnaturally && !f.impliesMedicalResult,
      hard: f.skinAlteredUnnaturally || f.impliesMedicalResult,
      detail: f.handsOrFacesDeformed ? 'Deformed hands or face' : f.skinAlteredUnnaturally ? 'Skin altered unnaturally (possible implied before/after)' : f.impliesMedicalResult ? 'Implies a medical result' : 'No visual defects found',
    },
  ];
}

/**
 * Claims check on everything said or shown (§25 check 3; Launch Gate 3): every material product statement must
 * map to an allowed Claim ID. Blocked or unapproved claims and effect statements that map to no claim both fail
 * hard. The per-line mapping (line → Claim ID, neutral, violation or unmapped) is kept for review and lineage.
 */
export function qaClaims(lines: string[], allowed: { id: string; wording: string; qualifier?: string | null }[], opts: { names?: (string | null | undefined)[] } = {}): CheckResult {
  const scan = scanCreativeText(lines, allowed, opts);
  const pass = scanPasses(scan);
  const used = new Set(scan.mapping.filter((m) => m.status === 'claim').map((m) => m.claimId));
  const problems = [
    ...scan.violations.map((v) => `“${v.text}”: ${v.reason}`),
    ...scan.unmapped.map((u) => `“${u}”: makes a product claim that isn’t approved in your Claims Vault`),
  ];
  return {
    check: 'claims',
    pass,
    hard: !pass,
    detail: pass ? `${lines.length} lines checked; ${used.size} claim${used.size === 1 ? '' : 's'} used, all approved` : problems.join('; '),
    data: { violations: scan.violations, unmapped: scan.unmapped, mapping: scan.mapping, claimsUsed: used.size },
  };
}

/** Platform + audio contract for one export (§25 checks 4–5; §48 wrong duration/format). */
export async function qaExport(file: string, aspect: Aspect, expectedMs: number): Promise<CheckResult[]> {
  const p = await probe(file);
  const { w, h } = ASPECT_SIZE[aspect];
  const sizeOk = p.width === w && p.height === h;
  const durOk = Math.abs(p.durationMs - expectedMs) <= 250;
  const codecOk = p.videoCodec === 'h264' && p.audioCodec === 'aac';
  return [
    {
      check: 'platform',
      pass: sizeOk && durOk && codecOk,
      hard: !sizeOk || !codecOk,
      detail: `${p.width}x${p.height} · ${(p.durationMs / 1000).toFixed(2)}s · ${p.videoCodec}/${p.audioCodec}`,
      data: { aspect, ...p },
    },
    { check: 'audio', pass: p.hasAudio, hard: !p.hasAudio, detail: p.hasAudio ? 'Audio track present, loudness normalized' : 'Missing audio track' },
  ];
}

/**
 * Experiment integrity (§25 check 6): the variant actually changed the intended variable and preserved the
 * held-constant components. `actual.changed` must be *computed* — diffCompositions() over the two composition
 * manifests — never copied from the declaration it is checked against.
 */
export function qaExperimentIntegrity(
  intended: { changed: string[]; heldConstant: string[] } | null,
  actual: { changed: string[] },
): CheckResult {
  if (!intended) return { check: 'experiment_integrity', pass: true, hard: false, detail: 'Standalone production (no controlled comparison)' };
  const missing = intended.changed.filter((c) => !actual.changed.includes(c));
  const leaked = actual.changed.filter((c) => intended.heldConstant.includes(c));
  const pass = !missing.length && !leaked.length;
  return {
    check: 'experiment_integrity',
    pass,
    hard: leaked.length > 0,
    detail: pass ? `Changed ${intended.changed.join(', ') || 'nothing'}; held ${intended.heldConstant.join(', ') || 'nothing'}` : `Missing: ${missing.join(', ') || '—'}; unexpectedly changed: ${leaked.join(', ') || '—'}`,
    data: { intended: intended.changed, heldConstant: intended.heldConstant, actual: actual.changed, missing, leaked },
  };
}

const CHECK_NAMES: readonly CheckResult['check'][] = ['product_fidelity', 'visual', 'claims', 'audio', 'platform', 'experiment_integrity', 'asset_integrity'];
/**
 * Key for a reviewer's verdict on one stored check (plan 05 §13). Several scene checks share a name, so the
 * key carries the check's 1-based position in the stored report.
 */
export const qaVerdictKey = (index: number, check: CheckResult['check']) => `${index + 1}:${check}`;
export const QA_VERDICT_KEY = new RegExp(`^[1-9]\\d{0,2}:(${CHECK_NAMES.join('|')})$`);

export const summarize = (checks: CheckResult[]) => ({
  pass: checks.every((c) => c.pass || !c.hard) && checks.filter((c) => !c.pass).length === 0,
  hardFail: checks.some((c) => !c.pass && c.hard),
  checks,
});
