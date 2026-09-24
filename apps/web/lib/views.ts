import { withTenant, type Tx } from '@arkiv/db';
import { assetUrl, currentFacts, currentQuote, customerQaSummary, DELIVERY_HOLD_STATES, IN_PRODUCTION, listClaims, listSteps, liveness, storyboardView, type Proposal, type QaReport } from '@arkiv/core';
import type { ProjectState } from '@arkiv/shared';
import type { WorkspaceState } from '@arkiv/shared';

/** Serializable project view for funnel pages (P3–P10). Asset URLs are short-lived signed URLs (plan 02 layer 4). */
export async function projectView(workspaceId: string, projectId: string) {
  return withTenant(workspaceId, async (tx) => {
    const [p] = await tx`select p.*, s.name as sku_name, s.catalogue_no, s.status as sku_status, s.reject_reason, s.analysis, s.fidelity_confidence
                         from projects p join skus s on s.id = p.sku_id where p.id = ${projectId}`;
    if (!p) return null;
    const skuSteps = await listSteps(tx, p.sku_id as string);
    const facts = await currentFacts(tx, p.sku_id as string);
    const claims = await listClaims(tx, p.sku_id as string);
    const [fp] = await tx`select cutout_asset_id, label_text, package_type, closure from visual_fingerprints where sku_id = ${p.sku_id} and active`;
    const [maxBatch] = await tx`select coalesce(max(batch), 0) as b from concepts where project_id = ${projectId}`;
    const concepts = await tx`select id, idx, proposal, is_pick, pick_reason, batch from concepts where project_id = ${projectId} and batch = ${maxBatch!.b} order by idx`;
    let storyboard: Awaited<ReturnType<typeof storyboardBlock>> | null = null;
    if (p.storyboard_id) storyboard = await storyboardBlock(tx, p.storyboard_id as string);
    // Project-subject steps also hold queued concept requests ("concepts.batch.N"); production shows only its own.
    const projectSteps = await listSteps(tx, projectId);
    const productionSteps = projectSteps.filter((s) => !String(s.step_key).startsWith('concepts.batch.'));
    const conceptStep = projectSteps
      .filter((s) => String(s.step_key).startsWith('concepts.batch.'))
      .sort((a, b) => Number(String(b.step_key).split('.').pop()) - Number(String(a.step_key).split('.').pop()))[0];
    const quote = await currentQuote(tx);
    const [purchase] = await tx`select status, kind, amount_micros from purchases where project_id = ${projectId} order by created_at desc limit 1`;
    let exports: { aspect: string; assetId: string; url: string; download: string }[] = [];
    // Finished work is stored but not delivered while the workspace is suspended (plan 05 §2.3).
    const [ws] = await tx`select state from workspaces where id = ${workspaceId}`;
    const deliveryHeld = DELIVERY_HOLD_STATES.has(ws?.state as WorkspaceState);
    if (p.final_creative_id && !deliveryHeld) {
      const [cr] = await tx`select final_asset_ids from creatives where id = ${p.final_creative_id}`;
      const assets = await tx`select id, lineage from assets where id in ${tx((cr?.final_asset_ids as string[]) ?? ['00000000-0000-0000-0000-000000000000'])}`;
      exports = await Promise.all(
        assets.map(async (a) => {
          const aspect = (a.lineage as { aspect: string }).aspect;
          const name = `${String(p.sku_name).replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${aspect}.mp4`;
          return { aspect, assetId: a.id as string, url: await assetUrl(tx, a.id as string, 3600), download: `/api/assets/${a.id}/download?name=${encodeURIComponent(name)}&project=${projectId}` };
        }),
      );
      exports.sort((a, b) => ['9x16', '4x5', '1x1'].indexOf(a.aspect) - ['9x16', '4x5', '1x1'].indexOf(b.aspect));
    }
    const factRows = Object.entries(facts)
      .filter(([k]) => !['description', 'variants', 'packaging', 'label_text'].includes(k))
      .map(([key, f]) => ({
        key,
        value: f.value.valueText ?? (f.value.valueNumber != null ? (key.includes('price') ? `$${f.value.valueNumber.toFixed(2)}` : String(f.value.valueNumber)) : JSON.stringify(f.value.valueJson)),
        state: f.value.state,
        source: f.value.sourceType,
        disputed: f.disputed,
        candidates: f.disputed ? f.candidates.map((c) => ({ value: c.valueText ?? String(c.valueNumber ?? ''), source: c.sourceType })) : [],
      }));
    return {
      serverNow: new Date().toISOString(),
      project: {
        id: p.id as string,
        state: p.state as string,
        kind: p.kind as string,
        failureReason: (p.failure_reason as string) ?? null,
        /** Paused by a provider outage: resumes automatically with the reservation held (§44). */
        paused: p.state === 'NEEDS_USER_ACTION' && !!p.outage,
        /** Is the production run alive? From its heartbeat, never from elapsed time alone (§39). */
        liveness: liveness(IN_PRODUCTION.includes(p.state as ProjectState), (p.heartbeat_at as string | null) ?? null),
        /** What we checked, in customer words (plan 03 P10), derived from the stored QA report. */
        qa: customerQaSummary(p.qa_report as QaReport | null),
        storyboardId: (p.storyboard_id as string) ?? null,
        selectedConceptId: (p.selected_concept_id as string) ?? null,
        deliveryHeld,
      },
      sku: {
        id: p.sku_id as string,
        name: p.sku_name as string,
        catalogueNo: Number(p.catalogue_no),
        status: p.sku_status as string,
        rejectReason: (p.reject_reason as string) ?? null,
        analysis: p.analysis ?? {},
        cutoutUrl: fp?.cutout_asset_id ? await assetUrl(tx, fp.cutout_asset_id as string) : null,
        packaging: fp ? { type: fp.package_type, closure: fp.closure, label: fp.label_text } : null,
      },
      steps: skuSteps.map(stepJson),
      facts: factRows,
      claims: claims.map((c) => ({ id: c.id, wording: c.preferredWording, status: c.status, reason: c.blockReason, qualifier: c.mandatoryQualifier })),
      concepts: concepts.map((c) => ({ ...(c.proposal as Proposal), id: c.id as string, idx: c.idx as string, isPick: c.is_pick as boolean, pickReason: c.pick_reason as string | null, batch: Number(c.batch) })),
      /** Latest "try 3 more" request, drafted by the worker: the UI polls until it is done or failed. */
      conceptRequest: conceptStep ? { batch: Number(String(conceptStep.step_key).split('.').pop()), status: conceptStep.status as string, detail: (conceptStep.detail as string) ?? null } : null,
      storyboard,
      productionSteps: productionSteps.map(stepJson),
      quote,
      purchase: purchase ? { status: purchase.status as string, kind: purchase.kind as string, amountMicros: Number(purchase.amount_micros) } : null,
      exports,
    };
  });
}

const stepJson = (s: Record<string, unknown>) => ({ key: s.step_key as string, label: s.label as string, status: s.status as string, detail: (s.detail as string) ?? null, at: (s.completed_at ?? s.started_at ?? null) as string | null });

async function storyboardBlock(tx: Tx, storyboardId: string) {
  const v = await storyboardView(tx, storyboardId);
  const steps = await listSteps(tx, storyboardId);
  // Queued "change picture" requests per scene (latest version only).
  const regen = await tx`select distinct on (ps.subject_id) ps.subject_id, ps.status, ps.detail from progress_steps ps
                         join scenes s on s.id = ps.subject_id where s.storyboard_id = ${storyboardId} and ps.step_key like 'frame.v%'
                         order by ps.subject_id, ps.started_at desc nulls last`;
  const regenByScene = new Map(regen.map((r) => [r.subject_id as string, { status: r.status as string, detail: (r.detail as string) ?? null }]));
  return {
    id: storyboardId,
    status: v.storyboard.status as string,
    hook: (v.storyboard.hook_text as string) ?? null,
    cta: (v.storyboard.cta_text as string) ?? null,
    steps: steps.map(stepJson),
    scenes: await Promise.all(
      v.scenes.map(async (s) => ({
        id: s.id as string,
        position: Number(s.position),
        purpose: s.purpose as string,
        durationMs: Number(s.duration_ms),
        visualPlan: s.visual_plan as string,
        spokenLine: (s.spoken_line as string) ?? null,
        overlayText: (s.overlay_text as string) ?? null,
        productionMode: s.production_mode as string,
        locked: s.locked as boolean,
        frameUrl: s.frame_asset_id ? await assetUrl(tx, s.frame_asset_id as string) : null,
        freeRegenerationsUsed: Number(s.free_regenerations_used),
        regeneration: regenByScene.get(s.id as string) ?? null,
      })),
    ),
  };
}

export type ProjectView = NonNullable<Awaited<ReturnType<typeof projectView>>>;
