import { withSystem, withTenant } from '@arkiv/db';
import { reconcileStripe } from '@arkiv/billing';
import { sendEmail } from '@arkiv/email';
import { env } from '@arkiv/shared';
import {
  ANALYSIS_STATES,
  failAnalysis,
  OUTAGE_MAX_HOURS,
  RECOVERY_EMAIL_CAP,
  STUCK_DEADLINE_MINUTES,
  failProduction,
  JOB_HOLD_STATES,
  systemContext,
  type TenantContext,
  createSkuReview,
  duePurges,
  dueSkuReviews,
  evaluateCanaries,
  expiredFlagAlerts,
  expireOffers,
  reconcileProviderJobs,
  refreshRiskFlags,
  retireSupersededRates,
  sweepExpiredAuthorizations,
  sweepExpiringEvidence,
  sweepLandingGalleryRights,
  sweepOfferGuardrails,
  sweepProvisional,
  sweepRateLimits,
  sweepRetention,
  weekOf,
} from '@arkiv/core';

// Scheduled maintenance (§39: reservations must never be stranded; plan 02 lifecycle; plan 04 L20 recovery).
// Each sweep runs as the system role and fans out tenant work through the outbox.

/**
 * Fan-out enqueue, once per singleton key ever (a reminder is never sent twice, even after its job ran). Atomic:
 * a concurrent run's pending row wins through the `outbox_singleton_pending` index; this workspace's own rows
 * are checked explicitly (system_rw sees every tenant).
 */
async function enqueueFor(tx: Parameters<Parameters<typeof withSystem>[0]>[0], workspaceId: string, queue: string, payload: Record<string, unknown>, singletonKey: string, priority = 0) {
  await tx`insert into outbox (workspace_id, queue, payload, singleton_key, priority)
           select ${workspaceId}, ${queue}, ${tx.json({ ...payload, workspaceId })}, ${singletonKey}, ${priority}
           where not exists (select 1 from outbox where workspace_id = ${workspaceId} and queue = ${queue} and singleton_key = ${singletonKey})
           on conflict (workspace_id, queue, singleton_key) where singleton_key is not null and dispatched_at is null do nothing`;
}

const sysCtx = (workspaceId: string, id: string): TenantContext => ({ ...systemContext(workspaceId, id), actor: { kind: 'system', id } });

/**
 * Productions of a held workspace (suspended, or purge pending) are not stalled but paused: their jobs are
 * parked until the hold ends, so the resume/fail sweeps leave them alone (plan 05 §2.3). Fragment over `p`.
 */
const notHeld = (tx: Parameters<Parameters<typeof withSystem>[0]>[0]) => tx`not exists (select 1 from workspaces w where w.id = p.workspace_id and w.state = any(${[...JOB_HOLD_STATES]}))`;

/** pg-boss queue for a schedule — never the same name as a job queue (see main.ts). */
export const sweepQueue = (key: string) => `cron-${key}`;

export const sweeps: Record<string, { cron: string; run: () => Promise<unknown> }> = {
  // Standard §9 Day 30 / §11 month-end: write each due SKU Creative Review (deterministic, no spend) in its own
  // workspace and email the owners once per review.
  'sku-reviews': {
    cron: '15 7 * * *',
    run: async () => {
      const due = await withSystem((tx) => dueSkuReviews(tx));
      let n = 0;
      for (const d of due) {
        const id = await withTenant(d.workspaceId, (tx) => createSkuReview(tx, sysCtx(d.workspaceId, 'sku-reviews'), d.skuId, d.kind, { start: d.start, end: d.end }));
        if (!id) continue;
        await withSystem((tx) => enqueueFor(tx, d.workspaceId, 'send-email', { template: 'day30_review', reviewId: id }, `sku-review:${id}`));
        n++;
      }
      return n;
    },
  },
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
  // §39/§44: productions paused by a provider outage resume (with backoff) once the provider's circuit is closed
  // and renders aren't kill-switched; an outage past OUTAGE_MAX_HOURS ends the attempt (entitlement returned,
  // paid one-off orders refunded).
  'resume-paused-productions': {
    cron: '* * * * *',
    run: async () => {
      const rows = await withSystem((tx) => tx`
        select p.id, p.workspace_id, p.outage,
          (p.outage->>'since')::timestamptz < now() - make_interval(hours => ${OUTAGE_MAX_HOURS}) as exhausted,
          coalesce((select r.circuit_open from model_routes r where r.task = p.outage->>'task'), false)
            or exists (select 1 from feature_flags f where f.key = 'kill.renders' and f.enabled) as blocked,
          (p.outage->>'lastAt')::timestamptz < now() - make_interval(mins => least(30, power(2, greatest(0, coalesce((p.outage->>'attempts')::int, 1) - 1))::int)) as due
        from projects p where p.state = 'NEEDS_USER_ACTION' and p.outage is not null and ${notHeld(tx)} limit 200`);
      let n = 0;
      for (const r of rows) {
        if (r.exhausted) {
          await withTenant(r.workspace_id as string, (tx) => failProduction(tx, sysCtx(r.workspace_id as string, 'outage-sweep'), r.id as string, 'provider outage did not recover in time', { code: 'outage_expired' }));
          n++;
        } else if (!r.blocked && r.due) {
          const attempts = Number((r.outage as { attempts?: number }).attempts ?? 1);
          await withSystem((tx) => enqueueFor(tx, r.workspace_id as string, 'produce-project', { projectId: r.id, resume: true }, `produce:${r.id}:resume:${attempts}`, 20));
          n++;
        }
      }
      return n;
    },
  },
  // prod-07: a production in RENDER_RESERVED..FINAL_QA with no live run (worker crashed) is resumed; if it has been
  // stuck past STUCK_DEADLINE_MINUTES — before its reservation's 180-minute TTL — it is failed and refunded instead.
  'sweep-stuck-productions': {
    cron: '* * * * *',
    run: async () => {
      const rows = await withSystem((tx) => tx`
        select p.id, p.workspace_id, a.created_at < now() - make_interval(mins => ${STUCK_DEADLINE_MINUTES}) as overdue
        from projects p left join cost_authorizations a on a.id = p.authorization_id and a.workspace_id = p.workspace_id
        where p.state in ('RENDER_RESERVED','RENDERING','QA_RUNNING','COMPOSING','PLATFORM_VARIANTS','FINAL_QA')
          and p.updated_at < now() - interval '2 minutes'
          and not exists (select 1 from workspace_leases l where l.workspace_id = p.workspace_id
                          and l.resource = 'produce:' || p.id::text and l.expires_at > now())
          and not exists (select 1 from outbox o where o.workspace_id = p.workspace_id and o.queue = 'produce-project'
                          and o.dispatched_at is null and o.payload->>'projectId' = p.id::text)
          and ${notHeld(tx)}
        limit 200`);
      for (const r of rows) {
        if (r.overdue) await withTenant(r.workspace_id as string, (tx) => failProduction(tx, sysCtx(r.workspace_id as string, 'stuck-sweep'), r.id as string, 'production stalled (no live worker) past the deadline', { code: 'stalled' }));
        else await withSystem((tx) => enqueueFor(tx, r.workspace_id as string, 'produce-project', { projectId: r.id, resume: true }, `produce:${r.id}:stuck:${Math.floor(Date.now() / 300_000)}`, 20));
      }
      return rows.length;
    },
  },
  // Plan 03 P3: an analysis with no progress for 10 minutes (worker lost, job expired) is failed honestly: the
  // SKU waits for the merchant with what was found, instead of "analyzing" forever. System role: every
  // predicate is tied to the SKU's own workspace.
  'sweep-stuck-analysis': {
    cron: '*/5 * * * *',
    run: async () => {
      const rows = await withSystem((tx) => tx`
        select s.id as sku_id, p.id as project_id, s.workspace_id from skus s
        join projects p on p.sku_id = s.id and p.workspace_id = s.workspace_id
        where s.status in ('analyzing', 'active') and p.state in ${tx([...ANALYSIS_STATES])}
          and p.updated_at < now() - interval '10 minutes' and s.created_at < now() - interval '10 minutes'
          and not exists (select 1 from progress_steps ps where ps.workspace_id = s.workspace_id and ps.subject_id = s.id
                          and greatest(ps.started_at, ps.completed_at) > now() - interval '10 minutes')
          and not exists (select 1 from outbox o where o.workspace_id = s.workspace_id and o.queue in ('analyze-product', 'analyze-product-free')
                          and o.dispatched_at is null and o.payload->>'skuId' = s.id::text)
          and not exists (select 1 from workspaces w where w.id = s.workspace_id and w.state = any(${[...JOB_HOLD_STATES]}))
        limit 100`);
      let n = 0;
      for (const r of rows) if (await failAnalysis(sysCtx(r.workspace_id as string, 'analysis-sweep'), r.sku_id as string, r.project_id as string, 'analysis stalled (no progress for 10 minutes)')) n++;
      return n;
    },
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
  // §39: provider jobs a crashed worker left dispatched are reconciled by provider request id — finished renders
  // are copied into our storage and booked at their real cost; abandoned calls are closed (never under-counted).
  'reconcile-provider-jobs': { cron: '*/5 * * * *', run: async () => { const r = await reconcileProviderJobs(); return r.succeeded + r.failed ? r : 0; } },
  'canary-guard': { cron: '*/15 * * * *', run: () => withSystem(async (tx) => { const rolled = await evaluateCanaries(tx); return rolled.length ? rolled : 0; }) },
  'sweep-evidence': { cron: '5 6 * * *', run: () => withSystem((tx) => sweepExpiringEvidence(tx)) },
  // Plan 05 §5: an example asset whose rights expire is removed from every landing page's gallery (Pulse alert).
  'landing-gallery-rights': { cron: '12 * * * *', run: () => withSystem(async (tx) => { const changed = await sweepLandingGalleryRights(tx); return changed.length ? changed : 0; }) },
  // Plan 05 §6: a pricing experiment whose guardrail (refund, dispute or support rate) degrades past its threshold stops.
  'offer-guardrails': { cron: '*/15 * * * *', run: () => withSystem(async (tx) => { const stopped = await sweepOfferGuardrails(tx); return stopped.length ? stopped : 0; }) },
  // Plan 05 §7: nightly full reconciliation of Stripe (customers, subscriptions, recent charges) against our mirror.
  'stripe-reconcile': { cron: '40 3 * * *', run: async () => { const r = await reconcileStripe(); return r.status === 'completed' ? r.counts : 0; } },
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
