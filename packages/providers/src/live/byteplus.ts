import { backdropFor, cutoutFromFlatBackdrop } from '@arkiv/media';
import type {
  ImageProvider,
  ImageRequest,
  ImageResult,
  SegmentationProvider,
  SegmentationRequest,
  SegmentationResult,
  TtsProvider,
  TtsRequest,
  TtsResult,
  VideoPoll,
  VideoProvider,
  VideoRequest,
} from '../types';
import { ProviderError } from '../types';

/**
 * Endpoint paths each live adapter calls, pinned here so contract tests assert them (standard §51
 * "schema-version checks"): ModelArk API v3 (images, video tasks), MiniMax T2A v2, Seed Speech TTS 2.0.
 */
export const PROVIDER_API_PATHS = {
  arkImages: 'images/generations',
  arkVideoTasks: 'contents/generations/tasks',
  minimaxTts: '/v1/t2a_v2',
  seedSpeechResource: 'seed-tts-2.0',
} as const;

/** A response missing what the adapter reads: never guessed at, reported as a changed provider schema. */
const schemaChanged = (provider: string, what: string) => new ProviderError(provider, `unexpected response: ${what}`, false, 'schema_changed');

/**
 * BytePlus ModelArk: Seedream (sync images, POST /images/generations) and Seedance (async tasks,
 * POST/GET /contents/generations/tasks). Video parameters ride in the prompt text as `--flag value`.
 * Returned URLs expire, so bytes are downloaded immediately and stored in our own bucket (§39).
 */
class ArkClient {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string,
  ) {}

  async call<T>(pathName: string, method: 'GET' | 'POST' | 'DELETE', body?: unknown, timeoutMs = 180_000): Promise<T> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/${pathName}`, {
        method,
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
      const text = await res.text();
      let json: Record<string, unknown> = {};
      try {
        json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
      } catch {
        // A gateway error page is classified by its status below; a 2xx that isn't JSON is a changed contract.
        if (res.ok) throw schemaChanged('byteplus', 'body is not JSON');
      }
      if (!res.ok) {
        const err = (json.error ?? {}) as { code?: string; message?: string };
        const code = err.code ?? String(res.status);
        const kind = res.status === 429 ? 'rate_limit' : res.status === 401 || res.status === 403 ? 'auth'
          : /Sensitive|Moderation|Risk/i.test(code) ? 'moderation' : res.status >= 500 ? 'server' : 'invalid';
        throw new ProviderError('byteplus', `${code}: ${err.message ?? text.slice(0, 300)}`, res.status === 429 || res.status >= 500, kind);
      }
      return json as T;
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      if ((e as Error).name === 'AbortError') throw new ProviderError('byteplus', 'request timed out', true, 'timeout');
      throw new ProviderError('byteplus', (e as Error).message, true, 'unknown');
    } finally {
      clearTimeout(t);
    }
  }
}

async function download(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new ProviderError('byteplus', `download failed ${res.status}`, true, 'server');
  return Buffer.from(await res.arrayBuffer());
}

export class SeedreamImage implements ImageProvider {
  readonly name = 'byteplus';
  private readonly ark: ArkClient;
  constructor(apiKey: string, baseUrl: string) {
    this.ark = new ArkClient(apiKey, baseUrl);
  }
  async generate(req: ImageRequest): Promise<ImageResult> {
    const r = await this.ark.call<{ model?: string; data: { url?: string }[]; id?: string; usage?: unknown; created?: number }>(PROVIDER_API_PATHS.arkImages, 'POST', {
      model: req.model,
      prompt: req.prompt,
      size: `${req.width}x${req.height}`,
      response_format: 'url',
      watermark: false,
      ...(req.references.length ? { image: req.references } : {}),
      ...(req.seed != null ? { seed: req.seed } : {}),
    });
    if (!Array.isArray(r.data)) throw schemaChanged('byteplus', 'no data array');
    const url = r.data[0]?.url;
    if (!url) throw new ProviderError('byteplus', 'no image returned', true, 'server');
    return {
      bytes: await download(url),
      mime: 'image/jpeg',
      model: req.model,
      modelVersion: r.model ?? req.model,
      providerRequestId: r.id ?? url.split('?')[0]!.split('/').pop()!,
      // The signed download URL is not kept (it grants access); the output is already in our storage.
      rawMeta: { id: r.id ?? null, model: r.model ?? null, created: r.created ?? null, usage: r.usage ?? null, images: r.data.length },
    };
  }
}

/**
 * The background-removal edit (task `vision.cutout`, prompt cutout@1.0.0). The product must stay exactly where
 * and as it is; only the background changes, to one flat colour chosen to be unlike the product.
 */
export const cutoutPrompt = (backdrop: { name: string; hex: string }) =>
  `Replace the entire background of this product photo with one perfectly flat, uniform ${backdrop.name} colour (${backdrop.hex}) ` +
  'from edge to edge: no gradient, shadow, reflection, surface, props, hands or text. Keep the product itself exactly as it is — ' +
  'same position, size, angle, shape, colours, label text and lighting. Do not add, remove, move or redraw anything on the product.';

/**
 * Background removal on Seedream (plan 06 Phase 1 #6): an image edit that puts the product on a flat backdrop,
 * sized like the photo; the backdrop is keyed here and the mask is applied to the photo's own pixels. An edit that
 * moved or redrew the product is reported as not aligned rather than used.
 */
export class SeedreamCutout implements SegmentationProvider {
  readonly name = 'byteplus';
  private readonly ark: ArkClient;
  constructor(apiKey: string, baseUrl: string) {
    this.ark = new ArkClient(apiKey, baseUrl);
  }
  async removeBackground(req: SegmentationRequest): Promise<SegmentationResult> {
    const sharp = (await import('sharp')).default;
    const meta = await sharp(req.image).metadata();
    const [w0, h0] = (meta.orientation ?? 1) >= 5 ? [meta.height ?? 1024, meta.width ?? 1024] : [meta.width ?? 1024, meta.height ?? 1024];
    // The photo's aspect ratio at 1–4 megapixels in multiples of 8 (a planning assumption for Seedream's size
    // limits); the edit is resized back onto the photo for keying anyway.
    const scale = Math.min(2048 / Math.max(w0, h0), Math.max(1, Math.sqrt(1_048_576 / (w0 * h0))));
    const size = (v: number) => Math.max(512, Math.round((v * scale) / 8) * 8);
    const backdrop = await backdropFor(req.image);
    const jpeg = await sharp(req.image).rotate().flatten({ background: '#ffffff' }).jpeg({ quality: 90 }).toBuffer();
    const r = await this.ark.call<{ model?: string; data: { url?: string }[]; id?: string; usage?: unknown; created?: number }>(PROVIDER_API_PATHS.arkImages, 'POST', {
      model: req.model,
      prompt: cutoutPrompt(backdrop),
      image: [`data:image/jpeg;base64,${jpeg.toString('base64')}`],
      size: `${size(w0)}x${size(h0)}`,
      response_format: 'url',
      watermark: false,
    });
    if (!Array.isArray(r.data)) throw schemaChanged('byteplus', 'no data array');
    const url = r.data[0]?.url;
    if (!url) throw new ProviderError('byteplus', 'no image returned', true, 'server');
    const cut = await cutoutFromFlatBackdrop(req.image, await download(url));
    return {
      png: cut.png,
      mask: cut.mask,
      coverage: cut.coverage,
      aligned: cut.aligned,
      technique: 'seedream_edit+key',
      model: req.model,
      modelVersion: r.model ?? req.model,
      providerRequestId: r.id ?? url.split('?')[0]!.split('/').pop()!,
      rawMeta: { id: r.id ?? null, model: r.model ?? null, created: r.created ?? null, usage: r.usage ?? null, backdrop: backdrop.hex, drift: Math.round(cut.drift) },
    };
  }
}

export class SeedanceVideo implements VideoProvider {
  readonly name = 'byteplus';
  private readonly ark: ArkClient;
  /**
   * @param maxRefs how many reference images a request carries (the model takes many multimodal references, §24):
   *   the scene frame first, then the product's own views, so a request over the cap keeps the most important.
   */
  constructor(
    apiKey: string,
    baseUrl: string,
    private readonly maxRefs = 9,
  ) {
    this.ark = new ArkClient(apiKey, baseUrl);
  }
  async submit(req: VideoRequest): Promise<{ providerRequestId: string }> {
    const flags = [`--duration ${req.seconds}`, `--resolution ${req.resolution}`, `--ratio ${req.ratio}`, '--watermark false'];
    if (req.seed != null) flags.push(`--seed ${req.seed}`);
    const content: unknown[] = [{ type: 'text', text: `${req.prompt} ${flags.join(' ')}` }];
    for (const ref of req.references.slice(0, this.maxRefs)) content.push({ type: 'image_url', image_url: { url: ref }, role: 'reference_image' });
    const r = await this.ark.call<{ id?: string }>(PROVIDER_API_PATHS.arkVideoTasks, 'POST', { model: req.model, content });
    if (!r.id) throw schemaChanged('byteplus', 'video task without id');
    return { providerRequestId: r.id };
  }
  async poll(id: string): Promise<VideoPoll> {
    const r = await this.ark.call<{
      status: VideoPoll['status'];
      model?: string;
      content?: { video_url?: string };
      error?: { message?: string };
      [k: string]: unknown;
    }>(`${PROVIDER_API_PATHS.arkVideoTasks}/${encodeURIComponent(id)}`, 'GET');
    if (!['queued', 'running', 'succeeded', 'failed', 'cancelled'].includes(String(r.status))) throw schemaChanged('byteplus', `task status ${JSON.stringify(r.status)}`);
    // Everything the provider says about the task except the signed output URL (usage, seed, duration, timings).
    const { content: _content, ...rawMeta } = r;
    void _content;
    if (r.status === 'succeeded') {
      const url = r.content?.video_url;
      if (!url) return { status: 'failed', error: 'succeeded without video_url', rawMeta };
      return { status: 'succeeded', bytes: await download(url), modelVersion: r.model, rawMeta };
    }
    // A task that failed after generating reports the seconds it produced (billed); anything else bills nothing.
    const usage = r.usage as { duration?: number; video_duration?: number } | undefined;
    const seconds = Number(usage?.duration ?? usage?.video_duration ?? 0);
    return { status: r.status, error: r.error?.message, rawMeta, ...(r.status === 'failed' && seconds > 0 ? { outputSeconds: seconds } : {}) };
  }
  async cancel(id: string): Promise<void> {
    await this.ark.call(`${PROVIDER_API_PATHS.arkVideoTasks}/${encodeURIComponent(id)}`, 'DELETE');
  }
}

/** MiniMax T2A v2 (non-streaming). Audio comes back hex-encoded. */
export class MiniMaxTts implements TtsProvider {
  readonly name = 'minimax';
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string,
  ) {}
  async synthesize(req: TtsRequest): Promise<TtsResult> {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}${PROVIDER_API_PATHS.minimaxTts}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: req.model,
        text: req.text,
        stream: false,
        voice_setting: { voice_id: req.voice, speed: req.speed ?? 1, vol: 1, pitch: 0 },
        audio_setting: { sample_rate: 44100, bitrate: 128000, format: 'mp3', channel: 1 },
        language_boost: 'English',
      }),
    });
    const j = (await res.json().catch(() => ({}))) as {
      data?: { audio?: string };
      extra_info?: { audio_length?: number; usage_characters?: number };
      base_resp?: { status_code: number; status_msg: string };
      trace_id?: string;
    };
    if (!res.ok || (j.base_resp && j.base_resp.status_code !== 0)) {
      const msg = j.base_resp?.status_msg ?? `HTTP ${res.status}`;
      const kind = res.status === 429 ? 'rate_limit' : res.status === 401 || res.status === 403 ? 'auth' : res.status >= 500 ? 'server' : res.ok ? 'invalid' : 'server';
      throw new ProviderError('minimax', msg, res.status === 429 || res.status >= 500, kind);
    }
    if (!j.data?.audio) throw schemaChanged('minimax', 'no data.audio');
    return {
      bytes: Buffer.from(j.data.audio, 'hex'),
      mime: 'audio/mpeg',
      chars: j.extra_info?.usage_characters ?? req.text.length,
      durationMs: j.extra_info?.audio_length ?? 0,
      model: req.model,
      providerRequestId: j.trace_id ?? `minimax-${Date.now()}`,
      rawMeta: { traceId: j.trace_id ?? null, extraInfo: j.extra_info ?? null, baseResp: j.base_resp ?? null },
    };
  }
}

/**
 * BytePlus Seed Speech (TTS 2.0) HTTP unidirectional endpoint. Fallback voice provider; exact voice list and
 * English quality are validated by the Phase 3 blind listening test before it serves traffic.
 */
export class SeedSpeechTts implements TtsProvider {
  readonly name = 'byteplus-speech';
  constructor(
    private readonly appId: string,
    private readonly token: string,
    private readonly endpoint = 'https://voice.ap-southeast-1.bytepluses.com/api/v3/tts/unidirectional',
  ) {}
  async synthesize(req: TtsRequest): Promise<TtsResult> {
    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-App-Id': this.appId,
        'X-Api-Access-Key': this.token,
        'X-Api-Resource-Id': PROVIDER_API_PATHS.seedSpeechResource,
      },
      body: JSON.stringify({
        user: { uid: 'arkiv' },
        req_params: { text: req.text, speaker: req.voice, audio_params: { format: 'mp3', sample_rate: 24000 } },
      }),
    });
    if (!res.ok) {
      const kind = res.status === 429 ? 'rate_limit' : res.status === 401 || res.status === 403 ? 'auth' : res.status >= 500 ? 'server' : 'invalid';
      throw new ProviderError('byteplus-speech', `HTTP ${res.status}`, res.status >= 500 || res.status === 429, kind);
    }
    // The endpoint streams JSON lines each carrying a base64 audio chunk.
    const chunks: Buffer[] = [];
    for (const line of (await res.text()).split('\n')) {
      if (!line.trim()) continue;
      let j: { code?: number; data?: string; message?: string };
      try {
        j = JSON.parse(line) as typeof j;
      } catch {
        throw schemaChanged('byteplus-speech', 'a response line is not JSON');
      }
      if (j.code && j.code !== 0 && j.code !== 20000000) throw new ProviderError('byteplus-speech', j.message ?? `code ${j.code}`, false, 'invalid');
      if (j.data) chunks.push(Buffer.from(j.data, 'base64'));
    }
    if (!chunks.length) throw new ProviderError('byteplus-speech', 'no audio returned', true, 'server');
    return { bytes: Buffer.concat(chunks), mime: 'audio/mpeg', chars: req.text.length, durationMs: 0, model: req.model, providerRequestId: `seed-${Date.now()}` };
  }
}
