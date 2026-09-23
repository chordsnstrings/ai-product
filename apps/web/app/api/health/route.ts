import { globalTx } from '@arkiv/db';

/** Liveness + DB reachability for App Platform health checks. No tenant data. */
export async function GET() {
  try {
    await globalTx((tx) => tx`select 1`);
    return Response.json({ ok: true });
  } catch {
    return Response.json({ ok: false }, { status: 503 });
  }
}
