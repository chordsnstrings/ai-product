import { withTenant, type Tx } from '@arkiv/db';
import {
  ANALYSIS_KEY_FACTS,
  assetUrl,
  blockedLines,
  bonusHookDue,
  bonusHooks,
  cancelDecision,
  currentFacts,
  customerReason,
  currentQuote,
  customerQaSummary,
  DELIVERY_HOLD_STATES,
  IN_PRODUCTION,
  listClaims,
  listSteps,
  listVariants,
  liveness,
  outageStatus,
  priceUpdate,
  resumableAfterEdit,
  SLOW_STEP_MS,
  stepEta,
  storyboardView,
  verifiedIngredients,
  type Proposal,
  type QaReport,
} from '@arkiv/core';
import type { ProjectState } from '@arkiv/shared';
import { CreativeGoal, PLANS, PROVISIONAL, type WorkspaceState } from '@arkiv/shared';

/** Serializable project view for funnel pages (P3–P10). Asset URLs are short-lived signed URLs (plan 02 layer 4). */
export async function projectView(workspaceId: string, projectId: string) {
  return withTenant(workspaceId, async (tx) => {
    const [p] = await tx`select p.*, s.name as sku_name, s.catalogue_no, s.status as sku_status, s.reject_reason, s.analysis, s.fidelity_confidence, s.source_url,
                                (select count(*)::int from assets a where a.sku_id = s.id and a.kind = 'product_photo' and a.deleted_at is null
                                   and coalesce(a.review_status, 'none') not in ('pending','rejected')) as usable_photos
                         from projects p join skus s on s.id = p.sku_id where p.id = ${projectId}`;
    if (!p) return null;
    const skuSteps = await listSteps(tx, p.sku_id as string);
    const facts = await currentFacts(tx, p.sku_id as string);
    const variants = await listVariants(tx, p.sku_id as string);
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
    // What in the delivered ad is AI-generated (standard §40), for the platform disclosure steps on delivery.
    let disclosure: { aiGenerated: boolean; syntheticPeople: boolean; syntheticVoice: boolean } | null = null;
    // Finished work is stored but not delivered while the workspace is suspended (plan 05 §2.3).
    const [ws] = await tx`select state from workspaces where id = ${workspaceId}`;
    const deliveryHeld = DELIVERY_HOLD_STATES.has(ws?.state as WorkspaceState);
    if (p.final_creative_id && !deliveryHeld) {
      const [cr] = await tx`select final_asset_ids, ai_generated, synthetic_people, composition->'disclosure'->>'syntheticVoice' as synthetic_voice from creatives where id = ${p.final_creative_id}`;
      if (cr) disclosure = { aiGenerated: !!cr.ai_generated, syntheticPeople: !!cr.synthetic_people, syntheticVoice: cr.synthetic_voice === 'true' };
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
    // The offer's bonus alternate hook (§8), delivered as a version of the ad once it is made.
    let bonusExports: typeof exports = [];
    if (p.bonus_hook_creative_id && !deliveryHeld) {
      const [bc] = await tx`select final_asset_ids from creatives where id = ${p.bonus_hook_creative_id}`;
      const assets = await tx`select id, lineage from assets where id in ${tx((bc?.final_asset_ids as string[]) ?? ['00000000-0000-0000-0000-000000000000'])}`;
      bonusExports = await Promise.all(
        assets.map(async (a) => {
          const aspect = (a.lineage as { aspect: string }).aspect;
          const name = `${String(p.sku_name).replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-alt-hook-${aspect}.mp4`;
          return { aspect, assetId: a.id as string, url: await assetUrl(tx, a.id as string, 3600), download: `/api/assets/${a.id}/download?name=${encodeURIComponent(name)}&project=${projectId}` };
        }),
      );
      bonusExports.sort((a, b) => ['9x16', '4x5', '1x1'].indexOf(a.aspect) - ['9x16', '4x5', '1x1'].indexOf(b.aspect));
    }
    // A bonus still being made: the offer promised one and the ad is done.
    const bonusPending = p.state === 'COMPLETE' && !p.bonus_hook_creative_id && (await bonusHookDue(tx, projectId));
    // Why production stopped, in customer words (plan 03 P9, standard §8): a paused production's queue status
    // (partner + ETA), otherwise the copy mapped from the stored reason code — never an internal error.
    const queue = p.outage ? await outageStatus(tx, workspaceId, projectId) : null;
    // A delivered ad showing a price or size that has since changed (§42): offered as a free update.
    const factUpdate = p.state === 'COMPLETE' ? await priceUpdate(tx, workspaceId, projectId) : null;
    const resumable = p.state === 'STORYBOARD_READY' && (await resumableAfterEdit(tx, workspaceId, projectId));
    // What cancelling would do right now (dispatch/spend state), shown before the customer confirms (§38, §46).
    const cancel = p.state !== 'COMPLETE' && p.entitlement_unit ? await cancelDecision(tx, workspaceId, projectId) : null;
    // Lines that stopped production at the claims check, tied to the scene that says or shows them.
    const blocked =
      p.state === 'BLOCKED_COMPLIANCE' || resumable
        ? blockedLines(p.qa_report).map((b) => {
            const sc = storyboard?.scenes.find((x) => x.spokenLine?.trim() === b.line || x.overlayText?.trim() === b.line);
            return { ...b, sceneId: sc?.id ?? null, scene: sc ? sc.position + 1 : null };
          })
        : [];
    const factRows = Object.entries(facts)
      .filter(([k]) => !['description', 'variants', 'packaging', 'label_text'].includes(k))
      .map(([key, f]) => ({
        key,
        id: f.value.id,
        /** The merchant confirmed this value (P4 "Looks right") or decided it themselves. */
        confirmed: f.value.merchantConfirmed || f.value.state === 'DECIDED',
        value: f.value.valueText ?? (f.value.valueNumber != null ? (key.includes('price') ? `$${f.value.valueNumber.toFixed(2)}` : String(f.value.valueNumber)) : JSON.stringify(f.value.valueJson)),
        state: f.value.state,
        source: f.value.sourceType,
        /** When this value was observed (or decided): the provenance chip shows it with the source. */
        observedAt: f.value.observedAt,
        disputed: f.disputed,
        candidates: f.disputed ? f.candidates.map((c) => ({ value: c.valueText ?? String(c.valueNumber ?? ''), source: c.sourceType })) : [],
        /** A source still disagrees with the merchant's correction (§28): shown, never hidden behind the decision. */
        sourceConflict: f.sourceConflict
          ? {
              factId: f.sourceConflict.fact.id,
              value: f.sourceConflict.fact.valueText ?? (f.sourceConflict.fact.valueNumber != null ? (key.includes('price') ? `$${f.sourceConflict.fact.valueNumber.toFixed(2)}` : String(f.sourceConflict.fact.valueNumber)) : ''),
              source: f.sourceConflict.fact.sourceType,
              observedAt: f.sourceConflict.fact.observedAt,
              newer: f.sourceConflict.newer,
            }
          : null,
      }));
    return {
      serverNow: new Date().toISOString(),
      project: {
        id: p.id as string,
        state: p.state as string,
        kind: p.kind as string,
        failureReason: queue?.message ?? customerReason(p as { failure_code?: string | null; failure_reason?: string | null }),
        /** Paused by a provider outage: resumes automatically with the reservation held (§44). */
        paused: p.state === 'NEEDS_USER_ACTION' && !!p.outage,
        /** Truthful queue ETA while paused, when known (plan 03 P9, standard §48). */
        queue: queue ? { etaAt: queue.etaAt, etaKind: queue.etaKind } : null,
        /** Lines to change before production can finish (BLOCKED_COMPLIANCE), with why and an alternative. */
        blockedLines: blocked,
        /** Paid for and reopened to fix a line: finishing needs no new checkout. */
        resumable,
        /** Cancel is offered while this is set; `message` says what happens to the credit or payment. */
        cancel: cancel?.allowed ? { message: cancel.message, refund: cancel.refund, outcome: cancel.outcome } : null,
        /** The ad shows a price or size that changed since: `shown` → `current` (recomposed free, same footage). */
        factUpdate: factUpdate?.stale ? { shown: factUpdate.shown, current: factUpdate.current } : null,
        cancelling: !!p.cancel_requested_at && !['CANCELLED', 'REFUNDED', 'COMPLETE'].includes(p.state as string),
        /** Is the production run alive? From its heartbeat, never from elapsed time alone (§39). */
        liveness: liveness(IN_PRODUCTION.includes(p.state as ProjectState), (p.heartbeat_at as string | null) ?? null),
        /** What we checked, in customer words (plan 03 P10), derived from the stored QA report. */
        qa: customerQaSummary(p.qa_report as QaReport | null),
        storyboardId: (p.storyboard_id as string) ?? null,
        /** The size/shade this ad is for (§42). */
        variantId: (p.sku_variant_id as string) ?? null,
        selectedConceptId: (p.selected_concept_id as string) ?? null,
        /** §8 creative goal the ideas are drafted for (performance by default). */
        goal: ((CreativeGoal as readonly string[]).includes(p.goal as string) ? p.goal : 'performance') as CreativeGoal,
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
        /** What a good ad would still need (§42), from the analysis. */
        missingEvidence: ((p.analysis as { missingEvidence?: string[] } | null)?.missingEvidence ?? []).slice(0, 6),
        /** Ingredient-led tests need a sourced ingredient list (§42 "request source"). */
        ingredientsVerified: verifiedIngredients(facts).verified,
        /** Sizes/shades with their own price and availability (§42); the project records which one it advertises. */
        variants: variants.map((x) => ({ id: x.id, title: x.title, size: x.size, shade: x.shade, priceMicros: x.priceMicros, available: x.available })),
        /** The link the merchant entered, kept when reading it failed (§13 "preserve the entered URL"). */
        sourceUrl: (p.source_url as string) ?? null,
        /** Product photos production may use; none means the analysis is waiting for a photo. */
        usablePhotos: Number(p.usable_photos ?? 0),
        /** How sure the analyst was that the photos show the product clearly (0–1), for the P4 extra-view prompt. */
        fidelityConfidence: p.fidelity_confidence == null ? null : Number(p.fidelity_confidence),
        /** Views the analyst suggested (e.g. "back label"), and how many the merchant has added since. */
        suggestedViews: ((p.analysis as { suggestedViews?: string[] } | null)?.suggestedViews ?? []).slice(0, 4),
        addedViews: Number((p.analysis as { addedViews?: number } | null)?.addedViews ?? 0),
        /** Key facts we could not find, asked for inline (plan 03 P3 "ask for the missing field"). */
        missingFacts: ANALYSIS_KEY_FACTS.filter((k) => !facts[k.key] && !(k.key === 'ingredients' && facts.key_ingredients)).map((k) => ({ key: k.key, label: k.label })),
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
      // An offer bonus is shown only when the offer carries it (what is shown is what is delivered, §8).
      bonus: { offered: quote.kind === 'taste' && bonusHooks(quote.bonus) > 0, exports: bonusExports, pending: bonusPending, failed: !!p.bonus_hook_failed_at },
      disclosure,
      /** The plan the delivery continuation points to (plan 04 L17). */
      /** How long an unsaved preview is kept (plan 02 §2.1), for truthful "saved" copy. */
      previewDays: PROVISIONAL.TTL_DAYS,
      upsell: { growthName: PLANS.GROWTH.name, growthTestsPerMonth: PLANS.GROWTH.creativeTestsPerMonth },
    };
  });
}

/** Honest "still working" copy for a slow step, from the estimate recorded when it started (plan 03 P3). */
function slowNote(key: string, eta: ReturnType<typeof stepEta>): string | null {
  if (!eta || eta.elapsedMs < SLOW_STEP_MS) return null;
  if (eta.remainingMs == null || eta.remainingMs < 5_000) return 'Taking longer than usual — still working. Nothing is lost if you leave this page.';
  const sec = Math.ceil(eta.remainingMs / 5_000) * 5;
  return `${key === 'read_page' || key === 'identify' ? 'Your page is detailed' : 'This one is detailed'} — about ${sec} more seconds.`;
}

const stepJson = (s: Record<string, unknown>) => {
  const eta = stepEta(s as { status: string; started_at?: string | null; expected_ms?: number | null });
  return {
    key: s.step_key as string,
    label: s.label as string,
    status: s.status as string,
    detail: (s.detail as string) ?? null,
    at: (s.completed_at ?? s.started_at ?? null) as string | null,
    note: slowNote(s.step_key as string, eta),
  };
};

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
        /** Why the Production Planner chose this scene's medium (§23), shown before approval. */
        plannerReason: (s.planner_reason as string | null) ?? null,
        locked: s.locked as boolean,
        frameUrl: s.frame_asset_id ? await assetUrl(tx, s.frame_asset_id as string) : null,
        freeRegenerationsUsed: Number(s.free_regenerations_used),
        regeneration: regenByScene.get(s.id as string) ?? null,
      })),
    ),
  };
}

export type ProjectView = NonNullable<Awaited<ReturnType<typeof projectView>>>;

/**
 * A cheap fingerprint of everything the funnel view shows (plan 06 Phase 1 #9: the P3 stream follows real events):
 * the project and SKU rows, every progress step of the SKU, project, storyboard and its scenes, the concepts, and the
 * workspace's latest event. The stream rebuilds and sends the view only when it changes.
 */
export async function projectVersion(workspaceId: string, projectId: string): Promise<string | null> {
  return withTenant(workspaceId, async (tx) => {
    const [v] = await tx`
      select p.state, p.state_version, p.updated_at, s.status as sku_status, s.updated_at as sku_updated,
             (select coalesce(string_agg(ps.subject_id::text || ps.step_key || ':' || ps.status || ':' || coalesce(ps.detail, ''), '|' order by ps.subject_id, ps.step_key), '')
                from progress_steps ps where ps.subject_id = any(array[p.sku_id, p.id, p.storyboard_id]::uuid[])
                   or ps.subject_id in (select sc.id from scenes sc where sc.storyboard_id = p.storyboard_id)) as steps,
             (select count(*)::int from concepts c where c.project_id = p.id) as concepts,
             (select max(at) from events e where e.workspace_id = p.workspace_id) as last_event
      from projects p join skus s on s.id = p.sku_id where p.id = ${projectId}`;
    if (!v) return null;
    const { createHash } = await import('node:crypto');
    return createHash('sha1').update(JSON.stringify(v)).digest('hex').slice(0, 16);
  });
}
