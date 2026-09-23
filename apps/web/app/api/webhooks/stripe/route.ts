import { processStripeEvent, receiveStripeWebhook } from '@arkiv/billing';
import { DomainError } from '@arkiv/shared';

/** Verify + store (dedupe by event id) and ack fast; processing is idempotent and retried by the worker sweep. */
export async function POST(req: Request) {
  const raw = await req.text();
  try {
    const r = await receiveStripeWebhook(raw, req.headers.get('stripe-signature'));
    if (!r.duplicate) void processStripeEvent(r.id).catch((e) => console.error('[stripe] inline process failed; worker will retry', r.id, e));
    return Response.json({ received: true });
  } catch (e) {
    if (e instanceof DomainError && e.code === 'FORBIDDEN') return new Response('Invalid signature', { status: 400 });
    console.error('[stripe webhook]', e);
    return new Response('Error', { status: 500 });
  }
}
