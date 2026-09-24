import { withTenant } from '@arkiv/db';
import { env, formatUsd, PLANS, PRICES, type PlanCode, type RiskIndicator } from '@arkiv/shared';
import { sendEmail, type TemplateMap, type TemplateName } from '@arkiv/email';
import { assetUrl, recoveryEmailKey, recoveryStatus, recoveryUrl, RISK_PLAYBOOKS, type RecoveryTemplate, type TenantContext } from '@arkiv/core';

/**
 * Builds template data for queued emails from tenant data, and picks recipients (owners/admins by default).
 * Workspace slug is resolved here so links always land inside the right workspace (plan 02 M11).
 */
async function recipients(workspaceId: string, roles = ['OWNER', 'ADMIN']): Promise<string[]> {
  return withTenant(workspaceId, async (tx) =>
    (await tx`select u.email from memberships m join users u on u.id = m.user_id where m.role in ${tx(roles)} and u.deleted_at is null`).map((r) => r.email as string),
  );
}

export async function sendQueuedEmail(ctx: TenantContext, data: Record<string, unknown>, jobId: string) {
  const ws = ctx.workspaceId;
  const app = env().APP_URL;
  const [w] = await withTenant(ws, (tx) => tx`select slug, name from workspaces where id = ${ws}`);
  const base = `${app}/w/${w!.slug}`;
  const send = async <T extends TemplateName>(t: T, d: TemplateMap[T], to?: string[]) => {
    for (const email of to ?? (await recipients(ws))) {
      await sendEmail(t, email, d, { idempotencyKey: `${jobId}:${t}:${email}`, workspaceId: ws });
    }
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
      const [p] = await withTenant(ws, (tx) => tx`select p.id, s.name, s.catalogue_no from projects p join skus s on s.id = p.sku_id where p.id = ${data.projectId as string}`);
      if (p) await send('asset_ready', { productName: p.name, url: `${app}/deliver/${p.id}`, catalogueNo: `No. ${String(p.catalogue_no).padStart(3, '0')}` });
      return;
    }
    case 'receipt': {
      const [pu] = await withTenant(ws, (tx) => tx`select pu.amount_micros, pu.kind, pu.project_id, s.name from purchases pu join projects p on p.id = pu.project_id join skus s on s.id = p.sku_id where pu.id = ${data.purchaseId as string}`);
      if (pu) await send('receipt', { productName: pu.name, amount: formatUsd(Number(pu.amount_micros)), description: pu.kind === 'taste' ? '15-second ad · intro price' : '15-second ad', url: `${app}/produce/${pu.project_id}` });
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
      const [s] = await withTenant(ws, (tx) => tx`select current_period_end from subscriptions order by created_at desc limit 1`);
      await send('subscription_started', { planName: plan.name, tests: plan.creativeTestsPerMonth, price: formatUsd(plan.priceMicros, 0), renewsOn: s ? new Date(s.current_period_end as string).toDateString() : 'in one month', url: `${base}/this-week` }, await recipients(ws, ['OWNER']));
      return;
    }
    case 'payment_failed':
      await send('payment_failed', { url: `${base}/settings/billing`, workspaceName: w!.name }, await recipients(ws, ['OWNER']));
      return;
    case 'cancellation_confirmed': {
      const [s] = await withTenant(ws, (tx) => tx`select plan_code, current_period_end from subscriptions order by created_at desc limit 1`);
      await send('cancellation_confirmed', { planName: PLANS[(s?.plan_code as PlanCode) ?? 'GROWTH'].name, endsOn: s ? new Date(s.current_period_end as string).toDateString() : 'today', exportUrl: `${base}/settings/data` }, await recipients(ws, ['OWNER']));
      return;
    }
    case 'offer_ending': {
      const [o] = await withTenant(ws, (tx) => tx`select o.price_micros, o.reference_price_micros, o.expires_at, o.status, s.name, p.id as project_id
                                                   from offers o join projects p on p.id = o.project_id join skus s on s.id = p.sku_id where o.id = ${data.offerId as string}`);
      if (o && o.status === 'active') {
        const endsAt = new Date(o.expires_at as string).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York' }) + ' ET';
        await sendRecovery('offer_ending', o.project_id as string, { productName: o.name, url: recoveryUrl(app, o.project_id as string, 'offer_ending'), endsAt, price: formatUsd(Number(o.price_micros), 0), regular: formatUsd(Number(o.reference_price_micros ?? 29_000_000), 0) });
      }
      return;
    }
    case 'storyboard_saved': {
      const [p] = await withTenant(ws, (tx) => tx`select s.name from projects p join skus s on s.id = p.sku_id where p.id = ${data.projectId as string}`);
      if (p) await sendRecovery('storyboard_saved', data.projectId as string, { productName: p.name, url: recoveryUrl(app, data.projectId as string, 'storyboard_saved'), standalonePrice: formatUsd(PRICES.STANDALONE, 0) });
      return;
    }
    case 'new_concept': {
      const [c] = await withTenant(ws, (tx) => tx`select c.proposal, s.name from concepts c join skus s on s.id = c.sku_id
                                                   where c.id = ${data.conceptId as string} and c.project_id = ${data.projectId as string}`);
      const hook = ((c?.proposal as { hookOptions?: string[] } | undefined)?.hookOptions ?? [])[0];
      if (c && hook) await sendRecovery('new_concept', data.projectId as string, { productName: c.name, url: recoveryUrl(app, data.projectId as string, 'new_concept'), hook });
      return;
    }
    case 'integration_disconnected':
      await send('integration_disconnected', { provider: String(data.provider), url: `${base}/settings/integrations`, workspaceName: w!.name });
      return;
    case 'export_ready': {
      // A delivery released after a hold carries the asset, not a (long expired) signed link.
      const url = data.assetId ? await withTenant(ws, (tx) => assetUrl(tx, data.assetId as string, 24 * 3600, 'arkiv-export.zip')) : String(data.url);
      await send('export_ready', { url, workspaceName: w!.name }, await recipients(ws, ['OWNER']));
      return;
    }
    case 'invite':
      await sendEmail('invite', String(data.email), { url: `${app}/invite/${data.token}`, workspaceName: w!.name, inviterName: String(data.inviterName ?? 'A teammate'), role: String(data.role) }, { idempotencyKey: `${jobId}:invite`, workspaceId: ws });
      return;
    case 'weekly_brief': {
      const recs = await withTenant(ws, (tx) => tx`select proposal->>'hypothesis' as h, slot from recommendations where week_of = ${data.week as string} and status = 'open' order by score desc limit 3`);
      if (recs.length) await send('weekly_brief', { workspaceName: w!.name, week: String(data.week), recommendations: recs.map((r) => ({ hypothesis: r.h as string, slot: r.slot as string })), url: `${base}/this-week` });
      return;
    }
    case 'friday_summary': {
      const lines = await withTenant(ws, (tx) => tx`select statement, state from learnings where last_revalidated_at > now() - interval '7 days' order by confidence desc limit 4`);
      const out = lines.map((l) => `${l.state === 'ACTIONABLE' ? 'Actionable' : l.state === 'DIRECTIONAL' ? 'Directional' : 'Weakening'}: ${l.statement}`);
      if (out.length) await send('friday_summary', { workspaceName: w!.name, lines: out, url: `${base}/results` });
      return;
    }
    case 'ownership_transferred': {
      // A staff-requested transfer the Owner confirmed (plan 05 §2.2): both the new and previous owners are told.
      const ids = ((data.userIds as string[]) ?? []).filter(Boolean);
      if (!ids.length) return;
      const to = await withTenant(ws, (tx) => tx`select u.email from memberships m join users u on u.id = m.user_id where m.user_id in ${tx(ids)} and u.deleted_at is null`);
      await send('security_alert', { event: `Ownership of ${w!.name as string} was transferred`, when: new Date().toUTCString(), url: `${base}/settings/profile` }, to.map((r) => r.email as string));
      return;
    }
    case 'intervention': {
      // Retention playbook email (plan 05 §17), to owners and admins; never a discount.
      const pb = RISK_PLAYBOOKS[data.indicator as RiskIndicator];
      if (!pb?.email) return;
      await send('intervention', { label: 'From the Arkiv team', headline: pb.email.headline, body: pb.email.body, cta: pb.email.cta, url: `${base}${pb.email.path}` });
      return;
    }
    case 'staff_break_glass':
      await send('staff_break_glass', { staffName: String(data.staffName), reason: String(data.reason), when: new Date().toUTCString(), url: `${base}/settings/access-log` }, await recipients(ws, ['OWNER']));
      return;
  }
}
