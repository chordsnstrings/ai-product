import { createHmac } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeAll, globalTx, ownerPool, withTenant } from '@arkiv/db';
import { makeTenant, truncateAll } from '@arkiv/db/testing';
import { parseMetaSignedRequest, verifyTiktokWebhook } from '@arkiv/integrations';
import { resetEnvCache } from '@arkiv/shared';
import { saveIntegration } from './performance';
import { ctxFor } from './testing';
import { processPendingWebhooks, receiveWebhook } from './webhooks';

beforeEach(async () => {
  await truncateAll();
  process.env.META_APP_SECRET = 'meta-test-secret';
  process.env.TIKTOK_APP_SECRET = 'tiktok-test-secret';
  resetEnvCache();
});
afterEach(() => {
  delete process.env.META_APP_SECRET;
  delete process.env.TIKTOK_APP_SECRET;
  resetEnvCache();
});
afterAll(closeAll);

const deps = () => ({ resendEvent: vi.fn(async () => {}) });

async function connected(provider: 'shopify' | 'meta' | 'tiktok', account: string, platformUserId?: string) {
  const t = await makeTenant();
  const ctx = ctxFor(t.workspaceId, t.userId);
  const id = await withTenant(t.workspaceId, (tx) => saveIntegration(tx, ctx, { provider, externalAccountId: account, token: 'tok', scopes: ['read'], platformUserId }));
  return { t, id };
}
const integration = (id: string) => ownerPool()`select status, token_enc from integrations where id = ${id}`.then((r) => r[0]);
const disconnected = (ws: string) => ownerPool()`select subject_id, actor, payload from events where workspace_id = ${ws} and type = 'INTEGRATION_DISCONNECTED'`;

describe('webhook receipts (standard §38: verify, deduplicate, persist raw, async process)', () => {
  it('stores each delivery once, out of the app role’s reach, and processes it in the worker', async () => {
    expect(await receiveWebhook('resend', 'msg_1', 'email.bounced', '{"type":"email.bounced","data":{"to":["x@y.com"]}}')).toBe(true);
    expect(await receiveWebhook('resend', 'msg_1', 'email.bounced', '{"type":"email.bounced","data":{"to":["x@y.com"]}}')).toBe(false); // redelivery
    await expect(globalTx((tx) => tx`select * from webhook_receipts`)).rejects.toThrow(/permission denied/);
    const d = deps();
    expect(await processPendingWebhooks(d)).toBe(1);
    expect(d.resendEvent).toHaveBeenCalledTimes(1);
    expect(await processPendingWebhooks(d)).toBe(0);
    const [r] = await ownerPool()`select status, attempts, payload from webhook_receipts`;
    expect(r).toMatchObject({ status: 'processed', attempts: 1 });
    expect(JSON.parse(r!.payload as string).type).toBe('email.bounced'); // raw receipt kept
  });

  it('Shopify: uninstall revokes the shop’s integration; GDPR topics are recorded; product updates queue a sync', async () => {
    const { t, id } = await connected('shopify', 'glow.myshopify.com');
    const other = await connected('shopify', 'other.myshopify.com');
    await ownerPool()`delete from outbox`; // the connect's own first sync
    const shop = { 'x-shopify-shop-domain': 'glow.myshopify.com' };
    await receiveWebhook('shopify', 'w-1', 'products/update', '{"id":1}', shop);
    await receiveWebhook('shopify', 'w-2', 'customers/redact', '{"customer":{"email":"buyer@example.com"}}', shop);
    await receiveWebhook('shopify', 'w-3', 'app/uninstalled', '{}', shop);
    await processPendingWebhooks(deps());
    expect(await integration(id)).toEqual({ status: 'revoked', token_enc: null });
    expect((await integration(other.id))!.status).toBe('active');
    const ev = await disconnected(t.workspaceId);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ subject_id: id, actor: 'system:webhook', payload: { provider: 'shopify', reason: 'app/uninstalled' } });
    expect(await ownerPool()`select 1 from shopify_shops where shop_domain = 'glow.myshopify.com'`).toHaveLength(0);
    const [dr] = await ownerPool()`select workspace_id, kind, requester_email, status from data_requests`;
    expect(dr).toMatchObject({ workspace_id: t.workspaceId, kind: 'delete_person_in_reviews', requester_email: 'buyer@example.com', status: 'open' });
    const jobs = await ownerPool()`select payload from outbox where workspace_id = ${t.workspaceId} and queue like 'sync-integration%' and payload->>'full' = 'false'`;
    expect(jobs).toHaveLength(1);
  });

  it('Meta deauthorize revokes what that user authorised; TikTok authorization removal revokes the named advertisers', async () => {
    const meta = await connected('meta', 'act_1', 'fb-user-1');
    const metaOther = await connected('meta', 'act_2', 'fb-user-2');
    const tt = await connected('tiktok', '7001');
    await receiveWebhook('meta', 'deauthorize:abc', 'deauthorize', JSON.stringify({ userId: 'fb-user-1' }));
    await receiveWebhook('tiktok', 'h1', 'authorization.removed', JSON.stringify({ event: 'authorization.removed', content: JSON.stringify({ advertiser_ids: ['7001'] }) }));
    await processPendingWebhooks(deps());
    expect((await integration(meta.id))!.status).toBe('revoked');
    expect((await integration(metaOther.id))!.status).toBe('active');
    expect((await integration(tt.id))!.status).toBe('revoked');
    expect(await disconnected(meta.t.workspaceId)).toHaveLength(1);
    expect(await disconnected(tt.t.workspaceId)).toHaveLength(1);
  });

  it('a failing receipt is retried, then left failed', async () => {
    await receiveWebhook('resend', 'msg_bad', 'email.sent', '{"type":"email.sent","data":{}}');
    const d = { resendEvent: vi.fn(async () => { throw new Error('boom'); }) };
    await processPendingWebhooks(d);
    const [r] = await ownerPool()`select status, attempts, error from webhook_receipts`;
    expect(r).toMatchObject({ status: 'pending', attempts: 1, error: 'boom' });
    await ownerPool()`update webhook_receipts set attempts = 4, claimed_at = now() - interval '1 hour'`;
    await processPendingWebhooks(d);
    expect((await ownerPool()`select status from webhook_receipts`)[0]!.status).toBe('failed');
  });
});

describe('platform callback signatures', () => {
  it('verifies a Meta signed_request and a TikTok signature with the app secrets', () => {
    const body = Buffer.from(JSON.stringify({ algorithm: 'HMAC-SHA256', user_id: '42', issued_at: 1 })).toString('base64url');
    const sig = createHmac('sha256', 'meta-test-secret').update(body).digest('base64url');
    expect(parseMetaSignedRequest(`${sig}.${body}`)).toEqual({ userId: '42', issuedAt: 1 });
    expect(parseMetaSignedRequest(`${sig.slice(1)}x.${body}`)).toBeNull();
    const raw = '{"event":"authorization.removed"}';
    const t = Math.floor(Date.now() / 1000);
    const s = createHmac('sha256', 'tiktok-test-secret').update(`${t}.${raw}`).digest('hex');
    expect(verifyTiktokWebhook(raw, `t=${t},s=${s}`)).toBe(true);
    expect(verifyTiktokWebhook(raw, `t=${t - 3600},s=${createHmac('sha256', 'tiktok-test-secret').update(`${t - 3600}.${raw}`).digest('hex')}`)).toBe(false);
    expect(verifyTiktokWebhook(`${raw} `, `t=${t},s=${s}`)).toBe(false);
  });
});
