import { globalTx } from '@arkiv/db';
import { recordHeartbeat } from '@arkiv/core';

/**
 * Liveness + DB reachability for App Platform health checks. No tenant data. Each check also records this
 * instance's heartbeat for the console's service status (plan 05 §22).
 */
export async function GET() {
  try {
    await globalTx((tx) => tx`select 1`);
    await recordHeartbeat('web').catch(() => {});
    return Response.json({ ok: true });
  } catch {
    return Response.json({ ok: false }, { status: 503 });
  }
}
