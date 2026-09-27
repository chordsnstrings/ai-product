import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import type { Tx } from '@arkiv/db';
import { audioLevel, probe, withTempDir, extractFrames, frameDiffStats, ASPECT_SIZE, boxInside, contrastRatio, safeRect, type Aspect, type PlacedText } from '@arkiv/media';
import { scanCreativeText, scanPasses } from './compliance';
import type { TenantContext } from './context';
import { DEFAULT_FIDELITY_THRESHOLDS, fidelitySignals, labelTextSimilarity, type FidelityThresholds } from './fidelity';
import { ContinuityCheck, FidelityCheck, ImpliedClaimsCheck } from './intel-schemas';
import { llmJson } from './model-gateway';
import { toJpegBase64 } from './vision';

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
  /**
   * The active Visual Fingerprint (§16): OCR label text, closure, dominant colours and its similarity thresholds
   * (`visual_fingerprints.thresholds`), and the product cut-out the deterministic checks locate in the frame.
   */
  fingerprint: { labelText: string | null; closure: string | null; packageType?: string | null; dominantColors?: string[]; liquidColor?: string | null; thresholds?: FidelityThresholds; cutout?: Buffer | null };
  /**
   * Test hook: markers in the visual plan make the mock inspector fail deterministically — [[qa:fidelity]] (first
   * attempt), [[qa:fidelity_always]], [[qa:color]] (wrong product colour), [[qa:minor]] (a person who looks under 18),
   * and on the first attempt [[qa:physics]], [[qa:interaction]] and [[qa:background]] (§25.2 visual defects).
   * ([[mock:flicker]] in the render prompt makes the mock video itself flicker.)
   */
  planText: string;
  attempt: number;
}

/** Frames sampled from a render for inspection: start, middle and end of the clip (§25.2 temporal defects). */
export const RENDER_QA_FRAMES = 3;
/** Flicker score (flickerScore, luma levels) above which a clip's brightness visibly pulses. */
export const FLICKER_MAX = 2;

/** Packaging sold as several units (a set, duo, kit): more than one package in frame is expected, not a wrong count. */
export const multiUnitPackaging = (packageType: string | null | undefined) => /\b(set|kit|duo|trio|bundle|multi-?pack|pack of|\d+\s*-?\s*pack|pair)\b/i.test(packageType ?? '');

/** Product fidelity + visual integrity for one rendered scene or still. */
export async function qaScene(i: SceneQaInput): Promise<CheckResult[]> {
  // A render is judged from frames at its start, middle and end plus its frame-to-frame brightness (flicker); a
  // still is its own single frame.
  const sampled = i.frameBytes
    ? { frames: [i.frameBytes], temporal: null }
    : await withTempDir(async (dir) => {
        const f = path.join(dir, 'v.mp4');
        await writeFile(f, i.videoBytes!);
        const files = await extractFrames(f, RENDER_QA_FRAMES, dir);
        return { frames: await Promise.all(files.map((x) => sharp(x).toBuffer())), temporal: await frameDiffStats(f) };
      });
  const frames = sampled.frames;
  const th = i.fingerprint.thresholds ?? DEFAULT_FIDELITY_THRESHOLDS;
  const multiUnit = multiUnitPackaging(i.fingerprint.packageType);
  // Deterministic signals first (independent of the inspector): shade and package count, in every sampled frame
  // where the exact product can be located. The worst frame decides.
  const perFrame = i.fingerprint.cutout ? await Promise.all(frames.map((fr) => fidelitySignals(fr, i.fingerprint.cutout!, th))) : [];
  const detFailures = perFrame.flatMap((d, n) => d.failures.map((x) => ({ ...x, frame: n + 1 }))).filter((x) => !(multiUnit && x.kind === 'count'));
  const located = perFrame.filter((d) => d.located);
  // One frame: its signals as they are; several: the worst of each across the frames.
  const det = !perFrame.length
    ? null
    : perFrame.length === 1
      ? { ...perFrame[0]!, framesLocated: located.length, failures: detFailures }
      : {
          located: located.length > 0,
          framesLocated: located.length,
          matchScore: Math.max(...perFrame.map((d) => d.matchScore)),
          secondScore: Math.max(...perFrame.map((d) => d.secondScore)),
          productCount: Math.max(...perFrame.map((d) => d.productCount)),
          paletteDistance: located.some((d) => d.paletteDistance != null) ? Math.max(...located.map((d) => d.paletteDistance ?? 0)) : null,
          regionColorDelta: located.some((d) => d.regionColorDelta != null) ? Math.max(...located.map((d) => d.regionColorDelta ?? 0)) : null,
          failures: detFailures,
        };
  const failMock = /\[\[qa:fidelity_always\]\]/.test(i.planText) || (/\[\[qa:fidelity\]\]/.test(i.planText) && i.attempt === 1);
  const colorMock = /\[\[qa:colou?r\]\]/.test(i.planText);
  const minorMock = /\[\[qa:minor\]\]/.test(i.planText);
  const physicsMock = /\[\[qa:physics\]\]/.test(i.planText) && i.attempt === 1;
  const interactionMock = /\[\[qa:interaction\]\]/.test(i.planText) && i.attempt === 1;
  const backgroundMock = /\[\[qa:background\]\]/.test(i.planText) && i.attempt === 1;
  const insp = await llmJson({
    ctx: i.ctx,
    token: i.token,
    task: 'qa.fidelity',
    subject: { type: 'scene', id: i.sceneId },
    inputRefs: { sceneId: i.sceneId, attempt: i.attempt, kind: i.frameBytes ? 'frame' : 'render', frames: frames.length },
    template: 'fidelity',
    content: [
      ...(await Promise.all(i.referenceBytes.slice(0, 2).map(async (b) => ({ type: 'image' as const, mediaType: 'image/jpeg' as const, base64: await toJpegBase64(b, 768) })))),
      ...(await Promise.all(frames.map(async (fr) => ({ type: 'image' as const, mediaType: 'image/jpeg' as const, base64: await toJpegBase64(fr, 768) })))),
      {
        type: 'text',
        text: `Reference label text: ${i.fingerprint.labelText ?? 'unknown'}. Closure: ${i.fingerprint.closure ?? 'unknown'}. Packaging: ${i.fingerprint.packageType ?? 'unknown'}${multiUnit ? ' (sold as several units: more than one package is expected)' : ''}. Reference product colours: ${i.fingerprint.dominantColors?.length ? i.fingerprint.dominantColors.join(', ') : 'unknown'}. Colour of the product itself: ${i.fingerprint.liquidColor ?? 'unknown'}. ${frames.length > 1 ? `The last ${frames.length} images are frames from the start, middle and end of the generated clip.` : 'The last image is the generated frame.'} Scene: ${i.sceneText}`,
      },
    ],
    schema: FidelityCheck,
    mock: () => ({
      sameProduct: !failMock,
      labelTextMatches: !failMock,
      closureMatches: true,
      colorMatches: !colorMock,
      productCount: 1,
      handsOrFacesDeformed: false,
      skinAlteredUnnaturally: false,
      impliesMedicalResult: false,
      apparentMinorPresent: minorMock,
      objectInteractionBroken: interactionMock,
      impossiblePhysics: physicsMock,
      backgroundArtifacts: backgroundMock,
      notes: failMock ? 'Label text differs from reference' : colorMock ? 'Serum colour differs from reference' : physicsMock ? 'The serum drips upward' : 'Matches reference',
      // A failing mock "reads" a drifted label so the review screen's OCR diff has something to show.
      labelTextRead: i.fingerprint.labelText ? (failMock ? i.fingerprint.labelText.split(/\s+/).slice(0, -1).concat('SERUMM').join(' ') : i.fingerprint.labelText) : null,
    }),
    effort: 'medium',
    maxTokens: 800,
  });
  const f = insp.data;
  // Label OCR diff: the text the inspector read against the fingerprint's OCR text, whatever its own verdict.
  const labelSimilarity = i.fingerprint.labelText && f.labelTextRead ? labelTextSimilarity(i.fingerprint.labelText, f.labelTextRead) : null;
  const reasons: string[] = [];
  if (!f.sameProduct) reasons.push('not the same product');
  if (i.fingerprint.labelText && !f.labelTextMatches) reasons.push('label text differs');
  if (labelSimilarity != null && labelSimilarity < th.labelSimilarityMin && f.labelTextMatches) reasons.push(`label reads “${f.labelTextRead}”`);
  if (!f.closureMatches) reasons.push('different closure');
  if (f.productCount > 1 && !multiUnit) reasons.push(`${f.productCount} products in frame`);
  for (const d of detFailures.filter((x) => x.kind === 'count')) reasons.push(d.detail);
  const identityFail = reasons.length > 0;
  // §16: a materially wrong shade is a hard failure regardless of the overall visual score — whether the
  // inspector saw it or the located product's colours moved beyond the fingerprint's thresholds.
  const shade = detFailures.find((x) => x.kind === 'shade') ?? null;
  const colorFail = !f.colorMatches || !!shade;
  const colorDetail = shade?.detail ?? 'Materially wrong shade: the product’s colour differs from the reference';
  // §25.2 visual quality: people, interactions, physics, background and flicker. A minor, unnatural skin change or
  // an implied medical result is hard; the rest is a repairable defect (retry, then the exact product).
  const flicker = sampled.temporal ? Math.round(sampled.temporal.flicker * 100) / 100 : null;
  const defects = [
    f.apparentMinorPresent ? 'A person who may appear under 18 is shown' : null,
    f.skinAlteredUnnaturally ? 'Skin altered unnaturally (possible implied before/after)' : null,
    f.impliesMedicalResult ? 'Implies a medical result' : null,
    f.handsOrFacesDeformed ? 'Deformed hands or face' : null,
    f.objectInteractionBroken ? 'Hands and product don’t interact naturally' : null,
    f.impossiblePhysics ? 'Physically impossible motion' : null,
    f.backgroundArtifacts ? 'Background artifacts' : null,
    flicker != null && flicker > FLICKER_MAX ? `Flicker: brightness pulses between frames (${flicker} > ${FLICKER_MAX})` : null,
  ].filter((x): x is string => !!x);
  return [
    {
      check: 'product_fidelity',
      pass: !identityFail && !colorFail,
      hard: identityFail || colorFail,
      detail: identityFail ? `Product identity mismatch: ${reasons.join('; ')}${f.notes ? ` (${f.notes})` : ''}` : colorFail ? colorDetail : 'Product matches reference',
      data: {
        ...f,
        framesInspected: frames.length,
        multiUnit,
        labelReference: i.fingerprint.labelText,
        labelSimilarity: labelSimilarity == null ? null : Math.round(labelSimilarity * 1000) / 1000,
        deterministic: det,
        paletteDistance: det?.paletteDistance ?? null,
        thresholds: th,
      },
    },
    {
      check: 'visual',
      // §48: synthetic talent must present as clearly adult; anyone who may appear under 18 is a hard failure.
      pass: defects.length === 0,
      hard: f.skinAlteredUnnaturally || f.impliesMedicalResult || !!f.apparentMinorPresent,
      detail: defects.length ? defects.join('; ') : 'No visual defects found',
      data: {
        framesInspected: frames.length,
        flicker,
        flickerMax: FLICKER_MAX,
        handsOrFacesDeformed: f.handsOrFacesDeformed,
        objectInteractionBroken: !!f.objectInteractionBroken,
        impossiblePhysics: !!f.impossiblePhysics,
        backgroundArtifacts: !!f.backgroundArtifacts,
      },
    },
  ];
}

// ───────────── Whole-creative implied claims (standard §25 check 3, §43 "Visual implies a medical result") ─────────────

/**
 * Deterministic implied-claim signals across a whole creative's words and scene descriptions: before/after framing,
 * time-bound outcomes, conditions that disappear, and clinical staging. They complement the model's read of the
 * finished frames and are what the golden set scores (evals.ts `implied.creative`).
 */
const IMPLIED_PATTERNS: { re: RegExp; claim: string }[] = [
  { re: /\bbefore\s*(?:&|and|\/|vs\.?|-)\s*after\b|\bsplit[- ]screen\b[^.]{0,60}\b(?:skin|face)\b/i, claim: 'a before/after outcome' },
  { re: /\b(?:acne|pimples?|blemish(?:es)?|breakouts?|eczema|rosacea|psoriasis|scars?|dark spots?|hyperpigmentation|wrinkles?|redness)\b[^.]{0,40}\b(?:disappears?|vanish(?:es)?|gone|fades? away|clears? up|erased?|melts? away)\b/i, claim: 'a skin condition that disappears' },
  { re: /\b(?:disappears?|vanish(?:es)?|erases?|clears? up)\b[^.]{0,30}\b(?:acne|pimples?|blemish(?:es)?|breakouts?|eczema|rosacea|scars?|dark spots?|wrinkles?|redness)\b/i, claim: 'a skin condition that disappears' },
  { re: /\b(?:in|within|after)\s+(?:just\s+)?(?:\d+|one|two|three|seven|a)\s+(?:days?|nights?|weeks?|hours?)\b[^.]{0,40}\b(?:clear|flawless|transformed|new skin|results?|gone|healed)\b|\bovernight\b[^.]{0,30}\b(?:clear|flawless|transformed|results?|gone|healed)\b/i, claim: 'a guaranteed, time-bound result' },
  { re: /\b(?:clinic|clinical setting|doctor'?s office|lab coat|dermatologist'?s office|hospital|syringe|prescription)\b/i, claim: 'a medical treatment setting' },
  { re: /\b(?:clear|flawless|perfect|transformed|brand[- ]new)\s+skin\b[^.]{0,30}\b(?:in|within)\s+(?:just\s+)?(?:\d+|one|two|three|seven|a)\s+(?:days?|nights?|weeks?|hours?)\b/i, claim: 'a guaranteed, time-bound result' },
  { re: /\bskin\b[^.]{0,30}\b(?:transforms?|visibly changes?|becomes flawless|is completely clear)\b/i, claim: 'a visible skin transformation' },
];

export function impliedClaimSignals(texts: readonly (string | null | undefined)[]): { text: string; claim: string }[] {
  const out: { text: string; claim: string }[] = [];
  for (const t of texts) {
    if (!t) continue;
    for (const p of IMPLIED_PATTERNS) if (p.re.test(t)) out.push({ text: t, claim: p.claim });
  }
  return out;
}

export interface CreativeForReview {
  /** Per scene, in order: what it shows and what it says. */
  scenes: { visualPlan: string | null; spokenLine: string | null; overlayText: string | null }[];
  hook: string | null;
  cta: string | null;
  /** Frames sampled from the finished 9:16 export. */
  frames: Buffer[];
}

/**
 * The implied-claim scan on the whole creative (§43): the script, on-screen text, hook, CTA and scene descriptions
 * together with frames of the finished video, so an implication carried by pictures — or by words and pictures
 * together — is caught, not just a single sentence. A 'block' implication (medical, structure/function or
 * before/after) or a deterministic signal fails hard; 'review' implications are recorded, not blocking.
 */
export async function qaImpliedClaims(ctx: TenantContext, token: string, projectId: string, c: CreativeForReview): Promise<CheckResult> {
  const deterministic = impliedClaimSignals([...c.scenes.flatMap((s) => [s.visualPlan, s.spokenLine, s.overlayText]), c.hook, c.cta]);
  const script = c.scenes.map((s, i) => `Scene ${i + 1}. Shows: ${s.visualPlan ?? '—'} Says: ${s.spokenLine ?? '—'} On screen: ${s.overlayText ?? '—'}`).join('\n');
  const marker = /\[\[qa:implied\]\]/.test(script);
  const res = await llmJson({
    ctx,
    token,
    task: 'qa.implied_claims',
    subject: { type: 'project', id: projectId },
    inputRefs: { projectId, scenes: c.scenes.length, frames: Math.min(4, c.frames.length) },
    template: 'implied-claims',
    content: [
      ...(await Promise.all(c.frames.slice(0, 4).map(async (b) => ({ type: 'image' as const, mediaType: 'image/jpeg' as const, base64: await toJpegBase64(b, 640) })))),
      { type: 'untrusted', sourceId: 'creative', text: `Hook: ${c.hook ?? '—'}\nCall to action: ${c.cta ?? '—'}\n${script}` },
    ],
    schema: ImpliedClaimsCheck,
    // Test hook: a scene marked [[qa:implied]] makes the mock reviewer find an implied medical result in it.
    mock: () => ({
      impliedClaims: marker ? [{ claim: 'The pictures imply the product clears a skin condition', basis: 'combined' as const, severity: 'block' as const, scene: c.scenes.findIndex((s) => /\[\[qa:implied\]\]/.test(`${s.visualPlan} ${s.spokenLine} ${s.overlayText}`)) + 1 || null }] : [],
      notes: marker ? 'Implied treatment result' : 'No implied claims',
    }),
    effort: 'medium',
    maxTokens: 1200,
  });
  const blocking = res.data.impliedClaims.filter((x) => x.severity === 'block');
  const problems = [...deterministic.map((d) => `“${d.text}”: implies ${d.claim}`), ...blocking.map((b) => `${b.scene ? `Scene ${b.scene}: ` : ''}${b.claim} (${b.basis === 'visual' ? 'shown in the pictures' : b.basis === 'combined' ? 'words and pictures together' : 'in the words'})`)];
  const pass = problems.length === 0;
  return {
    check: 'claims',
    pass,
    hard: !pass,
    detail: pass ? `Whole creative checked for implied claims (words and pictures)${res.data.impliedClaims.length ? `; ${res.data.impliedClaims.length} borderline noted` : ''}` : `Implied claim: ${problems.join('; ')}`,
    data: { impliedClaims: res.data.impliedClaims, deterministic, notes: res.data.notes, violations: [...deterministic.map((d) => ({ text: d.text, reason: `Implies ${d.claim}` })), ...blocking.map((b) => ({ text: b.claim, reason: 'Implied claim carried by the pictures or the whole ad' }))], unmapped: [] },
  };
}

// ───────────── Cross-scene continuity of generated people (standard §44, §48) ─────────────

/**
 * Continuity of AI-generated people across scenes: one frame per accepted generated scene that shows a person,
 * compared together. Talent that changes between scenes, or skin that lightens, darkens or clears up, fails —
 * the caller replaces the scenes that break continuity with the exact-product composite rather than retrying
 * (§44 "continuity is not worth endless retries"). Fewer than two such frames need no check.
 */
export async function qaContinuity(ctx: TenantContext, token: string, projectId: string, frames: { sceneId: string; bytes: Buffer; planText: string }[]): Promise<{ check: CheckResult; inconsistentSceneIds: string[] } | null> {
  if (frames.length < 2) return null;
  const marker = frames.findIndex((f, i) => i > 0 && /\[\[qa:continuity\]\]/.test(f.planText));
  const res = await llmJson({
    ctx,
    token,
    task: 'qa.continuity',
    subject: { type: 'project', id: projectId },
    inputRefs: { projectId, sceneIds: frames.slice(0, 6).map((f) => f.sceneId) },
    template: 'continuity',
    content: [
      ...(await Promise.all(frames.slice(0, 6).map(async (f) => ({ type: 'image' as const, mediaType: 'image/jpeg' as const, base64: await toJpegBase64(f.bytes, 640) })))),
      { type: 'text', text: `${frames.length} frames, in scene order. Frame 1 is the reference for the person's appearance.` },
    ],
    schema: ContinuityCheck,
    // Test hook: a later scene marked [[qa:continuity]] shows a different person to the mock reviewer.
    mock: () => ({ talentConsistent: marker < 0, skinToneConsistent: marker < 0, inconsistentFrames: marker < 0 ? [] : [marker + 1], notes: marker < 0 ? 'Same person throughout' : 'Different person and lighter skin' }),
    effort: 'medium',
    maxTokens: 600,
  });
  const d = res.data;
  const ok = d.talentConsistent && d.skinToneConsistent;
  // Only later frames can break continuity with the first; indexes outside the frames are ignored.
  const bad = ok ? [] : [...new Set(d.inconsistentFrames.filter((n) => n >= 2 && n <= frames.length))].map((n) => frames[n - 1]!.sceneId);
  const what = [!d.talentConsistent ? 'the person changes between scenes' : null, !d.skinToneConsistent ? 'skin tone or complexion drifts between scenes' : null].filter(Boolean).join('; ');
  return {
    check: {
      check: 'visual',
      pass: ok,
      hard: false,
      detail: ok ? `Same person and skin tone across ${frames.length} scenes` : `Continuity: ${what}${bad.length ? ` — ${bad.length} scene${bad.length === 1 ? '' : 's'} switched to your exact product` : ''}`,
      data: { continuity: d, inconsistentSceneIds: bad },
    },
    inconsistentSceneIds: bad,
  };
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

/** What a scene render was requested as (the provider's deliverable contract, §48). */
export interface ClipContract {
  seconds: number;
  resolution: '720p' | '1080p';
  ratio: '9:16' | '4:5' | '1:1';
}

/** A clip this much shorter than requested is a wrong deliverable (the composer would freeze or cut the scene). */
export const CLIP_DURATION_TOLERANCE_MS = 250;
const RATIO: Record<ClipContract['ratio'], number> = { '9:16': 9 / 16, '4:5': 4 / 5, '1:1': 1 };
const PLAYABLE_CODECS = new Set(['h264', 'hevc']);

/**
 * The deliverable contract of one provider clip, checked before QA accepts it (standard §48 "Provider returns wrong
 * duration/resolution/format: validate the deliverable contract before QA acceptance; repair/retry"): long enough,
 * at least the requested resolution on its short side, the requested aspect ratio, and a video codec we can compose.
 * A failure is repairable (a retry within the reserve, then the exact-product fallback), never delivered.
 */
export async function qaClipContract(bytes: Buffer, want: ClipContract): Promise<CheckResult> {
  let p: Awaited<ReturnType<typeof probe>> | null = null;
  try {
    p = await withTempDir(async (dir) => {
      const f = path.join(dir, 'clip.mp4');
      await writeFile(f, bytes);
      return probe(f);
    });
  } catch {
    p = null;
  }
  const problems: string[] = [];
  if (!p || !p.width || !p.height || !p.videoCodec) problems.push('not a readable video');
  else {
    if (p.durationMs < want.seconds * 1000 - CLIP_DURATION_TOLERANCE_MS) problems.push(`${(p.durationMs / 1000).toFixed(2)}s instead of ${want.seconds}s`);
    const minSide = want.resolution === '1080p' ? 1080 : 720;
    if (Math.min(p.width, p.height) < minSide) problems.push(`${p.width}x${p.height} is below ${want.resolution}`);
    if (Math.abs(p.width / p.height - RATIO[want.ratio]) > 0.02) problems.push(`${p.width}x${p.height} is not ${want.ratio}`);
    if (!PLAYABLE_CODECS.has(p.videoCodec)) problems.push(`unsupported codec ${p.videoCodec}`);
  }
  const pass = problems.length === 0;
  return {
    check: 'platform',
    pass,
    // Hard: a wrong deliverable is never accepted; the production repairs it (retry, then the exact product).
    hard: !pass,
    detail: pass ? 'Clip matches the requested duration, resolution and format' : `Provider clip does not match the request: ${problems.join('; ')}`,
    data: { requested: want, probe: p },
  };
}

/**
 * Platform + audio contract for one export (§25 checks 4–5; §48 wrong duration/format), and — given the composer's
 * layout — safe-zone placement and caption readability. `expectedMs` is the storyboard's timeline length.
 */
export async function qaExport(file: string, aspect: Aspect, expectedMs: number, layout?: readonly PlacedText[]): Promise<CheckResult[]> {
  const p = await probe(file);
  const { w, h } = ASPECT_SIZE[aspect];
  const sizeOk = p.width === w && p.height === h;
  const durOk = Math.abs(p.durationMs - expectedMs) <= 250;
  const codecOk = p.videoCodec === 'h264' && p.audioCodec === 'aac';
  return [
    {
      check: 'platform',
      pass: sizeOk && durOk && codecOk,
      // §48 "wrong duration": an export of the wrong length is not delivered, like a wrong size or codec.
      hard: !sizeOk || !durOk || !codecOk,
      detail: `${p.width}x${p.height} · ${(p.durationMs / 1000).toFixed(2)}s · ${p.videoCodec}/${p.audioCodec}`,
      data: { aspect, ...p },
    },
    { check: 'audio', pass: p.hasAudio, hard: !p.hasAudio, detail: p.hasAudio ? 'Audio track present, loudness normalized' : 'Missing audio track' },
    ...(layout ? qaLayout(aspect, layout) : []),
  ];
}

/** Captions are set at least this share of the frame width (legible on a phone at arm's length). */
export const CAPTION_MIN_FONT_SHARE = 0.035;
/** WCAG AA contrast for text against its plate. */
export const TEXT_MIN_CONTRAST = 4.5;
/** Reading speed above which a caption is on screen too briefly to read (characters per second). */
export const CAPTION_MAX_CPS = 17;

/**
 * Safe-zone placement and caption readability (§25 platform check): every text element the composer placed —
 * overlays, spoken captions, the end card's name, price, CTA and disclosure — sits inside the aspect's safe zone,
 * is set large enough and contrasts with its plate. Those are hard failures (a CTA under the platform's buttons is a
 * broken ad). A caption that goes by faster than people read is reported, not blocking.
 */
export function qaLayout(aspect: Aspect, layout: readonly PlacedText[]): CheckResult[] {
  const safe = safeRect(aspect);
  const { w } = ASPECT_SIZE[aspect];
  const label = (p: PlacedText) => (p.kind === 'end_card' ? `end card ${p.role}` : p.kind === 'caption' ? `caption “${p.text.slice(0, 40)}”` : `${p.role} text “${p.text.slice(0, 40)}”`);
  const cps = (p: PlacedText) => p.text.length / ((p.endMs - p.startMs) / 1000);
  const outside = layout.filter((p) => !boxInside(p.box, safe));
  const small = layout.filter((p) => (p.kind === 'caption' || p.kind === 'overlay') && p.fontSize < w * CAPTION_MIN_FONT_SHARE);
  const lowContrast = layout.filter((p) => HEX6.test(p.ink) && HEX6.test(p.plate) && contrastRatio(p.ink, p.plate) < TEXT_MIN_CONTRAST);
  const fast = layout.filter((p) => p.kind === 'caption' && p.endMs > p.startMs && cps(p) > CAPTION_MAX_CPS);
  const readable = !small.length && !lowContrast.length;
  const ratio = aspect.replace('x', ':');
  return [
    {
      check: 'platform',
      pass: !outside.length,
      hard: outside.length > 0,
      detail: outside.length ? `Outside the ${ratio} safe zone: ${outside.map(label).join('; ')}` : `${layout.length} text elements inside the ${ratio} safe zone`,
      data: { aspect, safeZone: safe, outside: outside.map((p) => ({ kind: p.kind, role: p.role, box: p.box })) },
    },
    {
      check: 'platform',
      pass: readable && !fast.length,
      hard: !readable,
      detail: !readable
        ? `Hard to read: ${[...small.map((p) => `${label(p)} set at ${p.fontSize}px`), ...lowContrast.map((p) => `${label(p)} has low contrast`)].join('; ')}`
        : fast.length
          ? `Captions go by quickly: ${fast.map((p) => `${label(p)} at ${cps(p).toFixed(0)} characters/s`).join('; ')}`
          : 'Captions and on-screen text large enough, high contrast and at a readable pace',
      data: {
        aspect,
        minFontPx: Math.ceil(w * CAPTION_MIN_FONT_SHARE),
        small: small.map((p) => ({ role: p.role, fontSize: p.fontSize })),
        lowContrast: lowContrast.map((p) => ({ role: p.role, contrast: Math.round(contrastRatio(p.ink, p.plate) * 100) / 100 })),
        fast: fast.map((p) => ({ text: p.text, cps: Math.round(cps(p) * 10) / 10 })),
      },
    },
  ];
}
const HEX6 = /^#[0-9a-f]{6}$/i;


/** What a final export records about how it was made (standard §25.7 "metadata/lineage is complete"). */
export interface ExportProvenance {
  authorizationId: string | null;
  rateTableVersions: Record<string, number>;
  /** Scene versions composed, in timeline order. */
  sceneVersionIds: string[];
  /** Model and prompt version of every generated scene version (render, generated frame or plate). */
  generated: { versionId: string; model: string | null; promptVersion: string | null }[];
  claimIds: string[];
  voiceClipIds: string[];
  composer: string | null;
}

/**
 * Final asset integrity, lineage half (§25.7; Launch Gate 8): the export's provenance names the authorization and the
 * rate tables it was priced on, the composed scene versions, the model and prompt version of every generated one,
 * the Claim IDs, the voice clips (when the ad speaks) and the composer — and each named row exists. A gap is a hard
 * failure: an export we can't account for is not delivered.
 */
export async function assertLineageComplete(tx: Tx, assetId: string, opts: { spoken: boolean }): Promise<CheckResult> {
  const [a] = await tx`select lineage from assets where id = ${assetId}`;
  const pv = ((a?.lineage ?? {}) as { provenance?: Partial<ExportProvenance> }).provenance;
  const missing: string[] = [];
  if (!pv) missing.push('provenance');
  else {
    if (!pv.authorizationId) missing.push('authorization');
    else if (!(await tx`select 1 from cost_authorizations where id = ${pv.authorizationId}`).length) missing.push('authorization row');
    if (!pv.rateTableVersions || !Object.keys(pv.rateTableVersions).length) missing.push('rate table versions');
    if (!pv.sceneVersionIds?.length) missing.push('scene versions');
    else {
      const [n] = await tx`select count(*)::int as n from scene_versions where id = any(${pv.sceneVersionIds}::uuid[])`;
      if (Number(n!.n) !== new Set(pv.sceneVersionIds).size) missing.push('scene version rows');
    }
    for (const g of pv.generated ?? []) if (!g.model || !g.promptVersion) missing.push(`model/prompt version of ${g.versionId.slice(0, 8)}`);
    if (!Array.isArray(pv.claimIds)) missing.push('claim ids');
    if (opts.spoken && !pv.voiceClipIds?.length) missing.push('voice-over clips');
    if (!pv.composer) missing.push('composer version');
  }
  const pass = missing.length === 0;
  return { check: 'asset_integrity', pass, hard: !pass, detail: pass ? 'Lineage complete: authorization, rates, scene versions, models, claims, voice, composer' : `Lineage incomplete: ${missing.join(', ')}`, data: { missing } };
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

/** Mean loudness (dBFS) below which a stretch the voice-over should fill counts as silent. */
export const VOICE_SILENCE_DB = -45;

const words = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}%$.,]+/gu, ' ').replace(/[.,](?=\s|$)/g, '').trim().split(/\s+/).filter(Boolean);

/** The caption text of an SRT, cue by cue. */
export function srtTexts(srt: string): string[] {
  return srt
    .split(/\r?\n\r?\n/)
    .map((b) => b.split(/\r?\n/).filter((l) => l.trim() && !/^\d+$/.test(l.trim()) && !/-->/.test(l)).join(' ').trim())
    .filter(Boolean);
}

/**
 * Audio/transcript QA without a speech-to-text pass (§25.4 "voice and captions match; no accidental claim
 * mutation"): every stretch where the approved script is voiced is audible in the finished export (a clip that was
 * dropped, cut short or lost in the mix leaves silence there), and the delivered captions carry exactly the voiced
 * words, in order. The voiced words themselves are the approved lines the claims check scanned. A failure is hard.
 */
export async function qaVoiceTrack(file: string, segments: readonly { sceneId: string; text: string; startMs: number; endMs: number }[], srt: string): Promise<CheckResult> {
  if (!segments.length) return { check: 'audio', pass: true, hard: false, detail: 'No voice-over in this ad', data: { segments: 0 } };
  const levels = await Promise.all(segments.map((s) => audioLevel(file, s.startMs, s.endMs)));
  const silent = segments.map((s, i) => ({ n: i + 1, sceneId: s.sceneId, level: levels[i]! })).filter((x) => !(x.level >= VOICE_SILENCE_DB));
  const voiced = segments.flatMap((s) => words(s.text));
  const captioned = srtTexts(srt).flatMap(words);
  const captionsMatch = voiced.join(' ') === captioned.join(' ');
  const problems = [
    ...silent.map((x) => `the voice-over is missing in line ${x.n}`),
    ...(captionsMatch ? [] : ['the captions don’t match the voiced script']),
  ];
  const pass = problems.length === 0;
  return {
    check: 'audio',
    pass,
    hard: !pass,
    detail: pass ? `Voice-over audible in all ${segments.length} lines; captions match the voiced script` : `Voice-over: ${problems.join('; ')}`,
    data: { segments: segments.length, levels: levels.map((l) => (Number.isFinite(l) ? l : null)), silent, captionsMatch, voicedWords: voiced.length, captionWords: captioned.length },
  };
}
