import { zipSync, strToU8 } from 'fflate';
import { withSystem, withTenant, type Tx } from '@arkiv/db';
import { DomainError, RETENTION, type WorkspaceState } from '@arkiv/shared';
import { saveAsset, assetUrl } from './assets';
import { assertCan } from './authz';
import type { TenantContext } from './context';
import { emit } from './events';
import { enqueue, Queues } from './outbox';
import { storage } from './storage';
import { transitionWorkspace } from './workspaces';

/**
 * Tenant lifecycle: export, scheduled purge with grace period, purge certificate (plan 02 §7), and churn-risk
 * indicators (§10) that route to value interventions — never automatic discounting.
 */

export async function requestExport(tx: Tx, ctx: TenantContext) {
  assertCan(ctx, 'workspace.export');
  await enqueue(tx, ctx.workspaceId, Queues.exportWorkspace, { requestedBy: ctx.actor }, { singletonKey: `export:${ctx.workspaceId}` });
}

const EXPORT_TABLES = ['brand_brain_versions', 'skus', 'product_facts', 'claims', 'claim_evidence', 'customer_signals', 'customer_themes', 'experiments', 'variants', 'learnings', 'recommendations', 'creatives', 'performance_observations', 'confounders', 'events'];

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
  await tx`update workspaces set purge_at = now() + make_interval(days => ${RETENTION.PURGE_GRACE_DAYS}),
             state_before_purge = ${(w?.state as string) ?? null} where id = ${ctx.workspaceId}`;
}

/**
 * Leave PURGE_SCHEDULED for the state the workspace had before deletion was scheduled. A paid workspace whose
 * subscription ran out during the grace period comes back as CANCELLED (its archive is kept, nothing charged).
 * Shared by the Owner's "undo" and the staff console.
 */
export async function restoreFromScheduledPurge(tx: Tx, ctx: Pick<TenantContext, 'workspaceId' | 'actor'>, reason: string): Promise<WorkspaceState> {
  const [w] = await tx`select state, state_before_purge, plan_code from workspaces where id = ${ctx.workspaceId} for update`;
  if (!w) throw new DomainError('NOT_FOUND', 'Workspace not found');
  if (w.state !== 'PURGE_SCHEDULED') throw new DomainError('CONFLICT', 'This workspace is not scheduled for deletion.');
  // Explicit workspace filter: the staff console calls this as admin_rw, whose policy is not tenant-scoped.
  const [sub] = await tx`select count(*)::int as n from subscriptions where workspace_id = ${ctx.workspaceId} and status in ('active','trialing','past_due')`;
  const before = (w.state_before_purge as WorkspaceState | null) ?? 'CANCELLED';
  let to: WorkspaceState;
  if (before === 'ACTIVE_PAID' || before === 'PAST_DUE') to = sub!.n > 0 && w.plan_code ? 'ACTIVE_PAID' : 'CANCELLED';
  else if (before === 'ACTIVE_FREE' || before === 'CANCELLED') to = before;
  else to = 'CANCELLED'; // e.g. a provisional workspace swept for expiry has no owner state to return to
  await transitionWorkspace(tx, ctx, to, reason);
  await tx`update workspaces set purge_at = null, state_before_purge = null where id = ${ctx.workspaceId}`;
  return to;
}

export async function cancelDeletion(tx: Tx, ctx: TenantContext) {
  assertCan(ctx, 'workspace.cancel_deletion');
  return restoreFromScheduledPurge(tx, ctx, 'owner cancelled deletion');
}

const PURGE_ORDER = ['scene_versions', 'scenes', 'storyboards', 'concepts', 'progress_steps', 'provider_jobs', 'cost_authorizations', 'variants', 'experiment_results', 'creator_packs', 'recommendations', 'learnings', 'confounders', 'performance_observations', 'creatives', 'projects', 'experiments', 'customer_themes', 'customer_signals', 'claim_evidence', 'claims', 'visual_fingerprints', 'product_facts', 'assets', 'uploads', 'skus', 'brand_brain_versions', 'brands', 'integrations', 'invites', 'memberships', 'offers', 'purchases', 'subscriptions', 'outbox', 'idempotency_keys', 'workspace_leases', 'risk_flags', 'break_glass_sessions', 'tenant_notes'];

/**
 * Purge (system job): delete tenant rows and every object version; keep financial/audit records (ledger,
 * consent, events) with personal data removed; write a purge certificate.
 */
export async function purgeWorkspace(workspaceId: string): Promise<Record<string, number>> {
  return withSystem(async (tx) => {
    const [w] = await tx`select state, purge_at from workspaces where id = ${workspaceId} for update`;
    if (!w) throw new DomainError('NOT_FOUND', 'Workspace not found');
    if (w.state !== 'PURGE_SCHEDULED' || (w.purge_at && new Date(w.purge_at as string) > new Date())) throw new DomainError('CONFLICT', 'Workspace is not due for purge');
    const counts: Record<string, number> = {};
    const undeletable: string[] = [];
    await tx`delete from shopify_shops where workspace_id = ${workspaceId}`;
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
  const rows = await tx`update workspaces set state = 'PURGE_SCHEDULED', purge_at = now()
                        where state = 'PROVISIONAL' and provisional_expires_at < now() returning id`;
  return rows.map((r) => r.id as string);
}

export async function duePurges(tx: Tx): Promise<string[]> {
  return (await tx`select id from workspaces where state = 'PURGE_SCHEDULED' and purge_at <= now() limit 50`).map((r) => r.id as string);
}

/** Cancelled workspaces past the disclosed retention window are scheduled for purge (§10 return value). */
export async function sweepRetention(tx: Tx): Promise<number> {
  const r = await tx`update workspaces set state = 'PURGE_SCHEDULED', purge_at = now() + make_interval(days => ${RETENTION.PURGE_GRACE_DAYS})
                     where state = 'CANCELLED' and cancelled_at < now() - make_interval(days => ${RETENTION.CANCELLED_ARCHIVE_DAYS}) returning id`;
  return r.count;
}

export interface RiskIndicator {
  indicator: string;
  evidence: Record<string, unknown>;
}

/**
 * Leading churn indicators (§10). Each maps to a value intervention in the admin playbooks. Every query names
 * the workspace explicitly: this must be correct under any role, including system_rw whose policies are not
 * tenant-scoped (defence in depth on top of RLS).
 */
export async function computeRisk(tx: Tx, workspaceId: string): Promise<RiskIndicator[]> {
  const ws = workspaceId;
  const out: RiskIndicator[] = [];
  const [act] = await tx`select max(at) as last from events where workspace_id = ${ws} and actor like 'user:%'`;
  if (act?.last && Date.now() - new Date(act.last as string).getTime() > 7 * 86400_000) out.push({ indicator: 'no_activity_7d', evidence: { lastActivity: act.last } });
  const [paidNoExport] = await tx`select count(*)::int as n from projects p where p.workspace_id = ${ws} and p.state = 'COMPLETE' and p.kind in ('taste','standalone')
                                  and not exists (select 1 from events e where e.workspace_id = ${ws} and e.type = 'ASSET_EXPORTED' and e.subject_id = p.id)`;
  if (paidNoExport!.n > 0) out.push({ indicator: 'paid_no_export', evidence: { projects: paidNoExport!.n } });
  const [qa] = await tx`select count(*)::int as n from events where workspace_id = ${ws} and type = 'QA_FAILED' and at > now() - interval '30 days'`;
  if (qa!.n >= 3) out.push({ indicator: 'repeated_qa_rejection', evidence: { count: qa!.n } });
  const [ignored] = await tx`select count(distinct week_of)::int as n from recommendations where workspace_id = ${ws} and status = 'open' and week_of < now() - interval '7 days'`;
  if (ignored!.n >= 3) out.push({ indicator: 'recommendations_ignored', evidence: { weeks: ignored!.n } });
  const [disc] = await tx`select count(*)::int as n from integrations where workspace_id = ${ws} and provider in ('meta','tiktok') and status in ('revoked','degraded')`;
  if (disc!.n > 0) out.push({ indicator: 'ad_account_disconnected', evidence: { count: disc!.n } });
  const [oos] = await tx`select count(*)::int as n from skus where workspace_id = ${ws} and status = 'out_of_stock'`;
  if (oos!.n > 0) out.push({ indicator: 'product_out_of_stock', evidence: { skus: oos!.n } });
  const [perf] = await tx`select count(*)::int as n from experiments where workspace_id = ${ws} and state in ('GATHERING_SIGNAL','DIRECTIONAL','ACTIONABLE') and updated_at > now() - interval '30 days'`;
  const [sub] = await tx`select count(*)::int as n from subscriptions where workspace_id = ${ws} and status = 'active'`;
  if (sub!.n > 0 && perf!.n === 0) out.push({ indicator: 'no_performance_linked_test_30d', evidence: {} });
  return out;
}

/** Recompute one workspace's flags: resolve what no longer applies, raise what is new. Scoped explicitly. */
export async function refreshRiskFlags(tx: Tx, workspaceId: string) {
  const current = await computeRisk(tx, workspaceId);
  const names = current.map((c) => c.indicator);
  await tx`update risk_flags set resolved_at = now() where workspace_id = ${workspaceId} and resolved_at is null and not (indicator = any(${names}))`;
  for (const c of current) {
    const [open] = await tx`select 1 from risk_flags where workspace_id = ${workspaceId} and indicator = ${c.indicator} and resolved_at is null`;
    if (!open) await tx`insert into risk_flags (workspace_id, indicator, evidence) values (${workspaceId}, ${c.indicator}, ${tx.json(c.evidence as never)})`;
  }
  return current;
}
