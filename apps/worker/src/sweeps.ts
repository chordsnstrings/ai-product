import { withSystem } from '@arkiv/db';
import {
  RECOVERY_EMAIL_CAP,
  duePurges,
  expireOffers,
  refreshRiskFlags,
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
  // At most three recovery emails per project (counted in email_log), none after a purchase. Runs as system_rw,
  // so every predicate ties rows to their own workspace explicitly.
  'offer-reminders': {
    cron: '* * * * *',
    run: () =>
      withSystem(async (tx) => {
        // Fragments over the project alias `p` (fresh per query).
        const underCap = () => tx`(select count(distinct l.template) from email_log l where l.workspace_id = p.workspace_id
                                     and l.idempotency_key like 'recovery:' || p.id::text || ':%') < ${RECOVERY_EMAIL_CAP}`;
        const notPurchased = () => tx`not exists (select 1 from purchases pu where pu.workspace_id = p.workspace_id and pu.status = 'paid')`;
        const due = await tx`select o.id, o.workspace_id from offers o join projects p on p.id = o.project_id and p.workspace_id = o.workspace_id
                             where o.type = 'TASTE' and o.status = 'active'
                               and o.expires_at between now() + interval '13 minutes' and now() + interval '16 minutes'
                               and ${notPurchased()} and ${underCap()}`;
        for (const o of due) await enqueueFor(tx, o.workspace_id as string, 'send-email', { template: 'offer_ending', offerId: o.id }, `offer-ending:${o.id}`);
        const stale = await tx`select p.id, p.workspace_id from projects p where p.state = 'STORYBOARD_READY' and p.kind = 'preview'
                               and p.updated_at between now() - interval '25 hours' and now() - interval '24 hours'
                               and ${notPurchased()} and ${underCap()}`;
        for (const p of stale) await enqueueFor(tx, p.workspace_id as string, 'send-email', { template: 'storyboard_saved', projectId: p.id }, `saved:${p.id}`);
        // T+3d: a new concept for the same SKU (≈ one concepts call, no render), then the new_concept email.
        const cold = await tx`select p.id, p.workspace_id from projects p join workspaces w on w.id = p.workspace_id
                              where p.state = 'STORYBOARD_READY' and p.kind = 'preview' and w.state in ('ACTIVE_FREE','ACTIVE_PAID')
                                and p.updated_at between now() - interval '73 hours' and now() - interval '72 hours'
                                and ${notPurchased()} and ${underCap()}`;
        for (const p of cold) await enqueueFor(tx, p.workspace_id as string, 'recovery-concept', { projectId: p.id }, `recovery-concept:${p.id}`);
        return due.length + stale.length + cold.length;
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
        const ws = await tx`select id from workspaces where state in ('ACTIVE_PAID','PAST_DUE','ACTIVE_FREE')`;
        for (const w of ws) {
          await tx`select set_config('app.workspace_id', ${w.id as string}, true)`;
          await refreshRiskFlags(tx, w.id as string);
        }
        return ws.length;
      }),
  },
};
