import { withAdmin } from '@arkiv/db';
import { recordHeartbeat } from '@arkiv/core';

/** Liveness + DB reachability for the console's health check; records this instance's heartbeat (plan 05 §22). */
export async function GET() {
  try {
    await withAdmin((tx) => tx`select 1`);
    await recordHeartbeat('admin').catch(() => {});
    return Response.json({ ok: true });
  } catch {
    return Response.json({ ok: false }, { status: 503 });
  }
}
