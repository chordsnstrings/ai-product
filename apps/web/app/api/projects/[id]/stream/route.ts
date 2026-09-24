import { errorResponse } from '@/lib/http';
import { projectAccess } from '@/lib/tenant';
import { projectVersion, projectView } from '@/lib/views';

export const dynamic = 'force-dynamic';

/** How often the stream checks for a change, how often it proves it is alive, and how long one connection lasts. */
const TICK_MS = 750;
const HEARTBEAT_MS = 15_000;
const MAX_MS = 10 * 60_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The P3 cataloguing stream (plan 06 Phase 1 #9): server-sent events carrying the project view whenever the
 * underlying rows change (progress steps, facts and claims via their events, concepts, project state). Access is
 * checked like the polling endpoint. Each message's id is the version it reflects, so a reconnect with
 * Last-Event-ID only receives something new. The browser reconnects after MAX_MS; clients fall back to polling
 * GET /api/projects/:id if the stream isn't available.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let a: Awaited<ReturnType<typeof projectAccess>>;
  try {
    a = await projectAccess(id);
  } catch (e) {
    return errorResponse(e);
  }
  const ws = a.ctx.workspaceId;
  const access = { provisional: a.provisional, signedIn: !!a.user, role: a.ctx.role, workspaceSlug: a.slug || null };
  const enc = new TextEncoder();
  let closed = false;
  req.signal.addEventListener('abort', () => {
    closed = true;
  });
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (s: string) => {
        if (!closed) controller.enqueue(enc.encode(s));
      };
      send('retry: 3000\n\n');
      let prev = req.headers.get('last-event-id');
      let lastSent = Date.now();
      const started = Date.now();
      while (!closed && Date.now() - started < MAX_MS) {
        try {
          const version = await projectVersion(ws, id);
          if (!version) {
            send('event: gone\ndata: {}\n\n');
            break;
          }
          if (version !== prev) {
            const view = await projectView(ws, id);
            send(`id: ${version}\nevent: project\ndata: ${JSON.stringify({ ...view, access })}\n\n`);
            prev = version;
            lastSent = Date.now();
          } else if (Date.now() - lastSent >= HEARTBEAT_MS) {
            send(': keep-alive\n\n');
            lastSent = Date.now();
          }
        } catch {
          send('event: failure\ndata: {}\n\n');
          break;
        }
        await sleep(TICK_MS);
      }
      if (!closed) {
        closed = true;
        controller.close();
      }
    },
    cancel() {
      closed = true;
    },
  });
  return new Response(stream, {
    headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' },
  });
}
