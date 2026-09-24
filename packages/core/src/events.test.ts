import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool, withTenant } from '@arkiv/db';
import { makeSku, makeTenant, truncateAll } from '@arkiv/db/testing';
import { EVENT_REF_KEYS, EVENT_REQUIRED_REFS, EVENT_SUBJECT, EventType, SUBJECT_REF } from '@arkiv/shared';
import { authorize, settle } from './cost-governor';
import { emit, eventsFor } from './events';
import { append } from './ledger';
import { confirmFact, decideFact, recordFacts } from './product-truth';
import { ctxFor, eventContractProblems } from './testing';

beforeEach(truncateAll);
afterAll(closeAll);

describe('event envelope (standard §36: actor, timestamp, tenant, object IDs, schema version)', () => {
  it('registers one subject type for every event type and only known ref keys', () => {
    for (const type of EventType) expect(type in EVENT_SUBJECT, type).toBe(true);
    for (const subject of Object.values(EVENT_SUBJECT)) if (subject && subject !== 'workspace') expect(SUBJECT_REF[subject], subject).toBeTruthy();
    for (const [type, refs] of Object.entries(EVENT_REQUIRED_REFS)) for (const k of refs) expect(EVENT_REF_KEYS, `${type}.${k}`).toContain(k);
  });

  it('rejects a wrong subject type or missing refs, and stores the subject as a ref', async () => {
    const t = await makeTenant();
    const ctx = ctxFor(t.workspaceId, t.userId);
    const skuId = await makeSku(t.workspaceId);
    await expect(withTenant(t.workspaceId, (tx) => emit(tx, ctx, 'VARIANT_GENERATED', { type: 'project', id: skuId }, {}))).rejects.toThrow(/subject must be a variant/);
    await expect(withTenant(t.workspaceId, (tx) => emit(tx, ctx, 'QA_PASSED', { type: 'scene', id: skuId }, {}, { projectId: skuId }))).rejects.toThrow(/missing refs: skuId, storyboardId, providerJobId/);
    await withTenant(t.workspaceId, (tx) => emit(tx, ctx, 'CUSTOMER_THEME_UPDATED', { type: 'sku', id: skuId }, { themes: 0 }, { brandId: null }));
    const [e] = await ownerPool()`select refs, schema_version from events where type = 'CUSTOMER_THEME_UPDATED'`;
    expect(e).toEqual({ refs: { skuId }, schema_version: 2 });
  });

  it('ledger events carry the ledger entry and authorization; fact events carry the fact and its value', async () => {
    const t = await makeTenant({ plan: 'GROWTH', state: 'ACTIVE_PAID' });
    const ctx = ctxFor(t.workspaceId, t.userId, 'OWNER', 'ACTIVE_PAID');
    const skuId = await makeSku(t.workspaceId);
    await withTenant(t.workspaceId, async (tx) => {
      await append(tx, ctx, { type: 'CREDIT_GRANTED', unit: 'taste', amount: 1, idempotencyKey: 'grant:refs' });
      const a = await authorize(tx, ctx, { purpose: 'taste', lines: [{ kind: 'image', provider: 'byteplus', model: 'seedream-5-0-pro', images: 1 }], entitlement: { unit: 'taste', amount: 1 }, idempotencyKey: 'refs:1' });
      await settle(tx, ctx, a.authorizationId, 'consumed');
      await recordFacts(tx, ctx, skuId, [{ key: 'size', valueText: '30 ml', sourceType: 'product_page', state: 'OBSERVED' }]);
      await decideFact(tx, ctx, skuId, 'size', { text: '50 ml' });
    });
    const ledger = await ownerPool()`select e.type, e.refs, l.id as ledger_id, l.authorization_id from events e join ledger_entries l on l.id::text = e.refs->>'ledgerEntryId'
                                     where e.workspace_id = ${t.workspaceId} order by e.seq`;
    expect(ledger.map((r) => r.type)).toEqual(['CREDIT_GRANTED', 'CREDIT_RESERVED', 'CREDIT_CONSUMED']);
    expect(ledger.slice(1).every((r) => (r.refs as { authorizationId: string }).authorizationId === r.authorization_id)).toBe(true);
    const [changed] = await ownerPool()`select payload, refs from events where workspace_id = ${t.workspaceId} and type = 'PRODUCT_FACT_CHANGED'`;
    expect(changed!.payload).toMatchObject({ key: 'size', value: { text: '50 ml', number: null, json: null } });
    expect((changed!.payload as { supersedes: string[] }).supersedes).toHaveLength(1);
    // A projection of the SKU's facts can be rebuilt from its events.
    const history = await withTenant(t.workspaceId, (tx) => eventsFor(tx, { key: 'skuId', id: skuId }));
    expect(history.map((e) => e.type)).toEqual(['PRODUCT_FACT_OBSERVED', 'PRODUCT_FACT_CHANGED']);
    const [observed] = await ownerPool()`select refs->>'factId' as fact from events where type = 'PRODUCT_FACT_OBSERVED'`;
    await withTenant(t.workspaceId, (tx) => confirmFact(tx, ctx, observed!.fact as string));
    const [confirmed] = await ownerPool()`select payload from events where type = 'PRODUCT_FACT_CHANGED' and payload->>'confirmed' = 'true'`;
    expect(confirmed!.payload).toMatchObject({ factId: observed!.fact, value: { text: '30 ml' } });
    expect(await eventContractProblems(t.workspaceId)).toEqual([]);
  });
});
