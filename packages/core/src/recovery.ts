import { withTenant, type Tx } from '@arkiv/db';
import { DomainError } from '@arkiv/shared';
import type { TenantContext } from './context';
import { authorizeOrTakeOver, settle } from './cost-governor';
import { CONCEPTS_MAX_TOKENS, generateConcepts } from './creative-director';
import { route } from './model-gateway';
import { enqueue, Queues } from './outbox';

/**
 * Abandonment recovery (plan 04 L20): T−15 min before the Taste window closes, T+24h "your storyboard is saved",
 * T+3d a new concept for the same SKU. At most three recovery emails per project, then stop; stop at once on a
 * purchase or when every recipient has unsubscribed (sendEmail enforces suppressions per address).
 */
export const RECOVERY_TEMPLATES = ['offer_ending', 'storyboard_saved', 'new_concept'] as const;
export type RecoveryTemplate = (typeof RECOVERY_TEMPLATES)[number];
export const RECOVERY_EMAIL_CAP = 3;

/** Idempotency key of a recovery email: one per project, template and recipient. The cap counts these. */
export const recoveryEmailKey = (projectId: string, template: RecoveryTemplate, email: string) => `recovery:${projectId}:${template}:${email}`;

/** Where each recovery email lands in the funnel (routes under apps/web/app/(flow)). */
export function recoveryUrl(appUrl: string, projectId: string, template: RecoveryTemplate): string {
  const path = template === 'new_concept' ? `/concepts/${projectId}` : `/storyboard/${projectId}`;
  return `${appUrl}${path}?utm_source=email&utm_medium=lifecycle&utm_campaign=recovery_${template}`;
}

/**
 * Whether a project may still receive a recovery email. Callable as system_rw (sweeps), so every read filters
 * by workspace explicitly rather than relying on the tenant policy.
 */
export async function recoveryStatus(tx: Tx, workspaceId: string, projectId: string): Promise<{ eligible: boolean; sent: number; reason?: string }> {
  const [p] = await tx`select state, kind from projects where id = ${projectId} and workspace_id = ${workspaceId}`;
  if (!p) return { eligible: false, sent: 0, reason: 'project not found' };
  const [n] = await tx`select count(distinct template)::int as n from email_log
                       where workspace_id = ${workspaceId} and idempotency_key like ${`recovery:${projectId}:%`}`;
  const sent = n!.n as number;
  if (sent >= RECOVERY_EMAIL_CAP) return { eligible: false, sent, reason: 'cap reached' };
  if (p.state !== 'STORYBOARD_READY' || p.kind !== 'preview') return { eligible: false, sent, reason: 'no longer abandoned' };
  const [paid] = await tx`select 1 from purchases where workspace_id = ${workspaceId} and status = 'paid' limit 1`;
  if (paid) return { eligible: false, sent, reason: 'purchased' };
  const [reachable] = await tx`select 1 from memberships m join users u on u.id = m.user_id
                               where m.workspace_id = ${workspaceId} and m.role = 'OWNER' and u.deleted_at is null
                                 and not exists (select 1 from email_suppressions s where s.email = u.email and s.stream in ('all','marketing'))
                               limit 1`;
  if (!reachable) return { eligible: false, sent, reason: 'unsubscribed' };
  return { eligible: true, sent };
}

/**
 * Worker (`recovery-concept`, T+3d): draft one more concept batch for the abandoned storyboard's SKU under the
 * storyboard cost cap, then queue the `new_concept` email in the same transaction. One reservation per project
 * (`recovery:<project>`), so a redelivered job never drafts twice.
 */
export async function draftRecoveryConcept(ctx: TenantContext, projectId: string): Promise<'queued' | 'skipped'> {
  const ws = ctx.workspaceId;
  const info = await withTenant(ws, async (tx) => {
    const status = await recoveryStatus(tx, ws, projectId);
    if (!status.eligible) return null;
    const [p] = await tx`select sku_id from projects where id = ${projectId}`;
    const [b] = await tx`select coalesce(max(batch), 0) as b from concepts where project_id = ${projectId}`;
    const [done] = await tx`select 1 from cost_authorizations where idempotency_key = ${`recovery:${projectId}`} and status = 'settled'`;
    return done ? null : { skuId: p!.sku_id as string, batch: Number(b!.b) + 1 };
  });
  if (!info) return 'skipped';
  let auth: Awaited<ReturnType<typeof authorizeOrTakeOver>>;
  try {
    auth = await withTenant(ws, async (tx) => {
      const r = await route(tx, 'creative_director.concepts');
      return authorizeOrTakeOver(
        tx,
        ctx,
        { purpose: 'storyboard', skuId: info.skuId, projectId, lines: [{ kind: 'llm', provider: r.provider, model: r.model, inputTokens: 6_000, outputTokens: CONCEPTS_MAX_TOKENS }], idempotencyKey: `recovery:${projectId}` },
        10,
      );
    });
  } catch (e) {
    if (e instanceof DomainError && (e.code === 'CONFLICT' || e.code === 'GATE_BLOCKED' || e.code === 'UNAVAILABLE')) return 'skipped';
    throw e;
  }
  try {
    const ids = await generateConcepts({ ctx, token: auth.token, skuId: info.skuId, projectId, batch: info.batch });
    await withTenant(ws, async (tx) => {
      await settle(tx, ctx, auth.authorizationId, 'consumed');
      const [pick] = await tx`select id from concepts where id in ${tx(ids)} order by is_pick desc, idx limit 1`;
      await enqueue(tx, ws, Queues.sendEmail, { template: 'new_concept', projectId, conceptId: pick?.id ?? ids[0] }, { singletonKey: `new-concept:${projectId}` });
    });
    return 'queued';
  } catch (e) {
    await withTenant(ws, (tx) => settle(tx, ctx, auth.authorizationId, 'consumed'));
    throw e;
  }
}
