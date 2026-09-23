import { withSystem } from '@arkiv/db';
import { sendEmail } from '@arkiv/email';
import { env } from '@arkiv/shared';
import {
  duePurges,
  evaluateCanaries,
  expiredFlagAlerts,
  expireOffers,
  refreshRiskFlags,
  retireSupersededRates,
  sweepExpiredAuthorizations,
  sweepExpiringEvidence,
  sweepProvisional,
  sweepRateLimits,
  sweepRetention,
  weekOf,
} from '@arkiv/core';

/**
 * Scheduled maintenance (§39: reservations must never be stranded; plan 02 lifecycle; plan 04 L20 recovery).
 * Each sweep runs as the system role and fans out tenant work through the outbox.
 */
async function enqueueFor(tx: Parameters<Parameters<typeof withSystem>[0]>[0], workspaceId: string, queue: string, payload: Record<string, unknown>, singletonKey: string) {
  const [dup] = await tx`select 1 from outbox where queue = ${queue} and singleton_key = ${singletonKey} limit 1`;
  if (dup) return;
  await tx`insert into outbox (workspace_id, queue, payload, singleton_key) values (${workspaceId}, ${queue}, ${tx.json({ ...payload, workspaceId })}, ${singletonKey})`;
}

/** pg-boss queue for a schedule — never the same name as a job queue (see main.ts). */
export const sweepQueue = (key: string) => `cron-${key}`;

export const sweeps: Record<string, { cron: string; run: () => Promise<unknown> }> = {
  'sweep-authorizations': { cron: '* * * * *', run: () => withSystem((tx) => sweepExpiredAuthorizations(tx)) },
  'sweep-offers': { cron: '* * * * *', run: () => withSystem((tx) => expireOffers(tx)) },
  // L8/L20: a single honest reminder 15 minutes before the Taste window closes; then T+24h and T+3d nudges.
  'offer-reminders': {
    cron: '* * * * *',
    run: () =>
      withSystem(async (tx) => {
        const due = await tx`select o.id, o.workspace_id from offers o where o.type = 'TASTE' and o.status = 'active'
                             and o.expires_at between now() + interval '13 minutes' and now() + interval '16 minutes'
                             and not exists (select 1 from purchases p where p.workspace_id = o.workspace_id and p.status = 'paid')`;
        for (const o of due) await enqueueFor(tx, o.workspace_id as string, 'send-email', { template: 'offer_ending', offerId: o.id }, `offer-ending:${o.id}`);
        const stale = await tx`select p.id, p.workspace_id from projects p where p.state = 'STORYBOARD_READY' and p.kind = 'preview'
                               and p.updated_at between now() - interval '25 hours' and now() - interval '24 hours'`;
        for (const p of stale) await enqueueFor(tx, p.workspace_id as string, 'send-email', { template: 'storyboard_saved', projectId: p.id }, `saved:${p.id}`);
        return due.length + stale.length;
      }),
  },
  'sweep-provisional': { cron: '*/15 * * * *', run: () => withSystem((tx) => sweepProvisional(tx)) },
  'sweep-retention': { cron: '0 * * * *', run: () => withSystem((tx) => sweepRetention(tx)) },
  'due-purges': {
    cron: '*/10 * * * *',
    run: () =>
      withSystem(async (tx) => {
        const ids = await duePurges(tx);
        for (const id of ids) await enqueueFor(tx, id, 'purge-workspace', { workspaceId: id }, `purge:${id}`);
        return ids.length;
      }),
  },
  'sweep-rate-limits': { cron: '17 * * * *', run: () => withSystem((tx) => sweepRateLimits(tx)) },
  // A scheduled rate-table version replaces its predecessor at its effective time (plan 05 §9); pricing already
  // uses the newest version in effect, this keeps the table's statuses truthful.
  'retire-superseded-rates': { cron: '*/5 * * * *', run: () => withSystem((tx) => retireSupersededRates(tx)) },
  // Canary rollout guard (plan 05 §11): automatic, audited rollback when the canary arm's QA first-pass or
  // claim-block rate regresses against stable.
  // Flags past expiry alert their owner once a day until removed or extended (plan 05 §20).
  'flag-expiry': {
    cron: '0 13 * * *',
    run: async () => {
      const alerts = await withSystem((tx) => expiredFlagAlerts(tx));
      const day = new Date().toISOString().slice(0, 10);
      let sent = 0;
      for (const a of alerts) {
        for (const to of a.to) {
          const r = await sendEmail('flag_expired', to, { flagKey: a.key, owner: a.owner, expiredOn: a.expiredAt.slice(0, 10), url: `${env().ADMIN_URL}/flags` }, { idempotencyKey: `flag-expired:${a.key}:${to}:${day}` });
          if (r.status !== 'duplicate') sent++;
        }
      }
      return sent;
    },
  },
  'canary-guard': { cron: '*/15 * * * *', run: () => withSystem(async (tx) => { const rolled = await evaluateCanaries(tx); return rolled.length ? rolled : 0; }) },
  'sweep-evidence': { cron: '5 6 * * *', run: () => withSystem((tx) => sweepExpiringEvidence(tx)) },
  'sync-integrations': {
    cron: '0 */6 * * *',
    run: () =>
      withSystem(async (tx) => {
        const rows = await tx`select id, workspace_id from integrations where status = 'active'`;
        for (const r of rows) await enqueueFor(tx, r.workspace_id as string, 'sync-integration', { integrationId: r.id }, `sync:${r.id}:${new Date().toISOString().slice(0, 13)}`);
        return rows.length;
      }),
  },
  // Monday 12:00 UTC (~8am ET): This Week recommendations + brief (standard §11 weekly ritual).
  'weekly-recommendations': {
    cron: '0 12 * * 1',
    run: () =>
      withSystem(async (tx) => {
        const week = weekOf();
        const ws = await tx`select id from workspaces where state = 'ACTIVE_PAID' and plan_code is not null`;
        for (const w of ws) await enqueueFor(tx, w.id as string, 'weekly-recommendations', { week }, `recs:${w.id}:${week}`);
        return ws.length;
      }),
  },
  'friday-summary': {
    cron: '0 20 * * 5',
    run: () =>
      withSystem(async (tx) => {
        const ws = await tx`select id from workspaces where state = 'ACTIVE_PAID' and plan_code is not null`;
        for (const w of ws) await enqueueFor(tx, w.id as string, 'send-email', { template: 'friday_summary' }, `friday:${w.id}:${weekOf()}`);
        return ws.length;
      }),
  },
  'risk-flags': {
    cron: '30 7 * * *',
    run: () =>
      withSystem(async (tx) => {
        // refreshRiskFlags filters every query by workspace_id: the system role's policies see all tenants.
        const ws = await tx`select id from workspaces where state in ('ACTIVE_PAID','PAST_DUE','ACTIVE_FREE')`;
        for (const w of ws) await refreshRiskFlags(tx, w.id as string);
        return ws.length;
      }),
  },
};
