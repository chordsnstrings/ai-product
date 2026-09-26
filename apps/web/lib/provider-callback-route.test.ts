import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool } from '@arkiv/db';
import { truncateAll } from '@arkiv/db/testing';
import { providerCallbackUrl } from '@arkiv/core';
import { newId, resetEnvCache } from '@arkiv/shared';

const { POST } = await import('../app/api/webhooks/provider/[provider]/route');

/** The render callback endpoint (standard §39): signed per job, stored once, anything else refused. */
beforeEach(async () => {
  await truncateAll();
  process.env.PROVIDER_CALLBACK_SECRET = 'callback-secret-for-tests-0001';
  process.env.APP_URL = 'https://app.arkiv.test';
  resetEnvCache();
});
afterEach(() => {
  delete process.env.PROVIDER_CALLBACK_SECRET;
  delete process.env.APP_URL;
  resetEnvCache();
});
afterAll(closeAll);

const post = (url: string, body: unknown, provider = 'byteplus') =>
  POST(new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) }), { params: Promise.resolve({ provider }) });

describe('POST /api/webhooks/provider/:provider', () => {
  it('stores a signed callback once and refuses forged, foreign or malformed ones', async () => {
    const jobId = newId();
    const url = providerCallbackUrl('byteplus', jobId)!;
    const ok = await post(url, { id: 'cgt-1', status: 'succeeded' });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, duplicate: false });
    expect(await (await post(url, { id: 'cgt-1', status: 'succeeded' })).json()).toEqual({ ok: true, duplicate: true });
    expect((await post(url.replace(jobId, newId()), { id: 'cgt-1', status: 'succeeded' })).status).toBe(401); // signature is per job
    expect((await post(url.replace(/sig=[^&]+/, 'sig=forged'), { id: 'cgt-1', status: 'succeeded' })).status).toBe(401);
    expect((await post(url, 'not json')).status).toBe(400);
    expect((await post(url, { hello: 'world' })).status).toBe(400);
    expect((await post(url, { id: 'cgt-1', status: 'succeeded' }, 'minimax')).status).toBe(404);
    const receipts = await ownerPool()`select provider, delivery_id, topic from webhook_receipts`;
    expect(receipts).toEqual([{ provider: 'byteplus', delivery_id: `${jobId}:cgt-1:succeeded`, topic: 'video.succeeded' }]);
  });
});
