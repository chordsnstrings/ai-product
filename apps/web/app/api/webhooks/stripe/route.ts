import { receiveStripeWebhook } from '@arkiv/billing';
import { DomainError } from '@arkiv/shared';
import { logger } from '@arkiv/shared/log';

const log = logger('stripe-webhook');

/**
 * Verify + store (dedupe by event id) and ack fast. Processing resolves the workspace across tenants, so it runs in
 * the worker (system role), which drains stored events every second — the customer app holds only the app role.
 */
export async function POST(req: Request) {
  const raw = await req.text();
  try {
    const r = await receiveStripeWebhook(raw, req.headers.get('stripe-signature'));
    return Response.json({ received: true, duplicate: r.duplicate });
  } catch (e) {
    if (e instanceof DomainError && e.code === 'FORBIDDEN') return new Response('Invalid signature', { status: 400 });
    log.error('webhook failed', { err: e });
    return new Response('Error', { status: 500 });
  }
}
