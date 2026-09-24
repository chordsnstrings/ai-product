import { processStripeEvent, receiveStripeWebhook } from '@arkiv/billing';
import { DomainError } from '@arkiv/shared';
import { logger } from '@arkiv/shared/log';

const log = logger('stripe-webhook');

/** Verify + store (dedupe by event id) and ack fast; processing is idempotent and retried by the worker sweep. */
export async function POST(req: Request) {
  const raw = await req.text();
  try {
    const r = await receiveStripeWebhook(raw, req.headers.get('stripe-signature'));
    if (!r.duplicate) void processStripeEvent(r.id).catch((e) => log.warn('inline processing failed; the worker will retry', { stripeEventId: r.id, err: e }));
    return Response.json({ received: true });
  } catch (e) {
    if (e instanceof DomainError && e.code === 'FORBIDDEN') return new Response('Invalid signature', { status: 400 });
    log.error('webhook failed', { err: e });
    return new Response('Error', { status: 500 });
  }
}
