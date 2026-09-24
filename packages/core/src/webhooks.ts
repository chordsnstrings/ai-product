import { globalTx, withSystem, withTenant } from '@arkiv/db';
import { logger } from '@arkiv/shared/log';
import type { TenantContext } from './context';
import { emit } from './events';
import { enqueue, Queues } from './outbox';

const log = logger('webhooks');

export type WebhookProvider = 'shopify' | 'resend' | 'meta' | 'tiktok';

/** A processing attempt older than this is presumed abandoned (crashed worker) and may be claimed again. */
export const WEBHOOK_CLAIM_STALE_MINUTES = 5;
/** Attempts before a receipt is left as failed for staff to look at. */
export const WEBHOOK_MAX_ATTEMPTS = 5;

/**
 * Standard §38 "verify signature, deduplicate, persist raw receipt, async process": the web app calls this after
 * verifying the signature. The raw body is stored once per provider delivery id (a redelivery is a no-op) and the
 * worker processes it. Returns whether the delivery was new.
 */
export async function receiveWebhook(provider: WebhookProvider, deliveryId: string, topic: string, payload: string, headers: Record<string, string | null> = {}): Promise<boolean> {
  const [r] = await globalTx((tx) => tx`select webhook_receive(${provider}, ${deliveryId.slice(0, 200)}, ${topic.slice(0, 100)}, ${payload}, ${tx.json(headers as never)}) as inserted`);
  return !!r?.inserted;
}

type Receipt = { id: string; provider: WebhookProvider; delivery_id: string; topic: string; payload: string; headers: Record<string, string | null> };

const systemCtx = (workspaceId: string): Pick<TenantContext, 'workspaceId' | 'actor'> => ({ workspaceId, actor: { kind: 'system', id: 'webhook' } });

/**
 * The platform revoked our access (Shopify uninstall/shop redact, Meta deauthorize/data deletion, TikTok
 * authorization removed, §40): the integration stops syncing, its tokens are dropped and INTEGRATION_DISCONNECTED
 * is recorded so the workspace sees it and recommendations know performance data is gone.
 */
async function revoke(workspaceId: string, integrationIds: string[], provider: string, reason: string) {
  await withTenant(workspaceId, async (tx) => {
    for (const id of integrationIds) {
      const [i] = await tx`update integrations set status = 'revoked', token_enc = null, refresh_token_enc = null, error = ${tx.json({ reason, at: new Date().toISOString() })}, updated_at = now()
                           where id = ${id} and workspace_id = ${workspaceId} and status <> 'revoked' returning external_account_id`;
      if (!i) continue;
      if (provider === 'shopify') await tx`delete from shopify_shops where shop_domain = ${i.external_account_id} and workspace_id = ${workspaceId}`;
      await emit(tx, systemCtx(workspaceId), 'INTEGRATION_DISCONNECTED', { type: 'integration', id }, { provider, reason });
    }
  });
}

/** Integrations (across workspaces) a platform callback names; system role, filtered by provider and the named id. */
async function integrationsFor(provider: string, by: { account?: string[]; user?: string }): Promise<{ id: string; workspace_id: string }[]> {
  return withSystem((tx) =>
    by.user
      ? tx`select id, workspace_id from integrations where provider = ${provider} and platform_user_id = ${by.user}`
      : tx`select id, workspace_id from integrations where provider = ${provider} and external_account_id = any(${by.account ?? []}::text[])`,
  ) as Promise<{ id: string; workspace_id: string }[]>;
}

async function revokeAll(rows: { id: string; workspace_id: string }[], provider: string, reason: string) {
  const byWs = new Map<string, string[]>();
  for (const r of rows) byWs.set(r.workspace_id, [...(byWs.get(r.workspace_id) ?? []), r.id]);
  for (const [ws, ids] of byWs) await revoke(ws, ids, provider, reason);
  return rows.length;
}

/** Handlers that live outside core (the email package), passed in by the worker. */
export interface WebhookDeps {
  resendEvent: (evt: { type: string; data: { email_id?: string; to?: string[] } }) => Promise<void>;
}

/** Handle one stored delivery. Returns 'ignored' for topics we acknowledge without acting on. */
async function handle(r: Receipt, deps: WebhookDeps): Promise<'processed' | 'ignored'> {
  const body = r.payload ? (JSON.parse(r.payload) as Record<string, unknown>) : {};
  switch (r.provider) {
    case 'resend': {
      await deps.resendEvent(body as { type: string; data: { email_id?: string; to?: string[] } });
      return 'processed';
    }
    case 'shopify': {
      const shop = r.headers['x-shopify-shop-domain'] ?? '';
      const rows = shop ? await integrationsFor('shopify', { account: [shop] }) : [];
      if (r.topic === 'app/uninstalled' || r.topic === 'shop/redact') {
        await revokeAll(rows, 'shopify', r.topic);
        return 'processed';
      }
      if (r.topic === 'customers/data_request' || r.topic === 'customers/redact') {
        // Mandatory GDPR topics. We hold no Shopify customer records (read_products scope), but imported reviews may
        // name the person: the request is filed for staff with Shopify's 30-day response window.
        const email = ((body.customer as { email?: string } | undefined)?.email ?? shop) || 'unknown';
        await withSystem((tx) => tx`insert into data_requests (workspace_id, kind, requester_email, status, due_at, notes)
                                    values (${rows[0]?.workspace_id ?? null}, ${r.topic === 'customers/redact' ? 'delete_person_in_reviews' : 'access'}, ${email}, 'open',
                                            now() + interval '30 days', ${`Shopify ${r.topic} from ${shop} (webhook ${r.delivery_id}).`})`);
        return 'processed';
      }
      if (r.topic === 'products/update' || r.topic === 'products/create') {
        for (const i of rows) {
          await withTenant(i.workspace_id, (tx) => enqueue(tx, i.workspace_id, Queues.syncIntegration, { integrationId: i.id, full: false }, { singletonKey: `sync:${i.id}` }));
        }
        return 'processed';
      }
      return 'ignored';
    }
    case 'meta': {
      // deauthorize | data_deletion: the payload is the verified signed_request's user id.
      const rows = await integrationsFor('meta', { user: String(body.userId ?? '') });
      await revokeAll(rows, 'meta', r.topic);
      return 'processed';
    }
    case 'tiktok': {
      if (!/authoriz|revoke|deauth/i.test(r.topic)) return 'ignored';
      const content = (typeof body.content === 'string' ? JSON.parse(body.content) : (body.content ?? body)) as { advertiser_ids?: (string | number)[] };
      const rows = await integrationsFor('tiktok', { account: (content.advertiser_ids ?? []).map(String) });
      await revokeAll(rows, 'tiktok', r.topic);
      return 'processed';
    }
  }
}

/** Claim and process one receipt; a failure is retried up to WEBHOOK_MAX_ATTEMPTS, then left failed. */
export async function processWebhookReceipt(id: string, deps: WebhookDeps): Promise<string> {
  const [r] = await withSystem((tx) => tx`
    update webhook_receipts set status = 'processing', claimed_at = now(), attempts = attempts + 1
    where id = ${id} and (status = 'pending' or (status = 'processing' and claimed_at < now() - make_interval(mins => ${WEBHOOK_CLAIM_STALE_MINUTES})))
    returning id, provider, delivery_id, topic, payload, headers`);
  if (!r) return 'skipped';
  try {
    const outcome = await handle(r as unknown as Receipt, deps);
    await withSystem((tx) => tx`update webhook_receipts set status = ${outcome}, processed_at = now(), error = null where id = ${id}`);
    return outcome;
  } catch (e) {
    log.warn('webhook processing failed', { receiptId: id, provider: r.provider, topic: r.topic, err: e });
    await withSystem((tx) => tx`update webhook_receipts set status = case when attempts >= ${WEBHOOK_MAX_ATTEMPTS} then 'failed' else 'pending' end,
                                  error = ${(e as Error).message.slice(0, 500)} where id = ${id}`);
    return 'error';
  }
}

/** Worker drain loop: pending receipts (and abandoned claims), oldest first. */
export async function processPendingWebhooks(deps: WebhookDeps, limit = 50): Promise<number> {
  // A failed attempt waits 30s × attempts before the next one.
  const rows = await withSystem((tx) => tx`select id from webhook_receipts
                                           where (status = 'pending' and (claimed_at is null or claimed_at < now() - make_interval(secs => 30 * attempts)))
                                              or (status = 'processing' and claimed_at < now() - make_interval(mins => ${WEBHOOK_CLAIM_STALE_MINUTES}))
                                           order by received_at limit ${limit}`);
  for (const r of rows) await processWebhookReceipt(r.id as string, deps);
  return rows.length;
}
