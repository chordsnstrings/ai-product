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
  /** Seconds of video generated — billed by the provider, also on a failed task that generated some. */
  outputSeconds?: number;
  rawMeta?: RawMeta;
  /** Where the task stands in the provider's queue, when the provider says (§48 "truthful queued state/ETA"). */
  queuePosition?: number;
  /** The provider's own estimate of seconds until the task completes, when it gives one. */
  etaSeconds?: number;
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

/**
 * Background removal for the product cut-out (plan 06 Phase 1 #6, design M3). The request carries the product
 * photo; the result is the product on a transparent background made from the photo's own pixels, and its mask.
 */
export interface SegmentationRequest {
  model: string;
  image: Buffer;
}
export interface SegmentationResult {
  /** RGBA PNG trimmed to the product. */
  png: Buffer;
  /** Single-channel PNG mask at the normalized photo size (255 = product). */
  mask: Buffer;
  /** Share of the frame the product covers. */
  coverage: number;
  /**
   * Whether the output is usable: the mask separates the product cleanly and lines up with the photo. A provider
   * that answered but moved, redrew or lost the product returns false (the call is still billed).
   */
  aligned: boolean;
  /** How the cut-out was made, recorded in its lineage (e.g. `seedream_edit+key`, `border_key`). */
  technique: string;
  model: string;
  modelVersion: string;
  providerRequestId: string;
  rawMeta?: RawMeta;
}
export interface SegmentationProvider {
  readonly name: string;
  removeBackground(req: SegmentationRequest): Promise<SegmentationResult>;
}

/**
 * What a provider billed for a call that still failed (plan 06 Phase 3 "partial provider billing"; standard §37 all
 * spend is accounted): a refusal or truncated answer after tokens were generated, a render moderated or failed after
 * generating seconds of video. The gateway books it as the job's actual cost.
 */
export interface BilledUnits {
  seconds?: number;
  tokens?: { input: number; output: number };
  chars?: number;
  images?: number;
}

export class ProviderError extends Error {
  constructor(
    public readonly provider: string,
    message: string,
    public readonly retryable: boolean,
    /** `schema_changed`: the provider answered with a shape this adapter doesn't know (§47 "fail safely"). */
    public readonly kind: 'rate_limit' | 'server' | 'invalid' | 'auth' | 'moderation' | 'refusal' | 'timeout' | 'schema_changed' | 'unknown' = 'unknown',
    /** Units the provider billed although the call failed (absent: nothing billed). */
    public readonly billed?: BilledUnits,
  ) {
    super(`[${provider}] ${message}`);
    this.name = 'ProviderError';
  }
}
