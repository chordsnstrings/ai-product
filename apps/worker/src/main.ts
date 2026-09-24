import { PgBoss } from 'pg-boss';
import { closeAll, systemPool, withSystem } from '@arkiv/db';
import { env } from '@arkiv/shared';
import { processStripeEvent } from '@arkiv/billing';
import { processPendingWebhooks } from '@arkiv/core';
import { handleResendEvent } from '@arkiv/email';
import { onFinalFailure, processPendingStripeEvents, runJob } from './handlers';
import { sweepQueue, sweeps } from './sweeps';
import { grantQueueVisibility, processOpsCommands } from './ops';
import { QUEUE_CONFIG } from './queues';
import { logger, setLogService, withLogContext } from '@arkiv/shared/log';

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
setLogService('worker');
const log = logger('worker');

async function dispatchOnce(boss: PgBoss): Promise<number> {
  return withSystem(async (tx) => {
    const rows = await tx`select id, queue, payload, priority, run_after, singleton_key from outbox
                          where dispatched_at is null and run_after <= now() + interval '1 second'
                          order by priority desc, created_at limit 100 for update skip locked`;
    for (const r of rows) {
      // The key travels with the job (visible in pg-boss); overlap is prevented by the handlers' leases.
      await boss.send(r.queue as string, r.payload as object, { id: r.id as string, priority: Number(r.priority), startAfter: new Date(r.run_after as string), ...(r.singleton_key ? { singletonKey: r.singleton_key as string } : {}) });
      await tx`update outbox set dispatched_at = now() where id = ${r.id}`;
    }
    // Delayed jobs (run_after in the future) are picked up once due.
    return rows.length;
  });
}

async function main() {
  const boss = new PgBoss({ connectionString: env().DATABASE_URL, schema: 'pgboss' });
  boss.on('error', (e) => log.error('pg-boss error', { err: e }));
  await boss.start();
  for (const [name, cfg] of Object.entries(QUEUE_CONFIG)) {
    await boss.createQueue(`${name}-dlq`).catch(() => {});
    await boss.createQueue(name, { retryLimit: cfg.retryLimit, retryDelay: 15, retryBackoff: true, expireInSeconds: cfg.expireInSeconds, deadLetter: `${name}-dlq` }).catch(() => {});
    for (let i = 0; i < cfg.concurrency; i++) {
      await boss.work(name, { batchSize: 1, pollingIntervalSeconds: 1, includeMetadata: true }, async (jobs) => {
        // runJob logs each job with its queue, job id, payload domain ids and originating request id.
        for (const job of jobs) {
          try {
            await runJob(name, job.data as Record<string, unknown>, job.id);
          } catch (e) {
            // Last attempt: leave an honest final state behind (the job itself goes to the dead-letter queue).
            if (job.retryCount >= job.retryLimit) await onFinalFailure(name, job.data as Record<string, unknown>, job.id, e).catch((f) => log.error('final-failure handling failed', { jobId: job.id, queue: name, err: f }));
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
    await boss.work(name, async () =>
      withLogContext({ sweep: key }, async () => {
        const t0 = Date.now();
        try {
          const n = await s.run();
          if (n) log.info('sweep finished', { result: JSON.stringify(n).slice(0, 300), durationMs: Date.now() - t0 });
        } catch (e) {
          log.error('sweep failed', { durationMs: Date.now() - t0, err: e });
          throw e;
        }
      }),
    );
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
      // Stored Shopify / Resend / Meta / TikTok deliveries (verified and deduplicated by the web app, §38).
      await processPendingWebhooks({ resendEvent: handleResendEvent });
      await processOpsCommands(boss);
    } catch (e) {
      log.error('dispatch error', { err: e });
    } finally {
      busy = false;
    }
  };
  await systemPool().listen('outbox', () => void tick()).catch(() => log.warn('LISTEN unavailable; polling only'));
  const timer = setInterval(tick, 1000);
  await tick();
  log.info('ready', { queues: Object.keys(QUEUE_CONFIG).length, schedules: Object.keys(sweeps).length });

  const shutdown = async () => {
    log.info('shutting down');
    clearInterval(timer);
    await boss.stop({ graceful: true, timeout: 30_000 });
    await closeAll();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((e) => {
  log.error('worker crashed', { err: e });
  process.exit(1);
});
