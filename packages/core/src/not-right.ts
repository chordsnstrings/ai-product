import type { Tx } from '@arkiv/db';
import { DomainError, newId } from '@arkiv/shared';
import { assertCan } from './authz';
import type { TenantContext } from './context';
import { emit } from './events';
import { append } from './ledger';
import { quoteAfterOffer } from './offers';
import { approveForProduction } from './production';
import { selectConcept } from './storyboard';

/**
 * "Not right?" on a delivered ad (plan 03 P10 edge case; standard §48 "Customer hates first render: diagnose
 * whether strategy, fidelity or execution failed; preserve storyboard and re-plan rather than wholesale regenerate
 * blindly").
 *
 * The delivered ad and its storyboard are kept. The diagnosis is recorded (project_feedback, OUTPUT_REJECTED) and
 * the merchant gets a re-plan as a new project on the same product:
 *  - product accuracy (fidelity — what our QA is there to catch): the same idea is re-planned into a fresh
 *    storyboard and produced free, once per delivered one-off ad (a credit on the new project, not a refund);
 *  - strategy: the three directions come back to pick another;
 *  - style (execution): the same idea is re-planned;
 * the last two at the live one-off price through the normal checkout.
 */

export type NotRightReason = 'strategy' | 'accuracy' | 'style';
const DIAGNOSIS: Record<NotRightReason, 'strategy' | 'fidelity' | 'execution'> = { strategy: 'strategy', accuracy: 'fidelity', style: 'execution' };

export interface NotRightOutcome {
  projectId: string;
  /** Where the merchant continues: the ideas (strategy) or the new storyboard. */
  next: string;
  free: boolean;
  /** The one-off price a paid re-plan costs (null when free). */
  priceMicros: number | null;
  replayed: boolean;
}

export async function reportNotRight(tx: Tx, ctx: TenantContext, projectId: string, input: { reason: NotRightReason; note?: string | null }): Promise<NotRightOutcome> {
  assertCan(ctx, 'sku.edit');
  const [p] = await tx`select id, sku_id, kind, state, selected_concept_id, sku_variant_id, goal from projects
                       where id = ${projectId} and workspace_id = ${ctx.workspaceId} for update`;
  if (!p) throw new DomainError('NOT_FOUND', 'Project not found');
  if (p.state !== 'COMPLETE') throw new DomainError('CONFLICT', 'You can tell us once your ad is ready.');
  const oneOff = p.kind === 'taste' || p.kind === 'standalone';
  if (!oneOff) throw new DomainError('CONFLICT', 'For a Creative Test, report it from the test in your Studio.');
  const diagnosis = DIAGNOSIS[input.reason];
  // Free: product accuracy only (QA-related), and once per delivered ad.
  const [freeUsed] = await tx`select id from projects where workspace_id = ${ctx.workspaceId} and revision_of = ${projectId} and revision_free`;
  const free = input.reason === 'accuracy' && !freeUsed;
  // A re-plan already open for the same reason is reused (a double submit, or coming back to it).
  const [open] = await tx`select f.revision_project_id, r.revision_free from project_feedback f join projects r on r.id = f.revision_project_id and r.workspace_id = f.workspace_id
                          where f.workspace_id = ${ctx.workspaceId} and f.project_id = ${projectId} and f.diagnosis = ${diagnosis}
                            and r.state not in ('COMPLETE', 'CANCELLED', 'REFUNDED') order by f.created_at desc limit 1`;
  if (open) {
    const id = open.revision_project_id as string;
    return { projectId: id, next: input.reason === 'strategy' ? `/concepts/${id}` : `/storyboard/${id}`, free: !!open.revision_free, priceMicros: open.revision_free ? null : (await quoteAfterOffer(tx)).priceMicros, replayed: true };
  }

  const revisionId = newId();
  await tx`insert into projects (id, workspace_id, sku_id, kind, state, created_by, sku_variant_id, goal, revision_of, revision_free)
           values (${revisionId}, ${ctx.workspaceId}, ${p.sku_id}, ${free ? p.kind : 'standalone'}, 'CONCEPTS_READY', ${ctx.actor.kind + ':' + ctx.actor.id},
                   ${p.sku_variant_id ?? null}, ${p.goal ?? 'performance'}, ${projectId}, ${free})`;
  // The ideas carry over (the latest batch): the chosen one to re-plan, or all three to pick another.
  await tx`insert into concepts (workspace_id, sku_id, project_id, batch, idx, proposal, is_pick, pick_reason, gate_results, prompt_version, model, brand_brain_version_id)
           select workspace_id, sku_id, ${revisionId}, 1, idx, proposal, is_pick, pick_reason, gate_results, prompt_version, model, brand_brain_version_id
           from concepts where workspace_id = ${ctx.workspaceId} and project_id = ${projectId}
             and batch = (select max(batch) from concepts where workspace_id = ${ctx.workspaceId} and project_id = ${projectId})`;
  await tx`insert into project_feedback (workspace_id, project_id, diagnosis, note, revision_project_id, created_by)
           values (${ctx.workspaceId}, ${projectId}, ${diagnosis}, ${input.note?.trim().slice(0, 500) || null}, ${revisionId}, ${ctx.actor.kind + ':' + ctx.actor.id})`;
  await emit(tx, ctx, 'OUTPUT_REJECTED', { type: 'project', id: projectId }, { reason: input.reason, diagnosis, revisionProjectId: revisionId, free }, { skuId: p.sku_id as string });

  let next = `/concepts/${revisionId}`;
  if (input.reason !== 'strategy') {
    // Re-plan the same idea: a fresh storyboard from the concept the delivered ad was made from.
    const [chosen] = p.selected_concept_id ? await tx`select idx from concepts where id = ${p.selected_concept_id}` : [];
    const [copy] = chosen ? await tx`select id from concepts where project_id = ${revisionId} and idx = ${chosen.idx}` : [];
    if (copy) {
      await selectConcept(tx, ctx, revisionId, copy.id as string);
      next = `/storyboard/${revisionId}`;
    }
  }
  if (free) {
    // The free re-plan is a credit for the new project (the ledger stays the record of what was given).
    await append(tx, ctx, { type: 'CREDIT_GRANTED', unit: p.kind as 'taste' | 'standalone', amount: 1, projectId: revisionId, reference: `replan:${projectId}`, reason: 'Free re-plan: product accuracy', idempotencyKey: `replan:${projectId}` });
  }
  return { projectId: revisionId, next, free, priceMicros: free ? null : (await quoteAfterOffer(tx)).priceMicros, replayed: false };
}

/**
 * Produce a free re-plan once its storyboard is ready: no checkout, with the credit granted for it. Only the
 * project that carries the free re-plan, once.
 */
export async function produceFreeRevision(tx: Tx, ctx: TenantContext, projectId: string) {
  assertCan(ctx, 'storyboard.approve');
  const [p] = await tx`select kind, state, revision_of, revision_free from projects where id = ${projectId} and workspace_id = ${ctx.workspaceId} for update`;
  if (!p) throw new DomainError('NOT_FOUND', 'Project not found');
  if (!p.revision_free || !p.revision_of) throw new DomainError('CONFLICT', 'This storyboard isn’t a free re-plan.');
  const [granted] = await tx`select 1 from ledger_entries where workspace_id = ${ctx.workspaceId} and idempotency_key = ${`replan:${p.revision_of}`} and project_id = ${projectId}`;
  if (!granted) throw new DomainError('CONFLICT', 'This storyboard isn’t a free re-plan.');
  return approveForProduction(tx, ctx, projectId, p.kind as 'taste' | 'standalone');
}
