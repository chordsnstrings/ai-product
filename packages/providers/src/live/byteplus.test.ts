import { afterEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { ProviderError } from '../types';
import { SeedreamCutout } from './byteplus';

const STRIPES = ['#D94F30', '#2E7D32', '#1565C0', '#F9A825', '#6A1B9A', '#00838F'];

async function bottle(back: string, dx = 0) {
  const bg = back === 'busy' ? Array.from({ length: 25 }, (_, i) => `<rect x="${i * 40}" y="0" width="40" height="1250" fill="${STRIPES[i % 6]}"/>`).join('') : `<rect width="1000" height="1250" fill="${back}"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1250">${bg}<g transform="translate(${dx} 0)">
    <rect x="455" y="170" width="90" height="90" rx="40" fill="#111"/><rect x="330" y="360" width="340" height="620" rx="36" fill="#C9A27E"/></g></svg>`;
  return sharp(Buffer.from(svg)).removeAlpha().png().toBuffer();
}

afterEach(() => vi.unstubAllGlobals());

describe('Seedream background removal (plan 06 Phase 1 #6)', () => {
  it('asks for the product on a flat backdrop and cuts the photo with the keyed mask', async () => {
    const edited = await bottle('#00B140');
    const calls: { url: string; body?: Record<string, unknown> }[] = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(init.body as string) : undefined });
      if (url.endsWith('/images/generations')) return new Response(JSON.stringify({ model: 'seedream-5-0-pro-260628', id: 'img-1', created: 1, data: [{ url: 'https://cdn.example/out.png?X-Sig=secret' }] }), { status: 200 });
      return new Response(new Uint8Array(edited), { status: 200 });
    });
    const r = await new SeedreamCutout('key', 'https://ark.example/api/v3/').removeBackground({ model: 'seedream-5-0-pro-260628', image: await bottle('busy') });
    expect(calls.map((c) => c.url)).toEqual(['https://ark.example/api/v3/images/generations', 'https://cdn.example/out.png?X-Sig=secret']);
    const body = calls[0]!.body!;
    expect(body).toMatchObject({ model: 'seedream-5-0-pro-260628', response_format: 'url', watermark: false });
    // The backdrop is chosen to be unlike the photo's centre (here: not the green stripes behind the bottle).
    const hex = /flat, uniform (?:chroma green|magenta|blue) colour \((#[0-9A-F]{6})\)/.exec(body.prompt as string)?.[1];
    expect(hex).toBe('#FF00FF');
    expect(body.prompt).toMatch(/Keep the product itself exactly as it is/);
    expect((body.image as string[])[0]).toMatch(/^data:image\/jpeg;base64,/);
    const [w, h] = (body.size as string).split('x').map(Number);
    expect(w! % 8).toBe(0);
    expect(h! % 8).toBe(0);
    expect(w! / h!).toBeCloseTo(1000 / 1250, 2);
    expect(r).toMatchObject({ aligned: true, technique: 'seedream_edit+key', modelVersion: 'seedream-5-0-pro-260628', providerRequestId: 'img-1' });
    expect(r.rawMeta).toMatchObject({ id: 'img-1', backdrop: hex });
    expect(JSON.stringify(r.rawMeta)).not.toContain('X-Sig'); // the signed URL is never kept
    expect((await sharp(r.png).metadata()).hasAlpha).toBe(true);
  });

  it('reports an edit that moved the product as not aligned, and provider errors by kind', async () => {
    const moved = await bottle('#00B140', 200);
    vi.stubGlobal('fetch', async (url: string) =>
      url.endsWith('/images/generations') ? new Response(JSON.stringify({ id: 'img-2', data: [{ url: 'https://cdn.example/m.png' }] }), { status: 200 }) : new Response(new Uint8Array(moved), { status: 200 }),
    );
    const r = await new SeedreamCutout('key', 'https://ark.example/api/v3').removeBackground({ model: 'm', image: await bottle('busy') });
    expect(r.aligned).toBe(false);

    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: { code: 'RateLimitExceeded', message: 'slow down' } }), { status: 429 }));
    const e = await new SeedreamCutout('key', 'https://ark.example/api/v3').removeBackground({ model: 'm', image: await bottle('busy') }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ProviderError);
    expect(e).toMatchObject({ kind: 'rate_limit', retryable: true });
  });
});
