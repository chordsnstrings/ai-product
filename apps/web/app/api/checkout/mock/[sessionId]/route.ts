import { completeMockCheckout } from '@arkiv/billing';
import { json, route } from '@/lib/http';

/** Dev/test only (refuses when Stripe is live): completes a mock session through the real webhook pipeline. */
export const POST = route(async (_req, { params }: { params: Promise<{ sessionId: string }> }) => {
  const { sessionId } = await params;
  const ids = await completeMockCheckout(sessionId);
  return json({ ok: true, events: ids });
});
