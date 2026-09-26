import { createHmac, timingSafeEqual } from 'node:crypto';
import { globalTx } from '@arkiv/db';
import { env } from '@arkiv/shared';

/**
 * Provider render callbacks (standard §39 "provider callback + polling with idempotent state machine"; plan 06
 * Phase 3 D3). The callback URL handed to a video provider names our provider job and is signed with
 * PROVIDER_CALLBACK_SECRET, so a forged or replayed-for-another-job callback is refused. A callback is only a hint:
 * it is stored once (like any webhook) and the worker re-fetches the task from the provider before settling.
 */

/** Providers that can call back about a render. */
export const CALLBACK_PROVIDERS = ['byteplus'] as const;
export type CallbackProvider = (typeof CALLBACK_PROVIDERS)[number];

const sign = (secret: string, provider: string, jobId: string) => createHmac('sha256', secret).update(`provider-callback:${provider}:${jobId}`).digest('base64url');

/** Is APP_URL somewhere a provider can reach (https, not a loopback or private host)? */
export function publicAppUrl(appUrl = env().APP_URL): boolean {
  try {
    const u = new URL(appUrl);
    return u.protocol === 'https:' && !/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$)/.test(u.hostname) && !u.hostname.endsWith('.local');
  } catch {
    return false;
  }
}

/** The signed callback URL for one provider job, or null when callbacks can't be received (polling only). */
export function providerCallbackUrl(provider: string, jobId: string): string | null {
  const secret = env().PROVIDER_CALLBACK_SECRET;
  if (!secret || !(CALLBACK_PROVIDERS as readonly string[]).includes(provider) || !publicAppUrl()) return null;
  return `${env().APP_URL}/api/webhooks/provider/${provider}?${new URLSearchParams({ job: jobId, sig: sign(secret, provider, jobId) })}`;
}

export function verifyProviderCallback(provider: string, jobId: string | null, sig: string | null): boolean {
  const secret = env().PROVIDER_CALLBACK_SECRET;
  if (!secret || !jobId || !sig || !/^[0-9a-f-]{36}$/i.test(jobId)) return false;
  const a = Buffer.from(sign(secret, provider, jobId));
  const b = Buffer.from(sig);
  return a.length === b.length && timingSafeEqual(a, b);
}

const STATUSES = new Set(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'expired']);

/**
 * Store a verified callback once per (job, task, reported status): a provider retrying the same callback is a no-op,
 * a later status is a new receipt. Returns whether it was new, or null when the body isn't a task callback.
 */
export async function receiveProviderCallback(provider: CallbackProvider, jobId: string, body: unknown): Promise<boolean | null> {
  const b = (body ?? {}) as { id?: unknown; status?: unknown };
  const taskId = typeof b.id === 'string' ? b.id.slice(0, 200) : null;
  const status = typeof b.status === 'string' && STATUSES.has(b.status) ? b.status : null;
  if (!taskId || !status) return null;
  // Same store as every webhook (webhook_receive: deduplicated, processed by the worker's drain).
  const [r] = await globalTx((tx) => tx`select webhook_receive(${provider}, ${`${jobId}:${taskId}:${status}`}, ${`video.${status}`}, ${JSON.stringify({ jobId, taskId, status })}, '{}'::jsonb) as inserted`);
  return !!r?.inserted;
}
