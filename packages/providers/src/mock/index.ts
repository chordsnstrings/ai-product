import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { placeholderFrame, stillToClip, toneAudio, withTempDir, type Aspect } from '@arkiv/media';
import type {
  ImageProvider,
  ImageRequest,
  ImageResult,
  LlmJsonRequest,
  LlmJsonResult,
  LlmProvider,
  TtsProvider,
  TtsRequest,
  TtsResult,
  VideoPoll,
  VideoProvider,
  VideoRequest,
} from '../types';
import { ProviderError } from '../types';

const approxTokens = (s: string) => Math.ceil(s.length / 4);

/**
 * Deterministic fakes used in dev/test (PROVIDERS_MODE=mock). They produce *real* media files so the whole
 * pipeline (QA, composition, export) runs end to end without spending money.
 * Failure injection: prompts containing `[[fail:<kind>]]` make the mock fail, for chaos tests.
 */
function injected(prompt: string): string | null {
  const m = /\[\[fail:([a-z_]+)\]\]/.exec(prompt);
  return m ? m[1]! : null;
}

export class MockLlm implements LlmProvider {
  readonly name = 'anthropic';
  async json<T>(req: LlmJsonRequest<T>): Promise<LlmJsonResult<T>> {
    const text = req.content.map((c) => (c.type === 'image' ? '' : c.text)).join('\n');
    const fail = injected(text);
    if (fail) throw new ProviderError(this.name, `injected ${fail}`, fail !== 'invalid', fail as never);
    const data = req.schema.parse(req.mock());
    return {
      data,
      usage: {
        inputTokens: approxTokens(req.system + text) + req.content.filter((c) => c.type === 'image').length * 1500,
        outputTokens: approxTokens(JSON.stringify(data)),
        cachedTokens: 0,
      },
      model: req.model,
      modelVersion: `${req.model}-mock`,
    };
  }
}

const aspectFor = (w: number, h: number): Aspect => (w === h ? '1x1' : w / h > 0.7 ? '4x5' : '9x16');

export class MockImage implements ImageProvider {
  readonly name = 'byteplus';
  async generate(req: ImageRequest): Promise<ImageResult> {
    const fail = injected(req.prompt);
    if (fail) throw new ProviderError(this.name, `injected ${fail}`, fail !== 'invalid', fail as never);
    const seed = parseInt(createHash('sha1').update(req.prompt).digest('hex').slice(0, 4), 16);
    const bytes = await placeholderFrame(req.mockLabel ?? req.prompt.slice(0, 80), aspectFor(req.width, req.height), seed);
    return { bytes, mime: 'image/png', model: req.model, modelVersion: `${req.model}-mock`, providerRequestId: `mock-img-${randomUUID()}` };
  }
}

interface MockTask {
  req: VideoRequest;
  createdAt: number;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  bytes?: Buffer;
  error?: string;
}

export class MockVideo implements VideoProvider {
  readonly name = 'byteplus';
  private tasks = new Map<string, MockTask>();
  /** Simulated latency before a task completes. */
  constructor(private readonly latencyMs = 50) {}

  async submit(req: VideoRequest): Promise<{ providerRequestId: string }> {
    const fail = injected(req.prompt);
    if (fail === 'submit') throw new ProviderError(this.name, 'injected submit failure', true, 'server');
    const id = `mock-vid-${randomUUID()}`;
    this.tasks.set(id, { req, createdAt: Date.now(), status: 'queued' });
    return { providerRequestId: id };
  }

  async poll(id: string): Promise<VideoPoll> {
    const t = this.tasks.get(id);
    if (!t) return { status: 'failed', error: 'unknown task (worker restarted?)' };
    if (t.status === 'cancelled' || t.status === 'failed' || t.status === 'succeeded') {
      return { status: t.status, bytes: t.bytes, error: t.error, modelVersion: `${t.req.model}-mock`, outputSeconds: t.req.seconds };
    }
    if (Date.now() - t.createdAt < this.latencyMs) return { status: 'running' };
    const fail = injected(t.req.prompt);
    if (fail === 'render' || fail === 'moderation') {
      t.status = 'failed';
      t.error = fail === 'moderation' ? 'content moderation rejected the request' : 'provider render failure';
      return { status: 'failed', error: t.error };
    }
    const aspect: Aspect = t.req.ratio === '1:1' ? '1x1' : t.req.ratio === '4:5' ? '4x5' : '9x16';
    t.bytes = await withTempDir(async (dir) => {
      const png = path.join(dir, 'f.png');
      const { writeFile } = await import('node:fs/promises');
      await writeFile(png, await placeholderFrame(t.req.mockLabel ?? t.req.prompt.slice(0, 80), aspect, 2));
      const out = path.join(dir, 'v.mp4');
      await stillToClip(png, t.req.seconds * 1000, aspect, out, 'push');
      return readFile(out);
    });
    t.status = 'succeeded';
    return { status: 'succeeded', bytes: t.bytes, modelVersion: `${t.req.model}-mock`, outputSeconds: t.req.seconds };
  }

  async cancel(id: string): Promise<void> {
    const t = this.tasks.get(id);
    if (t && (t.status === 'queued' || t.status === 'running')) t.status = 'cancelled';
  }
}

export class MockTts implements TtsProvider {
  constructor(readonly name = 'minimax') {}
  async synthesize(req: TtsRequest): Promise<TtsResult> {
    const fail = injected(req.text);
    if (fail) throw new ProviderError(this.name, `injected ${fail}`, true, 'server');
    // ~2.6 words per second of natural voice-over.
    const words = req.text.split(/\s+/).filter(Boolean).length;
    const durationMs = Math.max(800, Math.round((words / 2.6) * 1000));
    const bytes = await withTempDir(async (dir) => {
      const out = path.join(dir, 'vo.mp3');
      await toneAudio(durationMs, out, 180);
      return readFile(out);
    });
    return { bytes, mime: 'audio/mpeg', chars: req.text.length, durationMs, model: req.model, providerRequestId: `mock-tts-${randomUUID()}` };
  }
}
