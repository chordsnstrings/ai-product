import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool, withTenant } from '@arkiv/db';
import { makeTenant, truncateAll } from '@arkiv/db/testing';
import { mockTokenRevoker, setTokenRevoker } from '@arkiv/integrations';
import { purgeWorkspace } from './lifecycle';
import { disconnectIntegration, saveIntegration } from './performance';
import { ctxFor } from './testing';

/**
 * Plan 02 §7 purge step 1 ("Revoke integration tokens at Shopify/Meta/TikTok") and §47 disconnect: tokens are
 * withdrawn at the platform, best effort, before they are dropped here.
 */
let revoker = mockTokenRevoker();
beforeEach(async () => {
  await truncateAll();
  revoker = mockTokenRevoker((_p, account) => account === 'act_down');
  setTokenRevoker(revoker);
});
afterEach(() => setTokenRevoker(null));
afterAll(closeAll);

async function connect(t: Awaited<ReturnType<typeof makeTenant>>, provider: 'shopify' | 'meta' | 'tiktok', account: string, token: string) {
  const ctx = ctxFor(t.workspaceId, t.userId);
  return withTenant(t.workspaceId, (tx) => saveIntegration(tx, ctx, { provider, externalAccountId: account, token, scopes: ['read'] }));
}

describe('disconnecting an integration', () => {
  it('revokes the token at the platform, drops it, and emails the owners once', async () => {
    const t = await makeTenant();
    const ctx = ctxFor(t.workspaceId, t.userId);
    const shop = await connect(t, 'shopify', 'glow.myshopify.com', 'shpat_1');
    await ownerPool()`delete from outbox`;
    await withTenant(t.workspaceId, (tx) => disconnectIntegration(tx, ctx, shop));
    expect(revoker.calls).toEqual([{ provider: 'shopify', token: 'shpat_1', account: 'glow.myshopify.com' }]);
    expect((await ownerPool()`select status, token_enc from integrations where id = ${shop}`)[0]).toEqual({ status: 'disconnected', token_enc: null });
    const [ev] = await ownerPool()`select payload from events where type = 'INTEGRATION_DISCONNECTED' and subject_id = ${shop}`;
    expect(ev!.payload).toMatchObject({ provider: 'shopify', revokedAtPlatform: true });
    // Disconnecting again: nothing left to revoke, no second email.
    await withTenant(t.workspaceId, (tx) => disconnectIntegration(tx, ctx, shop));
    expect(revoker.calls).toHaveLength(1);
    const mails = await ownerPool()`select payload from outbox where queue = 'send-email' and workspace_id = ${t.workspaceId}`;
    expect(mails.map((m) => [m.payload.template, m.payload.provider])).toEqual([['integration_disconnected', 'Shopify']]);
  });

  it('still disconnects when the platform can’t be reached, and records that the token was not revoked', async () => {
    const t = await makeTenant();
    const ctx = ctxFor(t.workspaceId, t.userId);
    const meta = await connect(t, 'meta', 'act_down', 'EAAB-token');
    await withTenant(t.workspaceId, (tx) => disconnectIntegration(tx, ctx, meta));
    expect((await ownerPool()`select status, token_enc from integrations where id = ${meta}`)[0]).toEqual({ status: 'disconnected', token_enc: null });
    const [ev] = await ownerPool()`select payload from events where type = 'INTEGRATION_DISCONNECTED' and subject_id = ${meta}`;
    expect(ev!.payload).toMatchObject({ provider: 'meta', revokedAtPlatform: false, revokeError: '[meta] mock revoke failure' });
  });
});

describe('workspace purge', () => {
  it('revokes every stored token first, names the ones it couldn’t on the certificate, and touches no other workspace', async () => {
    const t = await makeTenant({ state: 'PURGE_SCHEDULED' });
    const other = await makeTenant();
    await connect(t, 'meta', 'act_1', 'tok-meta');
    await connect(t, 'tiktok', '7001', 'tok-tt');
    await connect(t, 'meta', 'act_down', 'tok-down');
    await connect(other, 'meta', 'act_9', 'tok-other');
    revoker.calls.length = 0;
    await ownerPool()`update workspaces set purge_at = now() - interval '1 minute' where id = ${t.workspaceId}`;
    const counts = await purgeWorkspace(t.workspaceId);
    expect(revoker.calls.map((c) => c.token).sort()).toEqual(['tok-down', 'tok-meta', 'tok-tt']);
    expect(counts.integration_tokens_revoked).toBe(2);
    const [cert] = await ownerPool()`select undeletable from purge_certificates where workspace_id = ${t.workspaceId}`;
    expect(cert!.undeletable).toEqual([expect.stringMatching(/^meta access for act_down not revoked at the platform: \[meta\] mock revoke failure/)]);
    expect(await ownerPool()`select 1 from integrations where workspace_id = ${t.workspaceId}`).toHaveLength(0);
    expect(await ownerPool()`select 1 from integrations where workspace_id = ${other.workspaceId} and token_enc is not null`).toHaveLength(1);
  });
});
