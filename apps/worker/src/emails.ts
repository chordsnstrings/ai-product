import { createHash } from 'node:crypto';
import { withSystem, withTenant } from '@arkiv/db';
import { env, formatDate, formatDateTime, formatTime, formatUsd, PLANS, type PlanCode, type RiskIndicator } from '@arkiv/shared';
import { digestOptOutLink, isDigest, isTemplateName, quietHoursDelay, sendEmail, type DigestKind, type TemplateMap, type TemplateName } from '@arkiv/email';
import {
  assetUrl,
  customerReason,
  enqueue,
  openInviteToken,
  Queues,
  quoteAfterOffer,
  recoveryEmailKey,
  recoveryStatus,
  recoveryUrl,
  RISK_PLAYBOOKS,
  setting,
  subscriptionPrice,
  type RecoveryTemplate,
  type TenantContext,
} from '@arkiv/core';

/**
 * Builds template data for queued emails from tenant data, and picks recipients (owners/admins by default).
 * Workspace slug is resolved here so links always land inside the right workspace, and every email names the
 * workspace (plan 02 M11). Dates and times follow the design system (`23 Sep 2026`, `14:02 ET`) in the
 * workspace's timezone.
 */
interface Recipient {
  userId: string;
  email: string;
}

/**
 * Members with these roles. A weekly digest skips members who turned it off for this workspace (Profile settings
 * or the email's one-click link); `alsoUserIds` adds specific members (e.g. whoever approved a production).
 */
async function recipientsOf(workspaceId: string, roles: string[], opts: { digest?: DigestKind; alsoUserIds?: (string | null | undefined)[] } = {}): Promise<Recipient[]> {
  const also = (opts.alsoUserIds ?? []).filter((x): x is string => !!x);
  return withTenant(workspaceId, async (tx) =>
    (
      await tx`select distinct u.id, u.email from memberships m join users u on u.id = m.user_id
               where m.workspace_id = ${workspaceId} and u.deleted_at is null
                 and (m.role in ${tx(roles)} or m.user_id = any(${also}::uuid[]))
                 and not exists (select 1 from notification_prefs np where np.workspace_id = m.workspace_id and np.user_id = m.user_id
                                   and np.kind = ${opts.digest ?? ''} and not np.enabled)
               order by u.email`
    ).map((r) => ({ userId: r.id as string, email: r.email as string })),
  );
}
async function recipients(workspaceId: string, roles = ['OWNER', 'ADMIN']): Promise<string[]> {
  return (await recipientsOf(workspaceId, roles)).map((r) => r.email);
}

/** The member who approved a production (its STORYBOARD_APPROVED transition), when it was a signed-in member. */
async function approverOf(workspaceId: string, projectId: string): Promise<string | null> {
  const [e] = await withTenant(workspaceId, (tx) => tx`select actor from events where subject_id = ${projectId} and type = 'PROJECT_STATE_CHANGED'
                                                        and payload->>'to' = 'STORYBOARD_APPROVED' order by at desc limit 1`);
  const m = /^user:([0-9a-f-]{36})$/.exec((e?.actor as string | undefined) ?? '');
  return m ? m[1]! : null;
}

/** Customer copy for a production that stopped on them (plan 03 A10 "QA needs you"). */
function needsYouCopy(state: string, code: string | null, reason: string | null): { headline: string; reason: string; cta: string } {
  if (state === 'BLOCKED_COMPLIANCE') return { headline: 'A line in your ad needs changing', reason: reason ?? 'One line can’t be used in ads as written. Change it and production continues.', cta: 'Fix the line' };
  if (state === 'PROVIDER_FAILED') return { headline: 'We couldn’t finish your ad', reason: `${reason ?? 'This production stopped.'} You can try again at no extra cost.`, cta: 'Try again' };
  if (code === 'entitlement') return { headline: 'Your ad is waiting to be produced', reason: reason ?? 'It needs a Creative Test or a payment before we can produce it.', cta: 'Continue' };
  return { headline: 'Your ad needs one decision', reason: reason ?? 'Production is waiting on you.', cta: 'Open it' };
}

export async function sendQueuedEmail(ctx: TenantContext, data: Record<string, unknown>, jobId: string) {
  const ws = ctx.workspaceId;
  const app = env().APP_URL;
  const [w] = await withTenant(ws, (tx) => tx`select slug, name, timezone from workspaces where id = ${ws}`);
  const base = `${app}/w/${w!.slug}`;
  const workspaceName = w!.name as string;
  const tz = (w!.timezone as string | null) || undefined;
  const day = (v: string | Date | null | undefined) => formatDate(v ?? null, { timeZone: tz });
  // Quiet hours (plan 05 §18): marketing email queued between 20:00 and 08:00 workspace time waits until 08:00.
  const quiet = typeof data.template === 'string' && isTemplateName(data.template) ? quietHoursDelay(data.template, w!.timezone as string | null) : null;
  if (quiet) {
    await withTenant(ws, (tx) => enqueue(tx, ws, Queues.sendEmail, data, { runAfter: quiet, singletonKey: `quiet:${jobId}` }));
    return;
  }
  /**
   * Send to each recipient. `key` names the business event (one email per event and address, however many jobs
   * carry it); without one, the job id keys it. A weekly digest goes only to members who didn't turn it off, each
   * with their own one-click "turn it off" link.
   */
  const send = async <T extends TemplateName>(t: T, d: TemplateMap[T], to?: string[] | Recipient[], key?: string) => {
    const list: Recipient[] = to
      ? (to as (string | Recipient)[]).map((r) => (typeof r === 'string' ? { userId: '', email: r } : r))
      : await recipientsOf(ws, ['OWNER', 'ADMIN'], { digest: isDigest(t) ? t : undefined });
    let undeliverable = 0;
    for (const r of list) {
      const optOutUrl = isDigest(t) && r.userId ? digestOptOutLink({ workspaceId: ws, userId: r.userId, kind: t }) : null;
      const res = await sendEmail(t, r.email, d, { idempotencyKey: `${key ?? jobId}:${t}:${r.email}`, workspaceId: ws, optOutUrl });
      if (res.status === 'suppressed') undeliverable++;
    }
    // A billing notice that reached no one (every address bounces) is shown in the app instead (plan 05 §18).
    if (list.length && undeliverable === list.length && BILLING_NOTICES[t]) await noticeUndeliverable(ws, t, BILLING_NOTICES[t]!);
  };
  /**
   * L20 recovery emails: still abandoned, under the 3-per-project cap, owners only. Keyed per project/template/
   * recipient so the cap can be counted and a redelivered job never sends twice.
   */
  const sendRecovery = async <T extends RecoveryTemplate>(t: T, projectId: string, d: TemplateMap[T]) => {
    const status = await withTenant(ws, (tx) => recoveryStatus(tx, ws, projectId));
    if (!status.eligible) return;
    for (const email of await recipients(ws, ['OWNER'])) {
      await sendEmail(t, email, d, { idempotencyKey: recoveryEmailKey(projectId, t, email), workspaceId: ws });
    }
  };
  switch (data.template) {
    case 'asset_ready': {
      // A Creative Test is ready when its hook variants are: subscribers download them in the Studio. A one-off ad
      // is watched on its delivery page. The member who approved it hears too, not only the owners.
      const [p] = await withTenant(ws, (tx) => tx`select p.id, p.experiment_id, s.name, s.catalogue_no from projects p join skus s on s.id = p.sku_id where p.id = ${data.projectId as string}`);
      if (!p) return;
      const test = !!p.experiment_id;
      const to = await recipientsOf(ws, ['OWNER', 'ADMIN'], { alsoUserIds: [await approverOf(ws, p.id as string)] });
      await send(
        'asset_ready',
        { workspaceName, productName: p.name, url: test ? `${base}/studio/${p.experiment_id as string}` : `${app}/deliver/${p.id}`, catalogueNo: `No. ${String(p.catalogue_no).padStart(3, '0')}`, variants: test },
        to,
        `asset:${p.id as string}`,
      );
      return;
    }
    case 'qa_needs_you': {
      // Only while the production is still stopped in that state (a quick retry may already have moved it on).
      const [p] = await withTenant(ws, (tx) => tx`select p.id, p.state, p.state_version, p.failure_code, p.failure_reason, p.experiment_id, p.kind, s.name
                                                   from projects p join skus s on s.id = p.sku_id where p.id = ${data.projectId as string}`);
      if (!p || p.state !== data.state || Number(p.state_version) !== Number(data.stateVersion)) return;
      const copy = needsYouCopy(p.state as string, (p.failure_code as string | null) ?? null, customerReason(p as never));
      const url = p.experiment_id ? `${base}/studio/${p.experiment_id as string}` : `${app}/produce/${p.id as string}`;
      const to = await recipientsOf(ws, ['OWNER'], { alsoUserIds: [data.actorUserId as string | null, await approverOf(ws, p.id as string)] });
      await send('qa_needs_you', { workspaceName, productName: p.name as string, ...copy, url }, to, `qa:${p.id as string}:${p.state as string}:${p.state_version as number}`);
      return;
    }
    case 'receipt': {
      const [pu] = await withTenant(ws, (tx) => tx`select pu.amount_micros, pu.kind, pu.project_id, pu.paid_at, pu.stripe_payment_intent_id, s.name from purchases pu join projects p on p.id = pu.project_id join skus s on s.id = p.sku_id where pu.id = ${data.purchaseId as string}`);
      if (pu) {
        await send('receipt', {
          workspaceName,
          productName: pu.name,
          amount: formatUsd(Number(pu.amount_micros)),
          description: pu.kind === 'taste' ? '15-second ad · intro price' : '15-second ad',
          url: `${app}/produce/${pu.project_id}`,
          paidAt: pu.paid_at ? `${day(pu.paid_at as string)}, ${formatTime(pu.paid_at as string, { timeZone: tz })}` : null,
          reference: (pu.stripe_payment_intent_id as string | null) ?? null,
        });
      }
      return;
    }
    case 'invoice_receipt': {
      // A paid subscription invoice, from the Stripe invoice mirror (amounts in cents).
      const [inv] = await withTenant(ws, (tx) => tx`select i.id, i.amount_paid_cents, i.period_start, i.period_end, i.hosted_invoice_url, s.plan_code
                                                     from stripe_invoices i left join subscriptions s on s.stripe_subscription_id = i.stripe_subscription_id and s.workspace_id = i.workspace_id
                                                     where i.id = ${data.invoiceId as string}`);
      if (!inv || Number(inv.amount_paid_cents) <= 0) return;
      const plan = PLANS[(inv.plan_code as PlanCode) ?? 'GROWTH'];
      await send(
        'invoice_receipt',
        {
          workspaceName,
          planName: plan?.name ?? 'Your plan',
          amount: formatUsd(Number(inv.amount_paid_cents) * 10_000),
          tax: data.taxCents != null && Number(data.taxCents) > 0 ? formatUsd(Number(data.taxCents) * 10_000) : null,
          paidAt: day((data.paidAt as string) ?? new Date()),
          periodStart: day(inv.period_start as string | null),
          periodEnd: day(inv.period_end as string | null),
          invoiceNumber: (data.number as string | null) ?? (inv.id as string),
          hostedInvoiceUrl: (inv.hosted_invoice_url as string | null) ?? null,
          url: `${base}/settings/billing`,
        },
        await recipients(ws, ['OWNER']),
        `invoice:${inv.id as string}`,
      );
      return;
    }
    case 'refund_issued': {
      // Quality-guarantee refund (queued by refund-purchase); console refunds send the same template directly.
      const [pu] = await withTenant(ws, (tx) => tx`select pu.amount_micros, pu.kind, s.name from purchases pu join projects p on p.id = pu.project_id join skus s on s.id = p.sku_id
                                                    where pu.id = ${data.purchaseId as string} and pu.status = 'refunded'`);
      if (pu) {
        await send(
          'refund_issued',
          {
            workspaceName,
            amount: formatUsd(Number(pu.amount_micros)),
            description: `${pu.name as string} · 15-second ad${pu.kind === 'taste' ? ' · intro price' : ''}`,
            note: `We couldn’t produce your ${pu.name as string} ad to our quality standard, so as promised you don’t pay for it.`,
            url: `${base}/settings/billing`,
          },
          await recipients(ws, ['OWNER']),
        );
      }
      return;
    }
    case 'subscription_started': {
      const plan = PLANS[(data.plan as PlanCode) ?? 'GROWTH'];
      const [s] = await withTenant(ws, (tx) => tx`select id, plan_code, created_at, current_period_end from subscriptions order by created_at desc limit 1`);
      // The price this subscriber agreed to (a scheduled plan price version counts from its effective date).
      const price = s ? (await withTenant(ws, (tx) => subscriptionPrice(tx, { id: s.id as string, workspaceId: ws, planCode: s.plan_code as PlanCode, createdAt: s.created_at as string }))).priceMicros : plan.priceMicros;
      await send('subscription_started', { workspaceName, planName: plan.name, tests: plan.creativeTestsPerMonth, price: formatUsd(price, 0), renewsOn: s ? day(s.current_period_end as string) : 'in one month', url: `${base}/this-week` }, await recipients(ws, ['OWNER']));
      return;
    }
    // Plan 04 §3: notice of a subscriber's price change, at least 30 days before it applies.
    case 'price_change_notice': {
      const [n] = await withTenant(ws, (tx) => tx`select plan_code, old_price_micros, new_price_micros, effective_from, applied_at from price_change_notices where id = ${String(data.noticeId)}`);
      if (!n || n.applied_at) return;
      await send(
        'price_change_notice',
        { workspaceName, planName: PLANS[n.plan_code as PlanCode].name, oldPrice: formatUsd(Number(n.old_price_micros), 0), newPrice: formatUsd(Number(n.new_price_micros), 0), effectiveOn: day(n.effective_from as string), url: `${base}/settings/billing` },
        await recipients(ws, ['OWNER']),
      );
      return;
    }
    case 'payment_failed':
      await send('payment_failed', { url: `${base}/settings/billing`, workspaceName }, await recipients(ws, ['OWNER']));
      return;
    case 'cancellation_confirmed': {
      // Queued with the cancellation (cancelId: one email per cancellation) or by a subscription staff ended in
      // Stripe. `endsAt` null means the plan ended today.
      const [s] = data.plan ? [] : await withTenant(ws, (tx) => tx`select plan_code, current_period_end from subscriptions order by created_at desc limit 1`);
      const planCode = ((data.plan as string | undefined) ?? (s?.plan_code as string | undefined) ?? 'GROWTH') as PlanCode;
      const endsAt = 'endsAt' in data ? (data.endsAt as string | null) : ((s?.current_period_end as string | undefined) ?? null);
      await send(
        'cancellation_confirmed',
        { workspaceName, planName: PLANS[planCode]?.name ?? 'Your plan', endsOn: endsAt ? day(endsAt) : 'today', exportUrl: `${base}/settings/data` },
        await recipients(ws, ['OWNER']),
        data.cancelId ? `cancel:${data.cancelId as string}` : data.subscriptionId ? `cancelled:${data.subscriptionId as string}` : undefined,
      );
      return;
    }
    case 'plan_ended':
    case 'plan_ended_payment_failed': {
      const [s] = await withTenant(ws, (tx) => tx`select plan_code from subscriptions where stripe_subscription_id = ${(data.subscriptionId as string) ?? null}`);
      const [st] = await withTenant(ws, (tx) => tx`select cancelled_at from workspaces where id = ${ws}`);
      const days = await withTenant(ws, (tx) => setting(tx, 'retention.cancelled_archive_days'));
      const deletesOn = day(new Date(new Date((st?.cancelled_at as string) ?? Date.now()).getTime() + days * 86400_000));
      const d = { workspaceName, planName: PLANS[(s?.plan_code as PlanCode) ?? 'GROWTH'].name, deletesOn, reactivateUrl: `${app}/app/plan`, exportUrl: `${base}/settings/data` };
      const key = data.subscriptionId ? `ended:${data.subscriptionId as string}` : undefined;
      if (data.template === 'plan_ended') await send('plan_ended', d, await recipients(ws, ['OWNER']), key);
      else await send('plan_ended_payment_failed', d, await recipients(ws, ['OWNER']), key);
      return;
    }
    case 'offer_ending': {
      const [o] = await withTenant(ws, (tx) => tx`select o.price_micros, o.reference_price_micros, o.expires_at, o.status, s.name, p.id as project_id
                                                   from offers o join projects p on p.id = o.project_id join skus s on s.id = p.sku_id where o.id = ${data.offerId as string}`);
      if (o && o.status === 'active') {
        // The intro price ends at a precise time: US Eastern, as the offer copy everywhere else (plan 04 "15:42 ET").
        const endsAt = formatTime(o.expires_at as string);
        // "After that": the price this workspace actually pays once the offer ends (its live standalone or
        // next-offer version), never a constant anchor.
        const after = await withTenant(ws, (tx) => quoteAfterOffer(tx));
        await sendRecovery('offer_ending', o.project_id as string, { workspaceName, productName: o.name, url: recoveryUrl(app, o.project_id as string, 'offer_ending'), endsAt, price: formatUsd(Number(o.price_micros), 0), regular: formatUsd(after.priceMicros, 0) });
      }
      return;
    }
    case 'storyboard_saved': {
      const [p] = await withTenant(ws, (tx) => tx`select s.name from projects p join skus s on s.id = p.sku_id where p.id = ${data.projectId as string}`);
      if (p) {
        const price = await withTenant(ws, (tx) => quoteAfterOffer(tx)); // the standing price, whatever intro offer runs
        await sendRecovery('storyboard_saved', data.projectId as string, { workspaceName, productName: p.name, url: recoveryUrl(app, data.projectId as string, 'storyboard_saved'), standalonePrice: formatUsd(price.priceMicros, 0) });
      }
      return;
    }
    case 'new_concept': {
      const [c] = await withTenant(ws, (tx) => tx`select c.proposal, s.name from concepts c join skus s on s.id = c.sku_id
                                                   where c.id = ${data.conceptId as string} and c.project_id = ${data.projectId as string}`);
      const hook = ((c?.proposal as { hookOptions?: string[] } | undefined)?.hookOptions ?? [])[0];
      if (c && hook) await sendRecovery('new_concept', data.projectId as string, { workspaceName, productName: c.name, url: recoveryUrl(app, data.projectId as string, 'new_concept'), hook });
      return;
    }
    case 'integration_disconnected':
      await send('integration_disconnected', { provider: String(data.provider), url: `${base}/settings/integrations`, workspaceName });
      return;
    case 'integration_expiring': {
      const on = new Date(String(data.expiresAt));
      await send('integration_expiring', { provider: String(data.provider), url: `${base}/settings/integrations`, workspaceName, expiresOn: Number.isNaN(on.getTime()) ? 'soon' : day(on) });
      return;
    }
    case 'shop_transfer_request': {
      // Filed by another workspace for a store routed here; only this workspace's owners decide (plan 02 §3 layer 8).
      const [r] = await withTenant(ws, (tx) => tx`select shop_domain, requester_email, status from shop_transfer_requests where id = ${data.requestId as string} and from_workspace_id = ${ws}`);
      if (!r || r.status !== 'pending') return;
      const [local, domain] = String(r.requester_email).split('@');
      await send('shop_transfer_request', { shop: r.shop_domain as string, requester: domain ? `${(local ?? '').slice(0, 1)}•••@${domain}` : 'Someone', url: `${base}/settings/integrations`, workspaceName }, await recipients(ws, ['OWNER']));
      return;
    }
    case 'export_ready': {
      // A delivery released after a hold carries the asset, not a (long expired) signed link.
      const url = data.assetId ? await withTenant(ws, (tx) => assetUrl(tx, data.assetId as string, 24 * 3600, 'arkiv-export.zip')) : String(data.url);
      await send('export_ready', { url, workspaceName }, await recipients(ws, ['OWNER']));
      return;
    }
    case 'invite': {
      // The invite link is a credential: it travels encrypted in the outbox. Only a still-live invite whose token is
      // the one queued is sent (a re-invite or revoke since then supersedes it).
      if (!data.tokenEnc || !data.inviteId) return;
      const token = openInviteToken(String(data.tokenEnc));
      const hash = createHash('sha256').update(token).digest('hex');
      const [inv] = await withTenant(ws, (tx) => tx`select email, role from invites where id = ${data.inviteId as string} and token_hash = ${hash}
                                                     and accepted_at is null and revoked_at is null and expires_at > now()`);
      if (!inv) return;
      await sendEmail(
        'invite',
        inv.email as string,
        { url: `${app}/invite/${token}`, workspaceName, inviterName: (data.inviterName as string | null) ?? 'A teammate', role: inv.role as string },
        { idempotencyKey: `invite:${data.inviteId as string}:${hash.slice(0, 16)}`, workspaceId: ws },
      );
      return;
    }
    case 'day30_review': {
      const [r] = await withTenant(ws, (tx) => tx`select id, sku_id, body from sku_reviews where id = ${data.reviewId as string}`);
      if (!r) return;
      const b = r.body as { sku: { name: string }; summary: { tested: number; actionable: number } };
      await send('day30_review', { workspaceName, productName: b.sku.name, tested: b.summary.tested, actionable: b.summary.actionable, url: `${base}/products/${r.sku_id}/review` });
      return;
    }
    case 'production_delayed': {
      // Still producing (the sweep may have raced the delivery): a finished or failed production gets no delay email.
      const [p] = await withTenant(ws, (tx) => tx`select p.id, p.state, s.name from projects p join skus s on s.id = p.sku_id where p.id = ${data.projectId as string}`);
      if (p && ['RENDER_RESERVED', 'RENDERING', 'QA_RUNNING', 'COMPOSING', 'PLATFORM_VARIANTS', 'FINAL_QA'].includes(p.state as string)) {
        await send('production_delayed', { workspaceName, productName: p.name as string, minutes: Number(data.minutes ?? 20), url: `${app}/produce/${p.id}` }, await recipients(ws, ['OWNER', 'ADMIN']));
      }
      return;
    }
    case 'rights_expired': {
      const ids = Array.isArray(data.assetIds) ? (data.assetIds as string[]) : [];
      const [s] = data.skuId ? await withTenant(ws, (tx) => tx`select id, name from skus where id = ${data.skuId as string}`) : [];
      const on = data.expiredOn ? new Date(String(data.expiredOn)) : null;
      await send('rights_expired', { workspaceName, productName: (s?.name as string | undefined) ?? 'your product', files: ids.length || 1, expiredOn: on && !Number.isNaN(on.getTime()) ? day(on) : 'recently', url: s ? `${base}/products/${s.id}?tab=assets` : `${base}/products` }, await recipients(ws, ['OWNER', 'ADMIN']));
      return;
    }
    case 'weekly_brief': {
      // Standard §11 Monday: at most one brief per workspace per week (a mid-week refresh shows in the app only).
      const week = String(data.week);
      const recs = await withTenant(ws, (tx) => tx`select proposal->>'hypothesis' as h, slot from recommendations where week_of = ${week} and status = 'open' order by score desc limit 3`);
      const empty = recs.length ? null : await emptyBriefReason(ws, base, (data.blockedReason as string | null) ?? null, day);
      if (!recs.length && !empty) return;
      await send('weekly_brief', { workspaceName, week: day(week), recommendations: recs.map((r) => ({ hypothesis: r.h as string, slot: r.slot as string })), url: `${base}/this-week`, empty }, undefined, `brief:${ws}:${week}`);
      return;
    }
    case 'signal_update': {
      // §11 midweek: only tests whose confidence crossed a threshold since the previous window; one email per
      // workspace per window, however many jobs a busy week queues (the send is keyed on the window).
      const window = String(data.window ?? '');
      const since = window ? new Date(Date.parse(`${window}T15:00:00Z`) - 7 * 86400_000) : new Date(Date.now() - 7 * 86400_000);
      const rows = await withTenant(ws, (tx) => tx`
        select distinct on (e.subject_id) e.subject_id, e.payload->>'to' as "to", x.hypothesis, s.name
        from events e join experiments x on x.id = e.subject_id join skus s on s.id = x.sku_id
        where e.type = 'CONFIDENCE_CHANGED' and e.at > ${since}
        order by e.subject_id, e.seq desc`);
      const first = await withTenant(ws, (tx) => tx`
        select distinct on (e.subject_id) e.subject_id, e.payload->>'from' as "from"
        from events e where e.type = 'CONFIDENCE_CHANGED' and e.at > ${since} order by e.subject_id, e.seq`);
      const from = new Map(first.map((r) => [r.subject_id as string, r.from as string]));
      const changes = rows
        .filter((r) => ['DIRECTIONAL', 'ACTIONABLE', 'INCONCLUSIVE', 'OPERATIONALLY_CONFOUNDED'].includes(r.to as string) && from.get(r.subject_id as string) !== r.to)
        .map((r) => ({ test: `${r.name as string}: ${String(r.hypothesis).slice(0, 120)}`, from: from.get(r.subject_id as string) ?? 'GATHERING_SIGNAL', to: r.to as string }));
      if (!changes.length) return;
      await send('signal_update', { workspaceName, changes, url: `${base}/results` }, undefined, `signal:${window || jobId}`);
      return;
    }
    case 'friday_summary': {
      const s = await fridaySummary(ws);
      if (!s.learned.length && !s.uncertain.length && !s.fatiguing.length && !s.nextLikely) return;
      await send('friday_summary', { workspaceName, ...s, url: `${base}/results` }, undefined, `friday:${ws}:${String(data.week ?? jobId)}`);
      return;
    }
    case 'ownership_transferred': {
      // A staff-requested transfer the Owner confirmed (plan 05 §2.2): both the new and previous owners are told.
      const ids = ((data.userIds as string[]) ?? []).filter(Boolean);
      if (!ids.length) return;
      const to = await withTenant(ws, (tx) => tx`select u.email from memberships m join users u on u.id = m.user_id where m.user_id in ${tx(ids)} and u.deleted_at is null`);
      await send('security_alert', { event: `Ownership of ${workspaceName} was transferred`, when: formatDateTime(new Date(), { timeZone: tz }), url: `${base}/settings/profile`, workspaceName }, to.map((r) => r.email as string));
      return;
    }
    case 'intervention': {
      // Retention playbook email (plan 05 §17), to owners and admins; never a discount.
      const pb = RISK_PLAYBOOKS[data.indicator as RiskIndicator];
      if (!pb?.email) return;
      await send('intervention', { workspaceName, label: 'From the Arkiv team', headline: pb.email.headline, body: pb.email.body, cta: pb.email.cta, url: `${base}${pb.email.path}` });
      return;
    }
    case 'staff_break_glass': {
      // Plan 05 §0.3: the owner is told when support opened the workspace, with a link to its own access log.
      const [bg] = data.breakGlassId ? await withTenant(ws, (tx) => tx`select started_at from break_glass_sessions where id = ${data.breakGlassId as string}`) : [];
      await send(
        'staff_break_glass',
        { workspaceName, staffName: String(data.staffName), reason: String(data.reason), when: formatDateTime((bg?.started_at as string | undefined) ?? new Date(), { timeZone: tz }), url: `${base}/settings/access-log` },
        await recipients(ws, ['OWNER']),
        data.breakGlassId ? `bg:${data.breakGlassId as string}` : undefined,
      );
      return;
    }
    case 'claim_review_result': {
      // Plan 03 A5/A10: the decision, the scope it may be used in and any change to the wording, on the SKU's claims.
      const [c] = await withTenant(ws, (tx) => tx`select c.id, c.sku_id, c.preferred_wording, c.source_text, c.allowed_platforms, c.allowed_markets, c.mandatory_qualifier, s.name
                                                   from claims c join skus s on s.id = c.sku_id where c.id = ${data.claimId as string}`);
      if (!c) return;
      await send(
        'claim_review_result',
        {
          workspaceName,
          productName: c.name as string,
          claim: c.preferred_wording as string,
          outcome: data.outcome as TemplateMap['claim_review_result']['outcome'],
          originalWording: (c.source_text as string | null) ?? null,
          platforms: (c.allowed_platforms as string[] | null) ?? [],
          markets: (c.allowed_markets as string[] | null) ?? [],
          qualifier: (c.mandatory_qualifier as string | null) ?? null,
          note: (data.note as string | null) ?? null,
          url: `${base}/products/${c.sku_id as string}/claims`,
        },
        await recipients(ws, ['OWNER', 'ADMIN']),
        `claimrev:${c.id as string}:${String(data.reviewId ?? jobId)}`,
      );
      return;
    }
    case 'purge_scheduled': {
      // Plan 02 §2: T-14d and T-1d notices before a purge, and the notice when it is scheduled. Sent only while the
      // workspace is still on that path (a cancelled deletion or a resubscription stops them).
      const [st] = await withTenant(ws, (tx) => tx`select state, purge_at, cancelled_at from workspaces where id = ${ws}`);
      const stage = data.stage as TemplateMap['purge_scheduled']['stage'];
      if (!st) return;
      if (stage === 'retention_ending' ? st.state !== 'CANCELLED' : st.state !== 'PURGE_SCHEDULED' || !st.purge_at) return;
      const purgeOn = day(stage === 'retention_ending' ? String(data.purgeOn) : (st.purge_at as string));
      const cancelUrl = stage === 'retention_ending' ? `${app}/app/plan` : `${base}/settings/data`;
      await send('purge_scheduled', { workspaceName, stage, purgeOn, cancelUrl, exportUrl: `${base}/settings/data` }, await recipients(ws, ['OWNER']), `purge-notice:${ws}:${String(data.at ?? jobId)}`);
      return;
    }
  }
}

/** Billing notices that must reach the customer somehow: shown in the app when no email could be delivered. */
const BILLING_NOTICES: Partial<Record<TemplateName, string>> = {
  receipt: 'We couldn’t email your receipt',
  invoice_receipt: 'We couldn’t email your receipt',
  cancellation_confirmed: 'We couldn’t email your cancellation confirmation',
  price_change_notice: 'We couldn’t email you about a price change',
  payment_failed: 'We couldn’t email you: a payment didn’t go through',
  plan_ended: 'We couldn’t email you: your plan has ended',
  plan_ended_payment_failed: 'We couldn’t email you: your plan has ended',
};

async function noticeUndeliverable(ws: string, template: TemplateName, title: string) {
  const source = `email:${template}`;
  // Notices are written by staff and system only (the app role may just dismiss them); explicit workspace filters.
  await withSystem(async (tx) => {
    await tx`update workspace_notices set dismissed_at = now() where workspace_id = ${ws} and source = ${source} and dismissed_at is null`;
    await tx`insert into workspace_notices (workspace_id, kind, source, title, body, link_path, link_label, created_by)
             values (${ws}, 'intervention', ${source}, ${title}, 'Mail to the owner’s address bounces. Check the details in Billing, and update your email address in Profile so notices reach you.', '/settings/billing', 'Open billing', 'system:email')`;
  });
}

/**
 * A Monday with no open recommendations still gets a brief that says why and what to do (standard §11): no active
 * product, no Creative Tests left this period, or not enough data yet.
 */
async function emptyBriefReason(ws: string, base: string, blocked: string | null, day: (v: string | Date | null) => string): Promise<TemplateMap['weekly_brief']['empty']> {
  return withTenant(ws, async (tx) => {
    const [sku] = await tx`select 1 from skus where status = 'active' limit 1`;
    if (!sku) return { reason: 'There’s no active product to test yet. Add one and we’ll recommend tests for it next Monday.', cta: 'Add a product', url: `${base}/products` };
    if (blocked === 'PAYMENT_REQUIRED') {
      const [s] = await tx`select current_period_end from subscriptions where status in ('active','trialing','past_due') order by created_at desc limit 1`;
      return { reason: `You’ve used this period’s Creative Tests. New ones arrive ${s ? `on ${day(s.current_period_end as string)}` : 'when your plan renews'}; you can still review last week’s results.`, cta: 'See results', url: `${base}/results` };
    }
    return { reason: 'We don’t have a new test worth running yet: we’re waiting for more results from the tests you’re running. We’ll tell you as soon as one crosses a threshold.', cta: 'See where tests stand', url: `${base}/results` };
  });
}

/**
 * Standard §11 Friday: what was learned this week, what is still uncertain (tests gathering signal, with their
 * progress), what is fatiguing (measured winner fatigue), and the likely next recommendation.
 */
export async function fridaySummary(ws: string): Promise<Pick<TemplateMap['friday_summary'], 'learned' | 'uncertain' | 'fatiguing' | 'nextLikely'>> {
  return withTenant(ws, async (tx) => {
    const learned = await tx`select statement, state from learnings where last_revalidated_at > now() - interval '7 days' order by confidence desc limit 4`;
    const uncertain = await tx`select x.hypothesis, x.state, s.name, coalesce(sum(r.trials), 0)::float8 as trials
                               from experiments x join skus s on s.id = x.sku_id
                               left join experiment_results r on r.experiment_id = x.id and r.workspace_id = x.workspace_id
                               where x.state in ('GATHERING_SIGNAL', 'DIRECTIONAL') group by x.id, s.name order by x.updated_at desc limit 3`;
    const fatiguing = await tx`select x.hypothesis, x.fatigue->>'reason' as reason, s.name from experiments x join skus s on s.id = x.sku_id
                               where (x.fatigue->>'fatigued')::boolean is true and x.fatigue_at > now() - interval '14 days' order by x.fatigue_at desc limit 3`;
    const [next] = await tx`select proposal->>'hypothesis' as h from recommendations where status = 'open' order by week_of desc, score desc limit 1`;
    const stateLabel = (s: string) => (s === 'ACTIONABLE' ? 'Actionable' : s === 'DIRECTIONAL' ? 'Directional' : 'Weakening');
    return {
      learned: learned.map((l) => `${stateLabel(l.state as string)}: ${l.statement as string}`),
      uncertain: uncertain.map((u) => `${u.name as string}: ${String(u.hypothesis).slice(0, 120)} (${u.state === 'DIRECTIONAL' ? 'directional' : 'gathering signal'}${Number(u.trials) > 0 ? `, ${Math.round(Number(u.trials)).toLocaleString('en-US')} measured so far` : ''})`),
      fatiguing: fatiguing.map((f) => `${f.name as string}: ${String(f.hypothesis).slice(0, 100)}${f.reason ? ` (${f.reason as string})` : ''}`),
      nextLikely: (next?.h as string | undefined) ?? null,
    };
  });
}
