import type { z } from 'zod';

/** Content parts sent to the reasoning model. Imported web/customer text must be wrapped as untrusted data. */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: 'image/png' | 'image/jpeg' | 'image/webp'; base64: string }
  | { type: 'untrusted'; sourceId: string; text: string };

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

export interface LlmJsonRequest<T> {
  task: string;
  model: string;
  /** Static, cacheable system prompt (never contains tenant data — plan 02 §3 layer 6). */
  system: string;
  content: ContentPart[];
  schema: z.ZodType<T>;
  maxTokens?: number;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Deterministic output used in PROVIDERS_MODE=mock (and as the golden-set expectation in tests). */
  mock: () => T;
}

/**
 * The provider's own response envelope without the payload (standard §39 "raw provider response metadata is
 * persisted"): request id, usage breakdown, stop reason, status. Never media bytes, signed URLs or tenant text.
 */
export type RawMeta = Record<string, unknown>;

export interface LlmJsonResult<T> {
  data: T;
  usage: LlmUsage;
  model: string;
  modelVersion: string;
  /** The provider's id for this request (e.g. the message id), for reconciliation and support. */
  providerRequestId?: string;
  rawMeta?: RawMeta;
}

export interface LlmProvider {
  readonly name: string;
  json<T>(req: LlmJsonRequest<T>): Promise<LlmJsonResult<T>>;
}

export interface ImageRequest {
  model: string;
  prompt: string;
  /** Reference images (product views) as data: URLs or https URLs. */
  references: string[];
  width: number;
  height: number;
  seed?: number;
  mockLabel?: string;
}
export interface ImageResult {
  bytes: Buffer;
  mime: 'image/png' | 'image/jpeg';
  model: string;
  modelVersion: string;
  providerRequestId: string;
  rawMeta?: RawMeta;
}
export interface ImageProvider {
  readonly name: string;
  generate(req: ImageRequest): Promise<ImageResult>;
}

export interface VideoRequest {
  model: string;
  prompt: string;
  references: string[];
  seconds: number;
  resolution: '720p' | '1080p';
  ratio: '9:16' | '4:5' | '1:1';
  seed?: number;
  mockLabel?: string;
}
export type VideoStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export interface VideoPoll {
  status: VideoStatus;
  bytes?: Buffer;
  error?: string;
  modelVersion?: string;
  outputSeconds?: number;
  rawMeta?: RawMeta;
}
export interface VideoProvider {
  readonly name: string;
  submit(req: VideoRequest): Promise<{ providerRequestId: string }>;
  poll(providerRequestId: string): Promise<VideoPoll>;
  cancel(providerRequestId: string): Promise<void>;
}

export interface TtsRequest {
  model: string;
  text: string;
  voice: string;
  speed?: number;
}
export interface TtsResult {
  bytes: Buffer;
  mime: 'audio/mpeg';
  chars: number;
  durationMs: number;
  model: string;
  providerRequestId: string;
  rawMeta?: RawMeta;
}
export interface TtsProvider {
  readonly name: string;
  synthesize(req: TtsRequest): Promise<TtsResult>;
}

export class ProviderError extends Error {
  constructor(
    public readonly provider: string,
    message: string,
    public readonly retryable: boolean,
    public readonly kind: 'rate_limit' | 'server' | 'invalid' | 'auth' | 'moderation' | 'refusal' | 'timeout' | 'unknown' = 'unknown',
  ) {
    super(`[${provider}] ${message}`);
    this.name = 'ProviderError';
  }
}
