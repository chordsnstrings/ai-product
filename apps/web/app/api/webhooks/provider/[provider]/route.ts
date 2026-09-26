import { CALLBACK_PROVIDERS, receiveProviderCallback, verifyProviderCallback, type CallbackProvider } from '@arkiv/core';

/**
 * Video provider render callbacks (standard §39 "provider callback + polling with idempotent state machine"). The
 * URL we gave the provider names our job and is signed; the body is stored once per job and reported status and the
 * worker re-fetches the task before settling it, so a forged, duplicated or out-of-order callback can't change a
 * result or settle credits twice.
 */
export async function POST(req: Request, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  if (!(CALLBACK_PROVIDERS as readonly string[]).includes(provider)) return new Response('Not found', { status: 404 });
  const q = new URL(req.url).searchParams;
  const jobId = q.get('job');
  if (!verifyProviderCallback(provider, jobId, q.get('sig'))) return new Response('Invalid signature', { status: 401 });
  let body: unknown;
  try {
    body = JSON.parse(await req.text());
  } catch {
    return new Response('Invalid body', { status: 400 });
  }
  const stored = await receiveProviderCallback(provider as CallbackProvider, jobId!, body);
  if (stored === null) return new Response('Not a task callback', { status: 400 });
  return Response.json({ ok: true, duplicate: !stored });
}
