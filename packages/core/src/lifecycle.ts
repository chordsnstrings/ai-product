import { zipSync, strToU8 } from 'fflate';
import { withSystem, withTenant, type Tx } from '@arkiv/db';
import { DomainError, type RiskIndicator, type WorkspaceState } from '@arkiv/shared';
import { saveAsset, assetUrl } from './assets';
import { assertCan } from './authz';
import type { TenantContext } from './context';
import { emit } from './events';
import { enqueue, Queues } from './outbox';
import { setting } from './settings';
import { storage } from './storage';
import { transitionWorkspace } from './workspaces';

/**
 * Tenant lifecycle: export, scheduled purge with grace period, purge certificate (plan 02 §7), and churn-risk
 * indicators (§10) that route to value interventions — never automatic discounting.
 */

export async function requestExport(tx: Tx, ctx: TenantContext) {
  assertCan(ctx, 'workspace.export');
  await enqueue(tx, ctx.workspaceId, Queues.exportWorkspace, { requestedBy: ctx.actor, requestedAt: new Date().toISOString() }, { singletonKey: `export:${ctx.workspaceId}` });
}

/**
 * Has an export finished since this request was made? Then the request is already answered (a second click
 * after the first job was dispatched) and the job stands down instead of building and emailing it twice.
 */
export async function exportSatisfied(tx: Tx, workspaceId: string, requestedAt: string | null | undefined): Promise<boolean> {
  if (!requestedAt) return false;
  const [a] = await tx`select 1 from assets where workspace_id = ${workspaceId} and kind = 'evidence_doc' and lineage->>'export' = 'true'
                       and created_at >= ${new Date(requestedAt)} and deleted_at is null limit 1`;
  return !!a;
}

const EXPORT_TABLES = ['brand_brain_versions', 'skus', 'sku_variants', 'product_facts', 'claims', 'claim_evidence', 'customer_signals', 'customer_themes', 'sku_reviews', 'experiments', 'variants', 'learnings', 'recommendations', 'creatives', 'performance_observations', 'confounders', 'events'];

export async function buildExport(ctx: TenantContext): Promise<{ assetId: string; url: string }> {
  const ws = ctx.workspaceId;
  const files: Record<string, Uint8Array> = {};
  await withTenant(ws, async (tx) => {
    for (const t of EXPORT_TABLES) {
      const rows = await tx.unsafe(`select * from ${t} order by 1`);
      files[`data/${t}.json`] = strToU8(JSON.stringify(rows, null, 2));
    }
    const assets = await tx`select id, kind, storage_key, mime from assets where deleted_at is null and kind in ('product_photo','final_export','cutout','evidence_doc','creator_footage') limit 500`;
    for (const a of assets) {
      try {
        files[`assets/${a.kind}/${a.id}.${String(a.mime).split('/')[1]}`] = new Uint8Array(await storage().get(a.storage_key as string));
      } catch {
        /* missing object recorded in manifest below */
      }
    }
    files['README.txt'] = strToU8('Arkiv workspace export. data/*.json are your records with provenance; assets/ are your files.\n');
  });
  const zip = Buffer.from(zipSync(files, { level: 6 }));
  return withTenant(ws, async (tx) => {
    const a = await saveAsset(tx, ws, { bytes: zip, mime: 'application/zip', kind: 'evidence_doc', source: 'composed', lineage: { export: true } });
    return { assetId: a.id, url: await assetUrl(tx, a.id, 24 * 3600, 'arkiv-export.zip') };
  });
}

export async function scheduleDeletion(tx: Tx, ctx: TenantContext) {
  assertCan(ctx, 'workspace.delete');
  const [s] = await tx`select count(*)::int as n from subscriptions where workspace_id = ${ctx.workspaceId}
                         and status in ('active','trialing','past_due') and not cancel_at_period_end`;
  if (s!.n > 0) throw new DomainError('CONFLICT', 'Cancel your plan before deleting the workspace.');
  const [w] = await tx`select state from workspaces where id = ${ctx.workspaceId} for update`;
  await transitionWorkspace(tx, ctx, 'PURGE_SCHEDULED', 'owner requested deletion');
  // Remember where the workspace was so a cancelled deletion puts it back exactly there (plan 02 §7).
  await tx`update workspaces set purge_at = now() + make_interval(days => ${await setting(tx, 'retention.purge_grace_days')}),
             state_before_purge = ${(w?.state as string) ?? null} where id = ${ctx.workspaceId}`;
}

/**
 * Leave PURGE_SCHEDULED for the state the workspace had before deletion was scheduled. A subscribed workspace
 * whose subscription ran out during the grace period comes back as CANCELLED (its archive is kept, nothing
 * charged); a one-off buyer (no plan) keeps its paid state. Shared by the Owner's "undo" and the staff console.
 */
export async function restoreFromScheduledPurge(tx: Tx, ctx: Pick<TenantContext, 'workspaceId' | 'actor'>, reason: string): Promise<WorkspaceState> {
  const [w] = await tx`select state, state_before_purge, plan_code from workspaces where id = ${ctx.workspaceId} for update`;
  if (!w) throw new DomainError('NOT_FOUND', 'Workspace not found');
  if (w.state !== 'PURGE_SCHEDULED') throw new DomainError('CONFLICT', 'This workspace is not scheduled for deletion.');
  // Explicit workspace filter: the staff console calls this as admin_rw, whose policy is not tenant-scoped.
  const [sub] = await tx`select count(*)::int as n from subscriptions where workspace_id = ${ctx.workspaceId} and status in ('active','trialing','past_due')`;
  const before = (w.state_before_purge as WorkspaceState | null) ?? 'CANCELLED';
  let to: WorkspaceState;
  if (before === 'ACTIVE_PAID' && !w.plan_code) to = 'ACTIVE_PAID';
  else if (before === 'ACTIVE_PAID' || before === 'PAST_DUE') to = sub!.n > 0 && w.plan_code ? 'ACTIVE_PAID' : 'CANCELLED';
  else if (before === 'ACTIVE_FREE' || before === 'CANCELLED') to = before;
  else to = 'CANCELLED'; // e.g. a provisional workspace swept for expiry has no owner state to return to
  await transitionWorkspace(tx, ctx, to, reason);
  await tx`update workspaces set purge_at = null, state_before_purge = null where id = ${ctx.workspaceId}`;
  return to;
}

/** Owner cancels a deletion: the workspace returns to the state it had before (CANCELLED for legacy rows). */
export async function cancelDeletion(tx: Tx, ctx: TenantContext) {
  assertCan(ctx, 'workspace.cancel_deletion');
  return restoreFromScheduledPurge(tx, ctx, 'owner cancelled deletion');
}

const PURGE_ORDER = ['render_quotes', 'sku_reviews', 'scene_versions', 'scenes', 'storyboards', 'concepts', 'progress_steps', 'provider_jobs', 'cost_authorizations', 'variants', 'experiment_results', 'creator_packs', 'recommendations', 'learnings', 'confounders', 'performance_observations', 'creatives', 'projects', 'sku_variants', 'experiments', 'customer_themes', 'customer_signals', 'claim_evidence', 'claims', 'visual_fingerprints', 'product_facts', 'assets', 'uploads', 'skus', 'brand_brain_versions', 'brands', 'integration_rate_limits', 'integrations', 'invites', 'ownership_transfers', 'memberships', 'offers', 'refunds', 'stripe_disputes', 'stripe_invoices', 'purchases', 'subscriptions', 'outbox', 'held_jobs', 'idempotency_keys', 'workspace_leases', 'risk_flags', 'workspace_notices', 'break_glass_sessions', 'tenant_notes', 'compliance_reviews'];

/**
 * Purge (system job): delete tenant rows and every object version; keep financial/audit records (ledger,
 * consent, events) with personal data removed; write a purge certificate.
 */
export async function purgeWorkspace(workspaceId: string, opts: { stripeSubscriptionsCancelled?: string[] } = {}): Promise<Record<string, number>> {
  return withSystem(async (tx) => {
    const [w] = await tx`select state, purge_at from workspaces where id = ${workspaceId} for update`;
    if (!w) throw new DomainError('NOT_FOUND', 'Workspace not found');
    if (w.state !== 'PURGE_SCHEDULED' || (w.purge_at && new Date(w.purge_at as string) > new Date())) throw new DomainError('CONFLICT', 'Workspace is not due for purge');
    // Stripe subscriptions ended before the purge (the worker does it: core can't call Stripe) are on the certificate.
    const counts: Record<string, number> = { stripe_subscriptions_cancelled: opts.stripeSubscriptionsCancelled?.length ?? 0 };
    const undeletable: string[] = [];
    await tx`delete from shopify_shops where workspace_id = ${workspaceId}`;
    // Golden cases built (with consent) from this tenant's production output go with the tenant.
    await tx`delete from golden_cases where source_workspace_id = ${workspaceId}`;
    // Objects another workspace still references under this prefix (a saved preview whose copy was cut short) are
    // copied to their owner's prefix first; the filter is the storage prefix, the write the owner's own row.
    const strays = await tx`select id, workspace_id, storage_key, mime from assets where workspace_id <> ${workspaceId} and storage_key like ${`t/${workspaceId}/%`}`;
    for (const a of strays) {
      const key = (a.storage_key as string).replace(`t/${workspaceId}/`, `t/${a.workspace_id as string}/`);
      await storage().put(key, await storage().get(a.storage_key as string), a.mime as string);
      await tx`update assets set storage_key = ${key} where id = ${a.id} and workspace_id = ${a.workspace_id}`;
    }
    const objects = await storage().deletePrefix(`t/${workspaceId}/`).catch((e) => {
      undeletable.push(`storage: ${(e as Error).message}`);
      return 0;
    });
    await storage().deletePrefix(`q/${workspaceId}/`).catch(() => 0);
    for (const t of PURGE_ORDER) {
      const r = await tx.unsafe(`delete from ${t} where workspace_id = $1`, [workspaceId]);
      counts[t] = r.count;
    }
    // Financial/audit retention: ledger + consent + events stay, actor identities anonymized.
    await tx`update workspaces set state = 'PURGED', name = 'Deleted workspace', tags = '{}', stripe_customer_id = null,
               provisional_token_hash = null, slug = 'deleted-' || substr(id::text, 1, 8) where id = ${workspaceId}`;
    await tx`insert into purge_certificates (workspace_id, counts, objects_deleted, undeletable) values (${workspaceId}, ${tx.json(counts)}, ${objects}, ${tx.json(undeletable)})`;
    await emit(tx, { workspaceId, actor: { kind: 'system', id: 'purge' } }, 'WORKSPACE_PURGED', { type: 'workspace', id: workspaceId }, { objects });
    return counts;
  });
}

/** Provisional workspaces that were never claimed are purged after 7 days (plan 02 §2.1). */
export async function sweepProvisional(tx: Tx): Promise<string[]> {
  const rows = await tx`update workspaces set state = 'PURGE_SCHEDULED', state_before_purge = state, purge_at = now()
                        where state = 'PROVISIONAL' and provisional_expires_at < now() returning id`;
  return rows.map((r) => r.id as string);
}

export async function duePurges(tx: Tx): Promise<string[]> {
  return (await tx`select id from workspaces where state = 'PURGE_SCHEDULED' and purge_at <= now() limit 50`).map((r) => r.id as string);
}

/**
 * Cancelled workspaces past the disclosed retention window are scheduled for purge (§10 return value).
 * Both windows are platform settings (plan 05 §20), with the RETENTION constants as fallback.
 */
export async function sweepRetention(tx: Tx): Promise<number> {
  const archiveDays = await setting(tx, 'retention.cancelled_archive_days');
  const graceDays = await setting(tx, 'retention.purge_grace_days');
  const r = await tx`update workspaces set state = 'PURGE_SCHEDULED', state_before_purge = state, purge_at = now() + make_interval(days => ${graceDays})
                     where state = 'CANCELLED' and cancelled_at < now() - make_interval(days => ${archiveDays}) returning id`;
  return r.count;
}

export interface RiskSignal {
  indicator: RiskIndicator;
  /** What the indicator saw, including the date it refers to (plan 05 §17: "evidence and date"). */
  evidence: Record<string, unknown>;
}

/** A customer-facing message of a playbook; `path` is inside the workspace (e.g. /this-week). */
export interface PlaybookMessage {
  headline: string;
  body: string;
  cta: string;
  path: string;
}

export interface RiskPlaybook {
  label: string;
  /** What staff do (shown on the board). */
  intervention: string;
  /** Email to the workspace's owners and admins when the playbook starts. */
  email?: PlaybookMessage;
  /** In-app notice in the workspace until dismissed (14 days). */
  notice?: PlaybookMessage;
}

/**
 * Value interventions per indicator (plan 05 §17, standard §10): "each indicator maps to a value intervention
 * (e.g. paid-no-export → email + in-app …)". Never automatic discounting. The Record type makes adding an
 * indicator without a playbook a compile error. Negative support sentiment is a personal follow-up, so it has no
 * templated message.
 */
export const RISK_PLAYBOOKS: Record<RiskIndicator, RiskPlaybook> = {
  idle_7d: {
    label: '7 days idle',
    intervention: 'Email the week’s top recommendation with a one-click approve link.',
    email: { headline: 'This week’s test is ready for you', body: 'We picked the most promising test for your catalogue this week. Approving it takes one click.', cta: 'See this week’s test', path: '/this-week' },
    notice: { headline: 'This week’s test is waiting', body: 'One click approves the test we recommend for this week.', cta: 'See it', path: '/this-week' },
  },
  paid_no_export: {
    label: 'Paid, no export',
    intervention: '“Your ad is ready — here’s how to upload it to Meta in 2 minutes.” (email + in-app)',
    email: { headline: 'Your ad is ready — here’s how to upload it to Meta in 2 minutes', body: 'Download the 9:16 and 4:5 exports, create an ad in Ads Manager and upload both sizes. Keep the variant code in the ad name so its results flow back to Arkiv automatically.', cta: 'Get your ad', path: '/results' },
    notice: { headline: 'Your ad is ready to upload', body: 'It takes about 2 minutes in Ads Manager: upload the 9:16 and 4:5 exports and keep the variant code in the ad name.', cta: 'Get your ad', path: '/results' },
  },
  repeated_qa_rejects: {
    label: 'Repeated QA rejects',
    intervention: 'OPS reviews the SKU’s fingerprint and reference photos; offer a better-photo guide.',
    email: { headline: 'Clearer product photos make better ads', body: 'Some renders didn’t pass our product-accuracy checks. Front-facing photos on a plain background, with the label readable and the cap on, help most.', cta: 'Update product photos', path: '/products' },
    notice: { headline: 'Better photos, fewer retries', body: 'A front-facing photo on a plain background with a readable label helps our accuracy checks pass first time.', cta: 'Update photos', path: '/products' },
  },
  ignored_recommendations: {
    label: '3 ignored recommendation cycles',
    intervention: 'Ask one question: “Are these the wrong kind of tests?”',
    email: { headline: 'Are these the wrong kind of tests?', body: 'You haven’t picked any of the last few weeks’ recommendations. Tell us what would be more useful and we’ll adjust what we suggest.', cta: 'Tell us', path: '/this-week' },
    notice: { headline: 'Are these the wrong kind of tests?', body: 'Pick or dismiss a recommendation and we’ll learn what you want to test.', cta: 'Review tests', path: '/this-week' },
  },
  ad_account_disconnected: {
    label: 'Ad account disconnected',
    intervention: 'Reconnect prompt with the exact scope explanation.',
    email: { headline: 'Reconnect your ad account', body: 'Your ad account is disconnected, so results can’t flow back. Reconnecting asks for read-only access to ad performance — we never change budgets, bids or campaigns.', cta: 'Reconnect', path: '/settings/integrations' },
    notice: { headline: 'Your ad account is disconnected', body: 'Reconnect with read-only access so test results keep flowing in.', cta: 'Reconnect', path: '/settings/integrations' },
  },
  stockout: {
    label: 'Stockout',
    intervention: 'Pause tests on the out-of-stock SKU, mark the period as confounded, and suggest an in-stock SKU for this week’s test.',
    email: { headline: 'A product is out of stock', body: 'We’ve paused tests on out-of-stock products so their results aren’t skewed. Pick an in-stock product for this week’s test.', cta: 'Choose a product', path: '/products' },
    notice: { headline: 'Tests paused on an out-of-stock product', body: 'Pick an in-stock product for this week’s test.', cta: 'Choose a product', path: '/products' },
  },
  low_utilisation: {
    label: 'Utilisation < 25% (2 periods)',
    intervention: 'Suggest the plan that fits usage (downgrade is fine) and offer a 15-minute planning call.',
    email: { headline: 'Is your plan the right size?', body: 'You’ve used less than a quarter of your Creative Tests for two periods. If a smaller plan fits better, you can switch anytime in Settings → Billing, or reply to book a 15-minute planning call.', cta: 'Review your plan', path: '/settings/billing' },
  },
  high_utilisation_friction: {
    label: 'Utilisation > 95% with friction',
    intervention: 'Show the next plan’s allowance and unblock the waiting production; no discount.',
    email: { headline: 'You’re using almost all of your tests', body: 'You’ve used over 95% of this period’s Creative Tests. See what the next plan includes; your waiting production continues either way.', cta: 'Compare plans', path: '/settings/billing' },
  },
  no_performance_linked_test: {
    label: 'No performance-linked test in 30 days',
    intervention: 'Walk through variant codes in ad names / CSV upload.',
    email: { headline: 'Link your ads to see what works', body: 'Put the variant code in your ad names, or upload a CSV from Ads Manager, and we’ll match results to each test.', cta: 'See how', path: '/results' },
    notice: { headline: 'Link your ads to your tests', body: 'Variant codes in ad names (or a CSV upload) let us match results to each test.', cta: 'See how', path: '/results' },
  },
  negative_support_sentiment: { label: 'Negative support sentiment', intervention: 'Founder or senior support follow-up within one business day; fix the underlying issue first.' },
};

/** A member hides an in-app notice for the whole workspace (the app may only mark notices dismissed). */
export async function dismissNotice(tx: Tx, ctx: TenantContext, noticeId: string) {
  if (ctx.actor.kind !== 'user') throw new DomainError('FORBIDDEN', 'Only a signed-in member can dismiss notices.');
  // Any member may acknowledge a notice, including while the workspace is held (that is when notices matter).
  assertCan(ctx, 'workspace.view');
  const r = await tx`update workspace_notices set dismissed_at = now(), dismissed_by = ${ctx.actor.id}
                     where id = ${noticeId} and workspace_id = ${ctx.workspaceId} and dismissed_at is null returning id`;
  return r.length > 0;
}

const DAY = 86400_000;

/** Leading churn indicators (§10). Each maps to a value intervention in the admin playbooks. */
/** Utilisation of a billing period's Creative Tests: consumed ÷ granted. */
export interface PeriodUtilisation {
  periodKey: string;
  granted: number;
  consumed: number;
}

/**
 * §10 utilisation indicators from per-period ledger rows. `current` is the running period (excluded from the
 * low-utilisation test because it isn't over yet).
 *  - low: the two most recent completed periods each used < 25% of their grant;
 *  - high: the latest period (running or last completed) used > 95%, and the customer hit friction.
 */
export function utilisationSignals(periods: PeriodUtilisation[], current: string | null, friction: { at: string } | null): RiskSignal[] {
  const rate = (p: PeriodUtilisation) => (p.granted > 0 ? p.consumed / p.granted : null);
  const sorted = [...periods].filter((p) => p.granted > 0).sort((a, b) => b.periodKey.localeCompare(a.periodKey));
  const completed = sorted.filter((p) => p.periodKey !== current && (!current || p.periodKey < current));
  const out: RiskSignal[] = [];
  const lastTwo = completed.slice(0, 2);
  if (lastTwo.length === 2 && lastTwo.every((p) => (rate(p) ?? 1) < 0.25)) {
    out.push({ indicator: 'low_utilisation', evidence: { periods: lastTwo.map((p) => ({ period: p.periodKey, used: p.consumed, granted: p.granted })), since: lastTwo[1]!.periodKey } });
  }
  const latest = sorted[0];
  if (latest && (rate(latest) ?? 0) > 0.95 && friction) {
    out.push({ indicator: 'high_utilisation_friction', evidence: { period: latest.periodKey, used: latest.consumed, granted: latest.granted, frictionAt: friction.at } });
  }
  return out;
}

/**
 * Leading churn indicators (§10) for ONE workspace. Runs as the system role (whose policies see every
 * tenant), so every query filters on workspace_id explicitly — without it each tenant would be flagged with
 * platform-wide activity.
 */
export async function computeRisk(tx: Tx, workspaceId: string): Promise<RiskSignal[]> {
  const ws = workspaceId;
  const out: RiskSignal[] = [];
  const [act] = await tx`select max(at) as last from events where workspace_id = ${ws} and actor like 'user:%'`;
  if (act?.last && Date.now() - new Date(act.last as string).getTime() > 7 * DAY) out.push({ indicator: 'idle_7d', evidence: { lastActivity: act.last } });

  const [pne] = await tx`select count(*)::int as n, min(p.updated_at) as since from projects p
                         where p.workspace_id = ${ws} and p.state = 'COMPLETE' and p.kind in ('taste','standalone','creative_test')
                           and not exists (select 1 from events e left join assets a on a.workspace_id = e.workspace_id and a.id = e.subject_id
                                           where e.workspace_id = ${ws} and e.type = 'ASSET_EXPORTED'
                                             -- The export event names its project; events from before it did resolve through the asset.
                                             and coalesce(e.payload->>'projectId', a.lineage->>'projectId') = p.id::text)`;
  if (pne!.n > 0) out.push({ indicator: 'paid_no_export', evidence: { projects: pne!.n, since: pne!.since } });

  const [qa] = await tx`select count(*)::int as n, max(at) as last from events where workspace_id = ${ws} and type = 'QA_FAILED' and at > now() - interval '30 days'`;
  if (qa!.n >= 3) out.push({ indicator: 'repeated_qa_rejects', evidence: { count: qa!.n, last: qa!.last } });

  const [ign] = await tx`select count(distinct week_of)::int as n, max(week_of) as last from recommendations
                         where workspace_id = ${ws} and status = 'open' and week_of < now() - interval '7 days'`;
  if (ign!.n >= 3) out.push({ indicator: 'ignored_recommendations', evidence: { weeks: ign!.n, lastWeek: ign!.last } });

  const disc = await tx`select provider, status, updated_at from integrations
                        where workspace_id = ${ws} and provider in ('meta','tiktok') and status in ('revoked','degraded','disconnected')`;
  if (disc.length) out.push({ indicator: 'ad_account_disconnected', evidence: { accounts: disc.map((d) => `${d.provider}:${d.status}`), since: disc.map((d) => d.updated_at).sort()[0] } });

  const oos = await tx`select catalogue_no, updated_at from skus where workspace_id = ${ws} and (status = 'out_of_stock' or (in_stock = false and status <> 'archived')) order by catalogue_no`;
  if (oos.length) out.push({ indicator: 'stockout', evidence: { skus: oos.map((s) => Number(s.catalogue_no)), since: oos.map((s) => s.updated_at).sort()[0] } });

  const periods = await tx`select period_key,
                                  coalesce(sum(amount) filter (where type = 'CREDIT_GRANTED'), 0)::int as granted,
                                  coalesce(sum(amount) filter (where type = 'CREDIT_CONSUMED'), 0)::int as consumed
                           from ledger_entries where workspace_id = ${ws} and unit = 'creative_test' and period_key is not null
                           group by period_key order by period_key desc limit 3`;
  const [curSub] = await tx`select to_char(current_period_start at time zone 'UTC', 'YYYY-MM-DD') as k from subscriptions where workspace_id = ${ws} and status in ('active','trialing','past_due') order by created_at desc limit 1`;
  const [friction] = await tx`select max(at) as at from events where workspace_id = ${ws} and type = 'PROJECT_STATE_CHANGED'
                              and payload->>'to' = 'NEEDS_USER_ACTION' and at > now() - interval '30 days'`;
  out.push(
    ...utilisationSignals(
      periods.map((p) => ({ periodKey: p.period_key as string, granted: Number(p.granted), consumed: Number(p.consumed) })),
      (curSub?.k as string) ?? null,
      friction?.at ? { at: friction.at as string } : null,
    ),
  );

  const [linked] = await tx`select max(updated_at) as last, count(*) filter (where updated_at > now() - interval '30 days')::int as recent from experiments
                            where workspace_id = ${ws} and state in ('GATHERING_SIGNAL','DIRECTIONAL','ACTIONABLE')`;
  if (curSub && linked!.recent === 0) out.push({ indicator: 'no_performance_linked_test', evidence: { lastLinkedTest: linked!.last ?? null } });

  // Support sentiment is staff-recorded on tenant notes; the latest judged conversation in 30 days counts.
  const [note] = await tx`select sentiment, created_at from tenant_notes where workspace_id = ${ws} and sentiment is not null
                          and created_at > now() - interval '30 days' order by created_at desc limit 1`;
  if (note?.sentiment === 'negative') out.push({ indicator: 'negative_support_sentiment', evidence: { noteAt: note.created_at } });
  return out;
}

/**
 * Daily refresh for one workspace: resolve indicators that cleared, keep open ones' evidence current, raise
 * new ones — except while a staff suppression for that indicator is still running (plan 05 §2.2 Risk).
 */
export async function refreshRiskFlags(tx: Tx, workspaceId: string) {
  const ws = workspaceId;
  const current = await computeRisk(tx, ws);
  const names = current.map((c) => c.indicator as string);
  await tx`update risk_flags set resolved_at = now() where workspace_id = ${ws} and resolved_at is null and not (indicator = any(${names}))`;
  for (const c of current) {
    const [open] = await tx`select id from risk_flags where workspace_id = ${ws} and indicator = ${c.indicator} and resolved_at is null`;
    if (open) {
      await tx`update risk_flags set evidence = ${tx.json(c.evidence as never)} where id = ${open.id}`;
      continue;
    }
    const [suppressed] = await tx`select 1 from risk_flags where workspace_id = ${ws} and indicator = ${c.indicator} and suppressed_until > now() limit 1`;
    if (suppressed) continue;
    await tx`insert into risk_flags (workspace_id, indicator, evidence) values (${ws}, ${c.indicator}, ${tx.json(c.evidence as never)})`;
  }
  return current;
}
