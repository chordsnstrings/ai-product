import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool, withTenant } from '@arkiv/db';
import { makeTenant, truncateAll } from '@arkiv/db/testing';
import { ffmpeg, flickerScore, frameDiffStats, placeholderFrame, stillToClip, withTempDir } from '@arkiv/media';
import { MockVideo } from '@arkiv/providers';
import { newId } from '@arkiv/shared';
import { authorize } from './cost-governor';
import { routedLines } from './model-gateway';
import { FLICKER_MAX, multiUnitPackaging, qaScene, RENDER_QA_FRAMES } from './qa';
import { ctxFor, productPhoto } from './testing';

/** Standard §25.1–25.2: a render is judged across its length — flicker, physics, interaction, background. */
beforeEach(truncateAll);
afterAll(closeAll);

async function clip(opts: { flicker?: boolean } = {}): Promise<Buffer> {
  return withTempDir(async (dir) => {
    const png = path.join(dir, 'f.png');
    await writeFile(png, await placeholderFrame('render', '9x16', 2));
    const out = path.join(dir, 'v.mp4');
    await stillToClip(png, 2000, '9x16', out, 'push');
    if (!opts.flicker) return readFile(out);
    const flick = path.join(dir, 'flick.mp4');
    await ffmpeg(['-i', out, '-vf', "eq=brightness='if(mod(n,2),-0.3,0)':eval=frame,format=yuv420p", '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', flick]);
    return readFile(flick);
  });
}

async function inspect(videoBytes: Buffer, planText: string, fingerprint: Record<string, unknown> = {}) {
  const t = await makeTenant({ plan: 'GROWTH', state: 'ACTIVE_PAID' });
  const ctx = ctxFor(t.workspaceId, t.userId, 'OWNER', 'ACTIVE_PAID');
  const lines = await withTenant(t.workspaceId, (tx) => routedLines(tx, t.workspaceId, [{ task: 'qa.fidelity', kind: 'llm', inputTokens: 40_000, outputTokens: 8_000 }]));
  const a = await withTenant(t.workspaceId, (tx) => authorize(tx, ctx, { purpose: 'creative_test', lines, idempotencyKey: `qa:${newId()}` }));
  const photo = await productPhoto();
  const res = await qaScene({ ctx, token: a.token, sceneId: newId(), sceneText: 'Hands apply the serum', videoBytes, referenceBytes: [photo], fingerprint: { labelText: 'GLOW SERUM', closure: 'dropper', ...fingerprint }, planText, attempt: 1 });
  return { res, workspaceId: t.workspaceId };
}

describe('flicker metric', () => {
  it('counts brightness that goes one way and straight back, not a cut or a steady fade', () => {
    expect(flickerScore([100, 100, 100, 100])).toBe(0);
    expect(flickerScore([100, 102, 104, 106, 108])).toBe(0);
    expect(flickerScore([100, 100, 160, 160, 160])).toBe(0);
    expect(flickerScore([100, 140, 100, 140, 100])).toBe(40);
  });
  it('measures a real clip: a push-in is steady, a pulsing clip flickers', async () => {
    await withTempDir(async (dir) => {
      const steady = path.join(dir, 's.mp4');
      const pulsing = path.join(dir, 'p.mp4');
      await writeFile(steady, await clip());
      await writeFile(pulsing, await clip({ flicker: true }));
      const a = await frameDiffStats(steady);
      const b = await frameDiffStats(pulsing);
      expect(a.frames).toBe(60);
      expect(a.flicker).toBeLessThan(FLICKER_MAX);
      expect(b.flicker).toBeGreaterThan(FLICKER_MAX * 5);
    });
  });
  it('the mock video provider renders a flickering clip on request (test hook for production QA)', async () => {
    const v = new MockVideo(0);
    const { providerRequestId } = await v.submit({ model: 'm', prompt: 'Hands apply the serum [[mock:flicker]]', references: [], seconds: 2, resolution: '720p', ratio: '9:16' });
    const r = await v.poll(providerRequestId);
    await withTempDir(async (dir) => {
      const f = path.join(dir, 'm.mp4');
      await writeFile(f, r.bytes!);
      expect((await frameDiffStats(f)).flicker).toBeGreaterThan(FLICKER_MAX);
    });
  });
});

describe('render QA across the clip (§25.2)', () => {
  it('inspects three frames from start, middle and end of a render, and a steady clip passes', async () => {
    const { res, workspaceId } = await inspect(await clip(), 'Hands apply the serum');
    expect(res.map((c) => c.pass)).toEqual([true, true]);
    expect(res[0]!.data).toMatchObject({ framesInspected: RENDER_QA_FRAMES, labelReference: 'GLOW SERUM', labelTextRead: 'GLOW SERUM', labelSimilarity: 1 });
    expect(res[1]!.data).toMatchObject({ framesInspected: 3, flicker: expect.any(Number) });
    const [job] = await ownerPool()`select input_refs from provider_jobs where workspace_id = ${workspaceId} and task = 'qa.fidelity'`;
    expect(job!.input_refs).toMatchObject({ kind: 'render', frames: 3 });
  });

  it('a flickering render fails visual QA as a repairable defect', async () => {
    const [, visual] = (await inspect(await clip({ flicker: true }), 'Hands apply the serum')).res;
    expect(visual).toMatchObject({ check: 'visual', pass: false, hard: false });
    expect(visual!.detail).toMatch(/Flicker: brightness pulses between frames/);
  });

  it('impossible physics, broken hand–product interaction and background artifacts fail visual QA (retry, then the exact product)', async () => {
    const [, physics] = (await inspect(await clip(), 'Serum drips [[qa:physics]]')).res;
    expect(physics).toMatchObject({ pass: false, hard: false, detail: 'Physically impossible motion', data: { impossiblePhysics: true } });
    const [, touch] = (await inspect(await clip(), 'Fingers hold the bottle [[qa:interaction]]')).res;
    expect(touch!.detail).toBe('Hands and product don’t interact naturally');
    const [, bg] = (await inspect(await clip(), 'A bathroom shelf [[qa:background]]')).res;
    expect(bg!.detail).toBe('Background artifacts');
  });

  it('a drifted label read on the frames is a hard identity failure with the OCR diff recorded', async () => {
    const [fid] = (await inspect(await clip(), 'Hands apply the serum [[qa:fidelity]]', { labelText: 'GLOW BARRIER SERUM' })).res;
    expect(fid).toMatchObject({ pass: false, hard: true });
    expect(fid!.data).toMatchObject({ labelReference: 'GLOW BARRIER SERUM', labelTextRead: 'GLOW BARRIER SERUMM' });
  });

  it('several packages in frame are expected for a set, a wrong count otherwise', () => {
    for (const t of ['duo set', 'Gift set', 'travel kit', '3-pack', 'Trio']) expect(multiUnitPackaging(t)).toBe(true);
    for (const t of ['dropper bottle', 'jar', 'tube', 'pump bottle', null]) expect(multiUnitPackaging(t)).toBe(false);
  });
});
