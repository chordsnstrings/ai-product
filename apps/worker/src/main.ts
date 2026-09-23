import { PgBoss } from 'pg-boss';
import { closeAll, systemPool, withSystem } from '@arkiv/db';
import { env } from '@arkiv/shared';
import { processStripeEvent } from '@arkiv/billing';
import { processPendingStripeEvents, runJob } from './handlers';
import { sweepQueue, sweeps } from './sweeps';
import { grantQueueVisibility, processOpsCommands } from './ops';
import { QUEUE_CONFIG } from './queues';

/**
 * Worker process (plan 01 §2 layout). Responsibilities:
 *  1. Dispatcher: move committed outbox rows into pg-boss (outbox id = job id → a crash between send and
 *     mark can't create a duplicate job).
 *  2. Workers: one per queue, with bounded retries + dead letter, separate from creative QA retries (§39).
 *  3. Scheduled sweeps (cron) and Stripe event processing.
 * Free-tier AI work (provisional/free previews, storyboards, concept and frame requests) runs on separate `-free`
 * queues with their own, smaller worker pools, so paying tenants never wait behind preview traffic (plan 02 §3
 * layer 5). Paid work also carries a higher priority within its queue.
 */
const log = (...a: unknown[]) => console.log(new Date().toISOString(), '[worker]', ...a);

async function dispatchOnce(boss: PgBoss): Promise<number> {
  return withSystem(async (tx) => {
    const rows = await tx`select id, queue, payload, priority, run_after from outbox
                          where dispatched_at is null and run_after <= now() + interval '1 second'
                          order by priority desc, created_at limit 100 for update skip locked`;
    for (const r of rows) {
      await boss.send(r.queue as string, r.payload as object, { id: r.id as string, priority: Number(r.priority), startAfter: new Date(r.run_after as string) });
      await tx`update outbox set dispatched_at = now() where id = ${r.id}`;
    }
    // Delayed jobs (run_after in the future) are picked up once due.
    return rows.length;
  });
}

async function main() {
  const boss = new PgBoss({ connectionString: env().DATABASE_URL, schema: 'pgboss' });
  boss.on('error', (e) => log('pg-boss error', e));
  await boss.start();
  for (const [name, cfg] of Object.entries(QUEUE_CONFIG)) {
    await boss.createQueue(`${name}-dlq`).catch(() => {});
    await boss.createQueue(name, { retryLimit: cfg.retryLimit, retryDelay: 15, retryBackoff: true, expireInSeconds: cfg.expireInSeconds, deadLetter: `${name}-dlq` }).catch(() => {});
    for (let i = 0; i < cfg.concurrency; i++) {
      await boss.work(name, { batchSize: 1, pollingIntervalSeconds: 1 }, async (jobs) => {
        for (const job of jobs) {
          const t0 = Date.now();
          try {
            const r = await runJob(name, job.data as Record<string, unknown>, job.id);
            log(name, job.id, 'ok', `${Date.now() - t0}ms`, JSON.stringify(r ?? null).slice(0, 160));
          } catch (e) {
            log(name, job.id, 'error', (e as Error).message);
            throw e;
          }
        }
      });
    }
  }
  for (const [key, s] of Object.entries(sweeps)) {
    // Schedules get their own queue namespace: a sweep sharing a job queue's name (e.g. weekly-recommendations)
    // would compete for that queue's per-workspace jobs and run the fan-out instead of the job.
    const name = sweepQueue(key);
    await boss.unschedule(key).catch(() => {}); // remove schedules registered under the old, colliding name
    await boss.createQueue(name).catch(() => {});
    await boss.schedule(name, s.cron, {});
    await boss.work(name, async () => {
      const n = await s.run();
      if (n) log(name, JSON.stringify(n));
    });
  }

  await grantQueueVisibility();

  // Dispatcher: LISTEN for outbox inserts, with polling as the correctness floor.
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      while ((await dispatchOnce(boss)) === 100);
      await processPendingStripeEvents(processStripeEvent);
      await processOpsCommands(boss);
    } catch (e) {
      log('dispatch error', (e as Error).message);
    } finally {
      busy = false;
    }
  };
  await systemPool().listen('outbox', () => void tick()).catch(() => log('LISTEN unavailable; polling only'));
  const timer = setInterval(tick, 1000);
  await tick();
  log('ready', Object.keys(QUEUE_CONFIG).length, 'queues,', Object.keys(sweeps).length, 'schedules');

  const shutdown = async () => {
    log('shutting down');
    clearInterval(timer);
    await boss.stop({ graceful: true, timeout: 30_000 });
    await closeAll();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
