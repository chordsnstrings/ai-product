import { withAdmin, withSystem, type Tx } from '@arkiv/db';
import { DomainError, newId, type WorkspaceState } from '@arkiv/shared';
import { assertBreakGlass, assertStaff, audit, type Staff } from './admin';
import { emit } from './events';
import { withClaimChange } from './claims';
import { enqueue, Queues } from './outbox';
import { storage } from './storage';

/**
 * "Transfer SKU to workspace" (plan 05 §2.3): merging workspaces isn't supported, so staff move SKUs one at a time
 * with the owner's written consent. One job copies the SKU's product truth — the SKU, its facts, sizes/shades
 * (sku_variants), claims and their evidence, visual fingerprints and assets (stored objects included) — into the target workspace with new ids,
 * rewriting every reference between them, then archives the source SKU. Experiments, productions and performance
 * stay with the workspace that ran them. Both workspaces get an event; the request and its outcome are audited.
 */

/** Workspaces that can take part in a transfer (live, not held or being deleted). */
const TRANSFERABLE: ReadonlySet<WorkspaceState> = new Set(['ACTIVE_FREE', 'ACTIVE_PAID', 'PAST_DUE', 'CANCELLED']);

export async function requestSkuTransfer(s: Staff, input: { fromWorkspaceId: string; skuId: string; toWorkspaceId: string; consentRef: string; reason: string }) {
  assertStaff(s, 'breakglass.write');
  const { fromWorkspaceId: from, toWorkspaceId: to, skuId } = input;
  if (input.consentRef.trim().length < 4) throw new DomainError('INVALID', 'Reference the owner’s written consent (ticket or email).');
  if (input.reason.trim().length < 4) throw new DomainError('INVALID', 'A reason is required.');
  if (from === to) throw new DomainError('INVALID', 'Choose a different target workspace.');
  return withAdmin(async (tx) => {
    // Moving tenant content is a break-glass write on the source (audited as content.write).
    await assertBreakGlass(tx, s, from, `transfer SKU ${skuId} to workspace ${to}`, true);
    const ws = await tx`select id, state, name from workspaces where id in ${tx([from, to])}`;
    const src = ws.find((w) => w.id === from);
    const dst = ws.find((w) => w.id === to);
    if (!src || !dst) throw new DomainError('NOT_FOUND', 'Target workspace not found');
    for (const w of [src, dst]) if (!TRANSFERABLE.has(w.state as WorkspaceState)) throw new DomainError('CONFLICT', `${w.name as string} is ${String(w.state).toLowerCase()}; transfers need two live workspaces.`);
    const [sku] = await tx`select catalogue_no, name, status from skus where id = ${skuId} and workspace_id = ${from}`;
    if (!sku) throw new DomainError('NOT_FOUND', 'SKU not found in this workspace');
    if (sku.status === 'archived') throw new DomainError('CONFLICT', 'Archived SKUs aren’t transferred.');
    const [open] = await tx`select id from sku_transfers where sku_id = ${skuId} and status = 'queued'`;
    if (open) throw new DomainError('CONFLICT', 'A transfer of this SKU is already queued.');
    const [t] = await tx`insert into sku_transfers (sku_id, from_workspace_id, to_workspace_id, consent_ref, reason, requested_by)
                         values (${skuId}, ${from}, ${to}, ${input.consentRef.trim()}, ${input.reason.trim()}, ${s.staffId}) returning id`;
    const transferId = t!.id as string;
    await enqueue(tx, from, Queues.transferSku, { transferId }, { singletonKey: `sku-transfer:${transferId}` });
    const detail = { transferId, skuId, catalogueNo: sku.catalogue_no, from, to, consentRef: input.consentRef.trim() };
    await audit(tx, s, 'tenant.sku_transfer_requested', { type: 'sku', id: skuId }, { workspaceId: from, reason: input.reason, after: detail });
    await audit(tx, s, 'tenant.sku_transfer_requested', { type: 'sku', id: skuId }, { workspaceId: to, reason: input.reason, after: detail });
    return { transferId };
  });
}

const quote = (ident: string) => `"${ident.replace(/"/g, '""')}"`;

async function columnsOf(tx: Tx, table: string): Promise<string[]> {
  const rows = await tx`select column_name from information_schema.columns
                        where table_schema = 'public' and table_name = ${table} and is_generated = 'NEVER' order by ordinal_position`;
  return rows.map((r) => r.column_name as string);
}

/**
 * Copy rows of `table` selected by `where`, overriding some columns with SQL expressions. Every other column —
 * including ones added by later migrations — is copied as is, so nothing is silently dropped. Values are bound as
 * `{{name}}` placeholders, numbered per statement so each one has a type Postgres can infer.
 */
async function copyRows(tx: Tx, table: string, where: string, overrides: Record<string, string>, values: Record<string, unknown>): Promise<number> {
  const cols = await columnsOf(tx, table);
  const unknown = Object.keys(overrides).filter((c) => !cols.includes(c));
  if (unknown.length) throw new Error(`copyRows(${table}): no column ${unknown.join(', ')}`);
  const exprs = cols.map((c) => overrides[c] ?? quote(c));
  const params: unknown[] = [];
  const slot = new Map<string, number>();
  const sql = `insert into ${quote(table)} (${cols.map(quote).join(', ')}) select ${exprs.join(', ')} from ${quote(table)} where ${where}`.replace(/\{\{(\w+)\}\}/g, (_, name: string) => {
    if (!(name in values)) throw new Error(`copyRows(${table}): no value for ${name}`);
    if (!slot.has(name)) {
      params.push(values[name]);
      slot.set(name, params.length);
    }
    return `$${slot.get(name)}`;
  });
  const r = await tx.unsafe(sql, params as never[]);
  return r.count;
}

export interface SkuTransferResult {
  status: 'completed' | 'skipped' | 'failed';
  newSkuId?: string;
  counts?: Record<string, number>;
  error?: string;
}

/** The job (worker, system role): every statement is filtered by the source or target workspace explicitly. */
export async function transferSku(transferId: string): Promise<SkuTransferResult> {
  try {
    return await withSystem(async (tx) => {
      const [t] = await tx`select * from sku_transfers where id = ${transferId} for update`;
      if (!t || t.status !== 'queued') return { status: 'skipped' as const };
      const from = t.from_workspace_id as string;
      const to = t.to_workspace_id as string;
      const skuId = t.sku_id as string;
      const ws = await tx`select id, state from workspaces where id in ${tx([from, to])} for update`;
      for (const w of ws) if (!TRANSFERABLE.has(w.state as WorkspaceState)) throw new DomainError('CONFLICT', `workspace ${w.id as string} is ${String(w.state).toLowerCase()}`);
      const [sku] = await tx`select id, catalogue_no, status from skus where id = ${skuId} and workspace_id = ${from} for update`;
      if (!sku) throw new DomainError('NOT_FOUND', 'SKU no longer exists in the source workspace');
      if (sku.status === 'archived') throw new DomainError('CONFLICT', 'SKU was archived before the transfer ran');

      // New ids for everything that moves, and the maps that rewrite references between them.
      const newSku = newId();
      const facts = await tx`select id from product_facts where workspace_id = ${from} and sku_id = ${skuId}`;
      const claims = await tx`select id from claims where workspace_id = ${from} and sku_id = ${skuId}`;
      const evidence = await tx`select e.id, e.source_asset_id from claim_evidence e join claims c on c.id = e.claim_id and c.workspace_id = e.workspace_id
                                where e.workspace_id = ${from} and c.sku_id = ${skuId}`;
      const fingerprints = await tx`select id, reference_asset_ids, cutout_asset_id from visual_fingerprints where workspace_id = ${from} and sku_id = ${skuId}`;
      const skuVariants = await tx`select id, image_asset_ids from sku_variants where workspace_id = ${from} and sku_id = ${skuId}`;
      const referenced = new Set<string>([
        ...evidence.map((e) => e.source_asset_id as string | null),
        ...fingerprints.flatMap((f) => [...((f.reference_asset_ids as string[]) ?? []), f.cutout_asset_id as string | null]),
        ...skuVariants.flatMap((sv) => (sv.image_asset_ids as string[]) ?? []),
      ].filter((x): x is string => !!x));
      const assets = await tx`select id, storage_key, mime from assets where workspace_id = ${from} and deleted_at is null
                              and (sku_id = ${skuId} or id = any(${[...referenced]}::uuid[]))`;
      const map = (rows: readonly Record<string, unknown>[]) => Object.fromEntries(rows.map((r) => [r.id as string, newId()]));
      const factMap = map(facts);
      const claimMap = map(claims);
      const evidenceMap = map(evidence);
      const fpMap = map(fingerprints);
      const skuVariantMap = map(skuVariants);
      const assetMap = map(assets);
      const keyMap: Record<string, string> = {};
      for (const a of assets) {
        const tail = String(a.storage_key).startsWith(`t/${from}/`) ? String(a.storage_key).slice(`t/${from}/`.length) : String(a.storage_key).replace(/^\/+/, '');
        keyMap[a.id as string] = `t/${to}/transfer/${transferId}/${tail}`;
      }
      // Copy the stored objects first (idempotent on retry: same keys); the rows follow in this transaction.
      for (const a of assets) await storage().put(keyMap[a.id as string]!, await storage().get(a.storage_key as string), a.mime as string);

      const [no] = await tx`update workspaces set next_catalogue_no = next_catalogue_no + 1 where id = ${to} returning next_catalogue_no - 1 as no`;
      const [brand] = await tx`select id from brands where workspace_id = ${to} order by created_at limit 1`;
      const counts: Record<string, number> = {};
      const v = {
        from, to, oldSku: skuId, newSku, no: Number(no!.no), brand: (brand?.id as string) ?? null,
        // Maps bind as JSON text cast in SQL (::text::jsonb), so they arrive intact with or without prepared statements.
        assets: JSON.stringify(assetMap), keys: JSON.stringify(keyMap), facts: JSON.stringify(factMap), claims: JSON.stringify(claimMap), evidence: JSON.stringify(evidenceMap), fps: JSON.stringify(fpMap),
        skuVariants: JSON.stringify(skuVariantMap),
      };
      const remap = (map: string, col: string) => `({{${map}}}::text::jsonb ->> ${quote(col)}::text)::uuid`;
      counts.skus = await copyRows(tx, 'skus', `workspace_id = {{from}}::uuid and id = {{oldSku}}::uuid`, { id: '{{newSku}}::uuid', workspace_id: '{{to}}::uuid', catalogue_no: '{{no}}::int', brand_id: '{{brand}}::uuid', shopify_product_id: 'null' }, v);
      counts.assets = await copyRows(tx, 'assets', `workspace_id = {{from}}::uuid and {{assets}}::text::jsonb ? id::text`, {
        id: remap('assets', 'id'), workspace_id: '{{to}}::uuid', sku_id: `case when sku_id = {{oldSku}}::uuid then {{newSku}}::uuid end`, storage_key: `{{keys}}::text::jsonb ->> id::text`,
      }, v);
      counts.product_facts = await copyRows(tx, 'product_facts', `workspace_id = {{from}}::uuid and sku_id = {{oldSku}}::uuid`, {
        id: remap('facts', 'id'), workspace_id: '{{to}}::uuid', sku_id: '{{newSku}}::uuid', supersedes_fact_id: remap('facts', 'supersedes_fact_id'),
        brand_id: '{{brand}}::uuid',
      }, v);
      // Sizes/shades with their price, availability and images (standard §42), so creative in the target
      // workspace can still name the right variant.
      counts.sku_variants = await copyRows(tx, 'sku_variants', `workspace_id = {{from}}::uuid and sku_id = {{oldSku}}::uuid`, {
        id: remap('skuVariants', 'id'), workspace_id: '{{to}}::uuid', sku_id: '{{newSku}}::uuid',
        image_asset_ids: `array(select ({{assets}}::text::jsonb ->> r::text)::uuid from unnest(image_asset_ids) r where {{assets}}::text::jsonb ? r::text)`,
      }, v);
      counts.visual_fingerprints = await copyRows(tx, 'visual_fingerprints', `workspace_id = {{from}}::uuid and sku_id = {{oldSku}}::uuid`, {
        id: remap('fps', 'id'), workspace_id: '{{to}}::uuid', sku_id: '{{newSku}}::uuid', cutout_asset_id: remap('assets', 'cutout_asset_id'),
        reference_asset_ids: `array(select ({{assets}}::text::jsonb ->> r::text)::uuid from unnest(reference_asset_ids) r where {{assets}}::text::jsonb ? r::text)`,
        approved_view_ids: `array(select ({{assets}}::text::jsonb ->> r::text)::uuid from unnest(approved_view_ids) r where {{assets}}::text::jsonb ? r::text)`,
        label_crop_asset_id: remap('assets', 'label_crop_asset_id'),
        views: `(select coalesce(jsonb_object_agg({{assets}}::text::jsonb ->> e.key, e.value), '{}'::jsonb) from jsonb_each(views) e where {{assets}}::text::jsonb ? e.key)`,
        critical_regions: `(select coalesce(jsonb_agg(r.value || jsonb_build_object('assetId', {{assets}}::text::jsonb ->> (r.value->>'assetId'), 'cropAssetId', {{assets}}::text::jsonb ->> (r.value->>'cropAssetId'))), '[]'::jsonb)
                            from jsonb_array_elements(critical_regions) r where {{assets}}::text::jsonb ? (r.value->>'assetId'))`,
      }, v);
      // Each copied claim starts its history in the target workspace as a 'transferred' version (claims trigger).
      counts.claims = await withClaimChange(tx, { kind: 'transferred', actor: `staff:${t.requested_by as string}`, reason: t.reason as string }, () =>
        copyRows(tx, 'claims', `workspace_id = {{from}}::uuid and sku_id = {{oldSku}}::uuid`, { id: remap('claims', 'id'), workspace_id: '{{to}}::uuid', sku_id: '{{newSku}}::uuid' }, v),
      );
      counts.claim_evidence = await copyRows(tx, 'claim_evidence', `workspace_id = {{from}}::uuid and {{evidence}}::text::jsonb ? id::text`, {
        id: remap('evidence', 'id'), workspace_id: '{{to}}::uuid', claim_id: remap('claims', 'claim_id'), source_asset_id: remap('assets', 'source_asset_id'),
      }, v);

      // The SKU leaves the source catalogue (archived, not deleted: its experiments and history stay readable).
      await tx`update skus set status = 'archived' where id = ${skuId} and workspace_id = ${from}`;
      const payload = { transferId, fromWorkspaceId: from, toWorkspaceId: to, fromSkuId: skuId, toSkuId: newSku, counts };
      // Each tenant's event names only its own rows; the cross-workspace mapping lives in the staff audit log.
      const actor = { kind: 'staff' as const, id: t.requested_by as string };
      await emit(tx, { workspaceId: from, actor }, 'SKU_TRANSFERRED', { type: 'sku', id: skuId }, { direction: 'out', transferId, catalogueNo: Number(sku.catalogue_no), counts });
      await emit(tx, { workspaceId: to, actor }, 'SKU_TRANSFERRED', { type: 'sku', id: newSku }, { direction: 'in', transferId, catalogueNo: Number(no!.no), counts });
      await tx`update sku_transfers set status = 'completed', new_sku_id = ${newSku}, counts = ${tx.json(counts)}, completed_at = now() where id = ${transferId}`;
      for (const w of [from, to]) {
        await tx`insert into admin_audit_log (staff_id, action, target_type, target_id, workspace_id, reason, after)
                 values (${t.requested_by as string}, 'tenant.sku_transfer_completed', 'sku', ${skuId}, ${w}, ${t.reason as string}, ${tx.json(payload)})`;
      }
      return { status: 'completed' as const, newSkuId: newSku, counts };
    });
  } catch (e) {
    if (!(e instanceof DomainError)) throw e; // retried by the queue
    await withSystem((tx) => tx`update sku_transfers set status = 'failed', error = ${e.message}, completed_at = now() where id = ${transferId} and status = 'queued'`);
    return { status: 'failed', error: e.message };
  }
}
