import { zipSync, strToU8 } from 'fflate';
import { withSystem, withTenant, type Tx } from '@arkiv/db';
import { DomainError, type RiskIndicator, type WorkspaceState } from '@arkiv/shared';
import { saveAsset, assetUrl } from './assets';
import { assertCan } from './authz';
import type { TenantContext } from './context';
import { emit } from './events';
import { enqueue, Queues } from './outbox';
import { revokeAtPlatform, tokenShared } from './performance';
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
  const [a] = await tx`select 1 from assets where workspace_id = ${workspaceId} and kind = 'export_archive'
                       and created_at >= ${new Date(requestedAt)} and deleted_at is null limit 1`;
  return !!a;
}

const EXPORT_TABLES = ['brand_brain_versions', 'skus', 'sku_variants', 'product_facts', 'claims', 'claim_evidence', 'customer_signals', 'customer_themes', 'sku_reviews', 'experiments', 'variants', 'learnings', 'recommendations', 'creatives', 'performance_observations', 'confounders', 'events'];

/** One CSV cell (RFC 4180): objects and arrays as JSON, dates as ISO, quoted when needed. */
function csvCell(v: unknown): string {
  if (v == null) return '';
  const s = v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Rows as CSV with a header line (the union of the rows' columns, in first-seen order). */
export function toCsv(rows: readonly Record<string, unknown>[]): string {
  const cols: string[] = [];
  for (const r of rows) for (const k of Object.keys(r)) if (!cols.includes(k)) cols.push(k);
  return [cols.map(csvCell).join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\r\n') + '\r\n';
}

const EXPORT_ASSET_PAGE = 200;

/**
 * Workspace export (plan 02 §7): every table as JSON and CSV, and every stored file the workspace owns (all asset
 * kinds, paged through without a cap), except earlier export archives.
 */
export async function buildExport(ctx: TenantContext): Promise<{ assetId: string; url: string }> {
  const ws = ctx.workspaceId;
  const files: Record<string, Uint8Array> = {};
  const missing: string[] = [];
  await withTenant(ws, async (tx) => {
    for (const t of EXPORT_TABLES) {
      const rows = await tx.unsafe(`select * from ${t} order by 1`);
      files[`data/${t}.json`] = strToU8(JSON.stringify(rows, null, 2));
      files[`data/${t}.csv`] = strToU8(toCsv(rows as unknown as Record<string, unknown>[]));
    }
  });
  let after = '00000000-0000-0000-0000-000000000000';
  for (;;) {
    const page = await withTenant(ws, (tx) => tx`select id, kind, storage_key, mime from assets where deleted_at is null and kind <> 'export_archive' and id > ${after}
                                                 order by id limit ${EXPORT_ASSET_PAGE}`);
    for (const a of page) {
      try {
        files[`assets/${a.kind}/${a.id}.${String(a.mime).split('/')[1]?.split(';')[0] ?? 'bin'}`] = new Uint8Array(await storage().get(a.storage_key as string));
      } catch {
        missing.push(`${a.kind as string}/${a.id as string}`);
      }
    }
    if (page.length < EXPORT_ASSET_PAGE) break;
    after = page[page.length - 1]!.id as string;
  }
  files['README.txt'] = strToU8(
    `Arkiv workspace export. data/*.json and data/*.csv are your records with provenance (JSON cells hold nested values); assets/ are your files.\n${missing.length ? `\nFiles that could not be read from storage:\n${missing.join('\n')}\n` : ''}`,
  );
  const zip = Buffer.from(zipSync(files, { level: 6 }));
  return withTenant(ws, async (tx) => {
    const a = await saveAsset(tx, ws, { bytes: zip, mime: 'application/zip', kind: 'export_archive', source: 'composed', lineage: { export: true } });
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

const PURGE_ORDER = ['render_quotes', 'sku_reviews', 'scene_versions', 'scenes', 'storyboards', 'concepts', 'progress_steps', 'provider_jobs', 'cost_authorizations', 'variants', 'experiment_results', 'experiment_comparisons', 'creator_packs', 'recommendations', 'learnings', 'confounders', 'performance_observations', 'creatives', 'projects', 'sku_variants', 'experiments', 'customer_themes', 'customer_signals', 'claim_evidence', 'claims', 'visual_fingerprints', 'product_facts', 'assets', 'uploads', 'skus', 'brand_brain_versions', 'brands', 'integration_rate_limits', 'integrations', 'invites', 'ownership_transfers', 'notification_prefs', 'memberships', 'offers', 'outbox', 'held_jobs', 'idempotency_keys', 'workspace_leases', 'risk_flags', 'workspace_notices', 'break_glass_sessions', 'tenant_notes', 'compliance_reviews', 'qa_reviews'];

/**
 * Rows that outlive a purge, by law or for the record (plan 02 §7 step 4, the Data page's promise): payments and
 * their refunds and disputes, subscriptions, invoices, the ledger, consent, the event log and its audit trail, the
 * email log, the funnel log — each with personal data removed by arkiv_anonymize_workspace — plus privacy and
 * rights cases, abuse signals and the Stripe customer mapping, and the purge certificate itself.
 */
export const PURGE_RETAINED = [
  'purchases', 'refunds', 'stripe_disputes', 'stripe_invoices', 'subscriptions', 'stripe_events', 'stripe_customers', 'ledger_entries', 'consent_records',
  'events', 'email_log', 'funnel_events', 'data_requests', 'rights_cases', 'abuse_signals', 'purge_certificates', 'admin_audit_log',
] as const;

/**
 * Purge (system job): delete tenant rows and every object version; keep financial/audit records (payments,
 * subscriptions, invoices, ledger, consent, events, email and funnel logs) with personal data removed; write a
 * purge certificate.
 */
export async function purgeWorkspace(workspaceId: string, opts: { stripeSubscriptionsCancelled?: string[] } = {}): Promise<Record<string, number>> {
  return withSystem(async (tx) => {
    const [w] = await tx`select state, purge_at from workspaces where id = ${workspaceId} for update`;
    if (!w) throw new DomainError('NOT_FOUND', 'Workspace not found');
    if (w.state !== 'PURGE_SCHEDULED' || (w.purge_at && new Date(w.purge_at as string) > new Date())) throw new DomainError('CONFLICT', 'Workspace is not due for purge');
    // Stripe subscriptions ended before the purge (the worker does it: core can't call Stripe) are on the certificate.
    const counts: Record<string, number> = { stripe_subscriptions_cancelled: opts.stripeSubscriptionsCancelled?.length ?? 0 };
    const undeletable: string[] = [];
    // Plan 02 §7 purge step 1: every stored token is revoked at its platform before the rows go. One that can't be
    // revoked (platform unreachable) is named on the certificate; the purge carries on.
    const tokens = await tx`select provider, external_account_id, token_enc, platform_user_id from integrations where workspace_id = ${workspaceId} and token_enc is not null`;
    counts.integration_tokens_revoked = 0;
    for (const i of tokens) {
      // A login another workspace still uses (an agency connecting several brands) is not revoked for it.
      const elsewhere = i.provider === 'shopify' ? [] : await tx`select token_enc, platform_user_id from integrations
                                                                 where provider = ${i.provider} and workspace_id <> ${workspaceId} and token_enc is not null and status in ('active', 'degraded')`;
      if (tokenShared(i as unknown as { token_enc: string; platform_user_id: string | null }, elsewhere as unknown as { token_enc: string | null; platform_user_id: string | null }[])) continue;
      const r = await revokeAtPlatform(i.provider as string, i.token_enc as string, i.external_account_id as string);
      if (r.ok) counts.integration_tokens_revoked++;
      else undeletable.push(`${i.provider as string} access for ${i.external_account_id as string} not revoked at the platform: ${r.error}`);
    }
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
    // Financial/audit retention (plan 02 §7 step 4): kept rows lose their personal data — user actors become the
    // anonymous form, IPs, user agents, addresses, names and emails are removed from logs and payloads.
    const [anon] = await tx`select arkiv_anonymize_workspace(${workspaceId}) as r`;
    Object.assign(counts, anon!.r as Record<string, number>);
    await transitionWorkspace(tx, { workspaceId, actor: { kind: 'system', id: 'purge' } }, 'PURGED', 'purge job');
    await tx`update workspaces set name = 'Deleted workspace', tags = '{}', stripe_customer_id = null,
               provisional_token_hash = null, slug = 'deleted-' || substr(id::text, 1, 8) where id = ${workspaceId}`;
    await tx`insert into purge_certificates (workspace_id, counts, objects_deleted, undeletable) values (${workspaceId}, ${tx.json(counts)}, ${objects}, ${tx.json(undeletable)})`;
    await emit(tx, { workspaceId, actor: { kind: 'system', id: 'purge' } }, 'WORKSPACE_PURGED', { type: 'workspace', id: workspaceId }, { objects });
    return counts;
  });
}

const SWEEP_ACTOR = { kind: 'system', id: 'sweep' } as const;

/**
 * Provisional workspaces that were never claimed are purged after 7 days (plan 02 §2.1). Each move goes through
 * transitionWorkspace, so it emits WORKSPACE_STATE_CHANGED with actor, reason and previous state (plan 02 §2).
 */
export async function sweepProvisional(tx: Tx): Promise<string[]> {
  const due = await tx`select id from workspaces where state = 'PROVISIONAL' and provisional_expires_at < now() order by id limit 500 for update skip locked`;
  for (const w of due) {
    await transitionWorkspace(tx, { workspaceId: w.id as string, actor: SWEEP_ACTOR }, 'PURGE_SCHEDULED', 'unclaimed preview expired');
    await tx`update workspaces set purge_at = now() where id = ${w.id}`;
  }
  return due.map((r) => r.id as string);
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
  const due = await tx`select id from workspaces where state = 'CANCELLED' and cancelled_at < now() - make_interval(days => ${archiveDays})
                       order by id limit 500 for update skip locked`;
  for (const w of due) {
    await transitionWorkspace(tx, { workspaceId: w.id as string, actor: SWEEP_ACTOR }, 'PURGE_SCHEDULED', `cancelled archive kept ${archiveDays} days`);
    await tx`update workspaces set purge_at = now() + make_interval(days => ${graceDays}) where id = ${w.id}`;
  }
  return due.length;
}

/** A purge notice due now (plan 02 §2: "email at T-14d and T-1d"). `at` keys it: one email per notice. */
export interface PurgeNotice {
  workspaceId: string;
  stage: 'retention_ending' | 'scheduled' | 'final';
  purgeOn: string;
  at: string;
}

/**
 * Purge notices due (runs as the system role, so every query names its workspace rows explicitly):
 *  - T-14d for a cancelled workspace's archive: the date it will be purged is cancelled_at + archive + grace;
 *  - when a deletion is scheduled (owner, staff or the retention sweep) — the owner can cancel it until then;
 *  - T-1d before any scheduled purge.
 * Unclaimed previews (scheduled from PROVISIONAL) have no owner and get none.
 */
export async function duePurgeNotices(tx: Tx): Promise<PurgeNotice[]> {
  const archiveDays = await setting(tx, 'retention.cancelled_archive_days');
  const graceDays = await setting(tx, 'retention.purge_grace_days');
  const retention = await tx`select id, cancelled_at + make_interval(days => ${archiveDays + graceDays}) as purge_on from workspaces
                             where state = 'CANCELLED' and cancelled_at is not null
                               and cancelled_at + make_interval(days => ${archiveDays + graceDays}) - interval '14 days' <= now()
                               and cancelled_at + make_interval(days => ${archiveDays}) > now()`;
  const scheduled = await tx`select id, purge_at from workspaces where state = 'PURGE_SCHEDULED' and purge_at > now()
                               and coalesce(state_before_purge, '') <> 'PROVISIONAL'`;
  const iso = (v: unknown) => new Date(v as string).toISOString();
  const out: PurgeNotice[] = retention.map((w) => ({ workspaceId: w.id as string, stage: 'retention_ending', purgeOn: iso(w.purge_on), at: `T14:${iso(w.purge_on).slice(0, 10)}` }));
  for (const w of scheduled) {
    // Within a day of the purge only the final notice goes out (a deletion scheduled that late gets one email).
    if (new Date(w.purge_at as string).getTime() - Date.now() <= 86400_000) out.push({ workspaceId: w.id as string, stage: 'final', purgeOn: iso(w.purge_at), at: `T1:${iso(w.purge_at)}` });
    else out.push({ workspaceId: w.id as string, stage: 'scheduled', purgeOn: iso(w.purge_at), at: `scheduled:${iso(w.purge_at)}` });
  }
  return out;
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
  falling_acceptance: {
    label: 'Falling acceptance rate',
    intervention: 'Review the last month’s dismissed recommendations with the brand; recalibrate what we suggest (angles, budget, SKUs).',
    email: { headline: 'Are we suggesting the right tests?', body: 'You’ve been picking fewer of our recommended tests lately. Tell us what’s off — the angle, the product, the budget — and we’ll adjust what we suggest next week.', cta: 'Review this week’s tests', path: '/this-week' },
    notice: { headline: 'Help us suggest better tests', body: 'Dismiss a recommendation with a reason and we’ll learn what you want to test.', cta: 'Review tests', path: '/this-week' },
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
 * §10 "falling experiment acceptance rate": the share of decided recommendations accepted dropped by at least 20
 * points between the prior and the recent four weeks, each with at least 4 decisions.
 */
export function acceptanceFalling(prior: { accepted: number; decided: number }, recent: { accepted: number; decided: number }): { from: number; to: number; decided: number } | null {
  if (prior.decided < 4 || recent.decided < 4) return null;
  const from = prior.accepted / prior.decided;
  const to = recent.accepted / recent.decided;
  return from - to >= 0.2 ? { from: Math.round(from * 100) / 100, to: Math.round(to * 100) / 100, decided: recent.decided } : null;
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

  // Three recommendation cycles ignored: the last three completed weeks that had recommendations each ended with
  // none accepted (accepting one of three counts as engaging with that week, whatever happened to the others).
  const [ign] = await tx`with weeks as (select week_of, count(*) filter (where status = 'accepted') as accepted from recommendations
                                        where workspace_id = ${ws} and week_of < date_trunc('week', now())::date
                                        group by week_of order by week_of desc limit 3)
                         select count(*)::int as n, count(*) filter (where accepted = 0)::int as ignored, max(week_of) as last from weeks`;
  if (ign!.n === 3 && ign!.ignored === 3) out.push({ indicator: 'ignored_recommendations', evidence: { weeks: 3, lastWeek: ign!.last } });

  // Falling acceptance rate (§10): recommendations decided (accepted or dismissed) in the last 4 weeks vs the 4
  // before, with enough decisions in each to compare.
  const [acc] = await tx`select count(*) filter (where status = 'accepted' and week_of >= current_date - 28)::int as a1,
                                count(*) filter (where status in ('accepted','dismissed') and week_of >= current_date - 28)::int as d1,
                                count(*) filter (where status = 'accepted' and week_of < current_date - 28 and week_of >= current_date - 56)::int as a0,
                                count(*) filter (where status in ('accepted','dismissed') and week_of < current_date - 28 and week_of >= current_date - 56)::int as d0
                         from recommendations where workspace_id = ${ws} and week_of >= current_date - 56`;
  const falling = acceptanceFalling({ accepted: acc!.a0, decided: acc!.d0 }, { accepted: acc!.a1, decided: acc!.d1 });
  if (falling) out.push({ indicator: 'falling_acceptance', evidence: falling });

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
  const [curSub] = await tx`select to_char(current_period_start at time zone 'UTC', 'YYYY-MM-DD') as k, created_at from subscriptions where workspace_id = ${ws} and status in ('active','trialing','past_due') order by created_at desc limit 1`;
  const [friction] = await tx`select max(at) as at from events where workspace_id = ${ws} and type = 'PROJECT_STATE_CHANGED'
                              and payload->>'to' = 'NEEDS_USER_ACTION' and at > now() - interval '30 days'`;
  out.push(
    ...utilisationSignals(
      periods.map((p) => ({ periodKey: p.period_key as string, granted: Number(p.granted), consumed: Number(p.consumed) })),
      (curSub?.k as string) ?? null,
      friction?.at ? { at: friction.at as string } : null,
    ),
  );

  // Performance-linked means results actually arrived for a test variant (current observation revisions), not
  // merely an experiment in a signal state. A subscriber gets 30 days before this can be raised.
  const [linked] = await tx`select max(o.date) as last from performance_observations o
                            join variants v on v.id = o.variant_id and v.workspace_id = o.workspace_id
                            where o.workspace_id = ${ws} and o.superseded_at is null`;
  const lastLinked = linked?.last ? new Date(linked.last as string) : null;
  if (curSub && new Date(curSub.created_at as string).getTime() < Date.now() - 30 * DAY && (!lastLinked || lastLinked.getTime() < Date.now() - 30 * DAY)) {
    out.push({ indicator: 'no_performance_linked_test', evidence: { lastLinkedTest: linked?.last ?? null } });
  }

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
    const [flag] = await tx`insert into risk_flags (workspace_id, indicator, evidence) values (${ws}, ${c.indicator}, ${tx.json(c.evidence as never)}) returning id`;
    await routeIntervention(tx, ws, flag!.id as string, c.indicator);
  }
  return current;
}

/** An indicator's automatic playbook runs at most once in this many days per workspace (no nagging). */
export const AUTO_INTERVENTION_DAYS = 30;

/**
 * §10 "These triggers should route to product interventions and lifecycle messaging, not automatic discounting":
 * a newly raised flag starts its playbook — the in-app notice and the lifecycle email to owners and admins — unless
 * the same indicator's playbook ran for this workspace in the last 30 days. Recorded on the flag (by: system) so
 * staff see it on the Risk tab; staff can still start it again by hand. Never a discount.
 */
async function routeIntervention(tx: Tx, ws: string, flagId: string, indicator: RiskIndicator) {
  const pb = RISK_PLAYBOOKS[indicator];
  if (!pb.email && !pb.notice) return; // a personal follow-up (support sentiment) stays with staff
  const [recent] = await tx`select 1 from risk_flags where workspace_id = ${ws} and indicator = ${indicator} and id <> ${flagId}
                            and raised_at > now() - make_interval(days => ${AUTO_INTERVENTION_DAYS}) and jsonb_array_length(interventions) > 0 limit 1`;
  if (recent) return;
  if (pb.email) await enqueue(tx, ws, Queues.sendEmail, { template: 'intervention', indicator, flagId, run: 1 }, { singletonKey: `intervention:${flagId}:1` });
  if (pb.notice) {
    const source = `risk:${indicator}`;
    await tx`update workspace_notices set dismissed_at = now() where workspace_id = ${ws} and source = ${source} and dismissed_at is null`;
    await tx`insert into workspace_notices (workspace_id, kind, source, title, body, link_path, link_label, created_by)
             values (${ws}, 'intervention', ${source}, ${pb.notice.headline}, ${pb.notice.body}, ${pb.notice.path}, ${pb.notice.cta}, 'system:risk-flags')`;
  }
  const entry = { playbook: indicator, at: new Date().toISOString(), by: 'system', emailed: !!pb.email, notice: !!pb.notice, note: 'started automatically when the indicator was raised' };
  await tx`update risk_flags set interventions = interventions || ${tx.json([entry])} where id = ${flagId} and workspace_id = ${ws}`;
}
