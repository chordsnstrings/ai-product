import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { closeAll, ownerPool, withSystem, withTenant } from '@arkiv/db';
import { makeSku, makeTenant, truncateAll } from '@arkiv/db/testing';
import { newId } from '@arkiv/shared';
import { acceptanceFalling, buildExport, duePurgeNotices, purgeWorkspace, PURGE_RETAINED, refreshRiskFlags, sweepProvisional, sweepRetention, toCsv } from './lifecycle';
import { storage } from './storage';
import { ctxFor } from './testing';

beforeEach(truncateAll);
afterAll(closeAll);

const openFlags = async (ws: string) => (await ownerPool()`select indicator from risk_flags where workspace_id = ${ws} and resolved_at is null order by indicator`).map((r) => r.indicator as string);

describe('churn indicators are per workspace (standard §10)', () => {
  it('computes and resolves each tenant’s flags from its own data only', async () => {
    const a = await makeTenant({ state: 'ACTIVE_PAID', plan: 'GROWTH' });
    const b = await makeTenant({ state: 'ACTIVE_PAID', plan: 'GROWTH' });
    for (let i = 0; i < 3; i++) await ownerPool()`insert into events (workspace_id, type, actor, payload) values (${a.workspaceId}, 'QA_FAILED', 'system:qa', '{}')`;
    await withSystem((tx) => refreshRiskFlags(tx, a.workspaceId));
    await withSystem((tx) => refreshRiskFlags(tx, b.workspaceId));
    expect(await openFlags(a.workspaceId)).toContain('repeated_qa_rejects');
    expect(await openFlags(b.workspaceId)).not.toContain('repeated_qa_rejects');
    // Refreshing B (which has nothing) never resolves A's flag.
    await withSystem((tx) => refreshRiskFlags(tx, b.workspaceId));
    expect(await openFlags(a.workspaceId)).toContain('repeated_qa_rejects');
  });

  it('three ignored cycles: a week where one recommendation was accepted is not ignored', async () => {
    const t = await makeTenant({ state: 'ACTIVE_PAID', plan: 'GROWTH' });
    const sku = await makeSku(t.workspaceId);
    const monday = (weeksAgo: number) => {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) - weeksAgo * 7);
      return d.toISOString().slice(0, 10);
    };
    const rec = (week: string, status: string) => ownerPool()`insert into recommendations (workspace_id, sku_id, week_of, slot, proposal, score, score_breakdown, basis, status) values (${t.workspaceId}, ${sku}, ${week}, 'EXPLOIT', '{}', 0.5, '{}', 'cold_start', ${status})`;
    for (const w of [1, 2, 3]) {
      await rec(monday(w), 'open');
      await rec(monday(w), 'open');
    }
    await rec(monday(2), 'accepted');
    await withSystem((tx) => refreshRiskFlags(tx, t.workspaceId));
    expect(await openFlags(t.workspaceId)).not.toContain('ignored_recommendations');
    await ownerPool()`update recommendations set status = 'dismissed' where status = 'accepted' and workspace_id = ${t.workspaceId}`;
    await withSystem((tx) => refreshRiskFlags(tx, t.workspaceId));
    expect(await openFlags(t.workspaceId)).toContain('ignored_recommendations');
  });

  it('falling acceptance compares the recent four weeks with the four before', () => {
    expect(acceptanceFalling({ accepted: 4, decided: 5 }, { accepted: 1, decided: 5 })).toEqual({ from: 0.8, to: 0.2, decided: 5 });
    expect(acceptanceFalling({ accepted: 4, decided: 5 }, { accepted: 4, decided: 6 })).toBeNull();
    expect(acceptanceFalling({ accepted: 3, decided: 3 }, { accepted: 0, decided: 5 })).toBeNull(); // too few to compare
  });

  it('performance-linked means results arrived for a test variant in 30 days', async () => {
    const t = await makeTenant({ state: 'ACTIVE_PAID', plan: 'GROWTH' });
    await ownerPool()`insert into subscriptions (workspace_id, stripe_subscription_id, plan_code, status, consent_record_id, created_at, current_period_start)
                      values (${t.workspaceId}, 'sub_old', 'GROWTH', 'active', gen_random_uuid(), now() - interval '60 days', now() - interval '5 days')`;
    const sku = await makeSku(t.workspaceId);
    const exp = newId();
    await ownerPool()`insert into experiments (id, workspace_id, sku_id, hypothesis, primary_variable, mode, created_by, state) values (${exp}, ${t.workspaceId}, ${sku}, 'h', 'hook', 'CONTROLLED', 'test', 'GATHERING_SIGNAL')`;
    await withSystem((tx) => refreshRiskFlags(tx, t.workspaceId));
    // An experiment in a signal state with no results linked still counts as not performance-linked.
    expect(await openFlags(t.workspaceId)).toContain('no_performance_linked_test');
    const v = newId();
    await ownerPool()`insert into variants (id, workspace_id, experiment_id, label, code, role) values (${v}, ${t.workspaceId}, ${exp}, 'A', 'AK-001-A', 'control')`;
    await ownerPool()`insert into performance_observations (workspace_id, platform, account_id, ad_id, date, currency, measurement_context, variant_id)
                      values (${t.workspaceId}, 'meta', 'act_1', 'ad_1', current_date - 2, 'USD', 'META_PAID_ATTRIBUTED', ${v})`;
    await withSystem((tx) => refreshRiskFlags(tx, t.workspaceId));
    expect(await openFlags(t.workspaceId)).not.toContain('no_performance_linked_test');
  });

  it('a newly raised flag routes to its playbook once (email + in-app notice), never a discount', async () => {
    const t = await makeTenant({ state: 'ACTIVE_PAID', plan: 'GROWTH' });
    const sku = await makeSku(t.workspaceId);
    await ownerPool()`update skus set status = 'out_of_stock' where id = ${sku}`;
    await withSystem((tx) => refreshRiskFlags(tx, t.workspaceId));
    const mails = await ownerPool()`select payload from outbox where workspace_id = ${t.workspaceId} and payload->>'template' = 'intervention'`;
    expect(mails.map((m) => (m.payload as { indicator: string }).indicator)).toEqual(['stockout']);
    const notices = await ownerPool()`select source, created_by from workspace_notices where workspace_id = ${t.workspaceId}`;
    expect(notices).toEqual([{ source: 'risk:stockout', created_by: 'system:risk-flags' }]);
    const [f] = await ownerPool()`select interventions from risk_flags where workspace_id = ${t.workspaceId}`;
    expect(f!.interventions).toEqual([expect.objectContaining({ by: 'system', emailed: true, notice: true })]);
    // Resolved, then raised again within 30 days: no second automatic email.
    await ownerPool()`update skus set status = 'active' where id = ${sku}`;
    await withSystem((tx) => refreshRiskFlags(tx, t.workspaceId));
    await ownerPool()`update skus set status = 'out_of_stock' where id = ${sku}`;
    await withSystem((tx) => refreshRiskFlags(tx, t.workspaceId));
    expect(await ownerPool()`select 1 from outbox where workspace_id = ${t.workspaceId} and payload->>'template' = 'intervention'`).toHaveLength(1);
  });
});

describe('lifecycle transitions are evented (plan 02 §2)', () => {
  it('the provisional and retention sweeps emit WORKSPACE_STATE_CHANGED with actor and reason', async () => {
    const prov = await makeTenant({ state: 'PROVISIONAL' });
    await ownerPool()`update workspaces set provisional_expires_at = now() - interval '1 minute' where id = ${prov.workspaceId}`;
    const cancelled = await makeTenant({ state: 'CANCELLED' });
    await ownerPool()`update workspaces set cancelled_at = now() - interval '400 days' where id = ${cancelled.workspaceId}`;
    expect(await withSystem((tx) => sweepProvisional(tx))).toEqual([prov.workspaceId]);
    expect(await withSystem((tx) => sweepRetention(tx))).toBe(1);
    const ev = await ownerPool()`select workspace_id, actor, payload from events where type = 'WORKSPACE_STATE_CHANGED' order by at`;
    expect(ev).toEqual([
      { workspace_id: prov.workspaceId, actor: 'system:sweep', payload: { from: 'PROVISIONAL', to: 'PURGE_SCHEDULED', reason: 'unclaimed preview expired' } },
      { workspace_id: cancelled.workspaceId, actor: 'system:sweep', payload: expect.objectContaining({ from: 'CANCELLED', to: 'PURGE_SCHEDULED' }) },
    ]);
    const [w] = await ownerPool()`select purge_at > now() + interval '6 days' as later from workspaces where id = ${cancelled.workspaceId}`;
    expect(w!.later).toBe(true);
  });
});

describe('purge notices (plan 02 §2: T-14d and T-1d)', () => {
  it('names the retention T-14 notice, the scheduled notice and the final day', async () => {
    const soon = await makeTenant({ state: 'CANCELLED' });
    // Archive 90 days + grace 7: T-14 falls 83 days after cancelling.
    await ownerPool()`update workspaces set cancelled_at = now() - interval '84 days' where id = ${soon.workspaceId}`;
    const recent = await makeTenant({ state: 'CANCELLED' });
    await ownerPool()`update workspaces set cancelled_at = now() - interval '10 days' where id = ${recent.workspaceId}`;
    const sched = await makeTenant({ state: 'ACTIVE_FREE' });
    await ownerPool()`update workspaces set state = 'PURGE_SCHEDULED', state_before_purge = 'ACTIVE_FREE', purge_at = now() + interval '5 days' where id = ${sched.workspaceId}`;
    const last = await makeTenant({ state: 'ACTIVE_FREE' });
    await ownerPool()`update workspaces set state = 'PURGE_SCHEDULED', state_before_purge = 'ACTIVE_FREE', purge_at = now() + interval '10 hours' where id = ${last.workspaceId}`;
    const orphan = await makeTenant({ state: 'PROVISIONAL' });
    await ownerPool()`update workspaces set state = 'PURGE_SCHEDULED', state_before_purge = 'PROVISIONAL', purge_at = now() + interval '5 days' where id = ${orphan.workspaceId}`;
    const due = await withSystem((tx) => duePurgeNotices(tx));
    const by = (ws: string) => due.filter((n) => n.workspaceId === ws).map((n) => n.stage);
    expect(by(soon.workspaceId)).toEqual(['retention_ending']);
    expect(by(recent.workspaceId)).toEqual([]);
    expect(by(sched.workspaceId)).toEqual(['scheduled']);
    expect(by(last.workspaceId)).toEqual(['final']);
    expect(by(orphan.workspaceId)).toEqual([]);
  });
});

describe('purge keeps records without personal data (plan 02 §7 step 4)', () => {
  it('anonymizes kept rows, deletes the rest, and leaves nothing outside the retained list', async () => {
    const t = await makeTenant({ email: 'founder@glow.example' });
    const ws = t.workspaceId;
    const actor = `user:${t.userId}`;
    await ownerPool()`insert into events (workspace_id, type, actor, payload) values (${ws}, 'SKU_CREATED', ${actor}, ${ownerPool().json({ email: 'founder@glow.example', note: 'call founder@glow.example', skuName: 'Dew' })})`;
    await ownerPool()`insert into ledger_entries (workspace_id, type, unit, amount, actor, idempotency_key) values (${ws}, 'CREDIT_GRANTED', 'taste', 1, ${actor}, 'k1')`;
    await ownerPool()`insert into consent_records (workspace_id, user_id, kind, text_version, text_snapshot, ip, user_agent) values (${ws}, ${t.userId}, 'terms', 'v1', 'I agree', '203.0.113.9', 'Mozilla/5.0')`;
    await ownerPool()`insert into purchases (workspace_id, kind, amount_micros, created_by, status) values (${ws}, 'taste', 19000000, ${actor}, 'paid')`;
    await ownerPool()`insert into stripe_events (id, type, payload, workspace_id) values ('evt_p', 'checkout.session.completed', ${ownerPool().json({ data: { object: { customer_details: { email: 'founder@glow.example', name: 'Ana Founder', address: { line1: '1 Main St' } }, amount_total: 1900 } } })}, ${ws})`;
    await ownerPool()`insert into email_log (workspace_id, to_email, template, stream, idempotency_key, status, data) values (${ws}, 'founder@glow.example', 'receipt', 'transactional', 'e1', 'sent', '{"productName":"Dew"}')`;
    await ownerPool()`insert into funnel_events (type, visitor_id, workspace_id, props) values ('TASTE_PAID', 'v-123', ${ws}, '{"ip":"203.0.113.9"}')`;
    await withTenant(ws, (tx) => tx`update workspaces set state = 'PURGE_SCHEDULED', purge_at = now() - interval '1 minute' where id = ${ws}`);
    const counts = await purgeWorkspace(ws);
    expect(counts.events_anonymized).toBeGreaterThanOrEqual(1);

    const dump = JSON.stringify([
      await ownerPool()`select actor, payload from events where workspace_id = ${ws}`,
      await ownerPool()`select actor from ledger_entries where workspace_id = ${ws}`,
      await ownerPool()`select user_id, ip, user_agent from consent_records where workspace_id = ${ws}`,
      await ownerPool()`select created_by from purchases where workspace_id = ${ws}`,
      await ownerPool()`select payload from stripe_events where workspace_id = ${ws}`,
      await ownerPool()`select to_email, data from email_log where workspace_id = ${ws}`,
      await ownerPool()`select visitor_id, props from funnel_events where workspace_id = ${ws}`,
    ]);
    expect(dump).not.toContain(t.userId);
    expect(dump).not.toContain('founder@glow.example');
    expect(dump).not.toContain('Ana Founder');
    expect(dump).not.toContain('203.0.113.9');
    expect(dump).not.toContain('v-123');
    // Payments are kept (the Data page's promise): the purchase and its amount survive.
    expect(await ownerPool()`select amount_micros from purchases where workspace_id = ${ws}`).toEqual([{ amount_micros: 19000000 }]);
    // The purge itself is a recorded transition.
    expect(await ownerPool()`select payload from events where workspace_id = ${ws} and type = 'WORKSPACE_STATE_CHANGED'`).toEqual([{ payload: { from: 'PURGE_SCHEDULED', to: 'PURGED', reason: 'purge job' } }]);

    const tables = await ownerPool()`select c.table_name from information_schema.columns c join pg_class k on k.relname = c.table_name and k.relkind = 'r'
                                     where c.table_schema = 'public' and c.column_name = 'workspace_id'`;
    const left: string[] = [];
    for (const r of tables) {
      const [n] = await ownerPool().unsafe(`select count(*)::int as n from ${r.table_name as string} where workspace_id = $1`, [ws]);
      if (n!.n > 0 && r.table_name !== 'workspaces' && !(PURGE_RETAINED as readonly string[]).includes(r.table_name as string)) left.push(r.table_name as string);
    }
    expect(left).toEqual([]);
  });
});

describe('workspace export (plan 02 §7)', () => {
  it('writes JSON and CSV, includes every asset kind, and never embeds an earlier export', async () => {
    const t = await makeTenant({ state: 'ACTIVE_PAID' });
    const ctx = ctxFor(t.workspaceId, t.userId, 'OWNER', 'ACTIVE_PAID');
    const sku = await makeSku(t.workspaceId, 'Dew Serum');
    const key = `t/${t.workspaceId}/${sku}/scene_render/${newId()}.mp4`;
    await storage().put(key, Buffer.from('mp4-bytes'), 'video/mp4');
    await ownerPool()`insert into assets (workspace_id, sku_id, kind, storage_key, mime, bytes, checksum_sha256, source) values (${t.workspaceId}, ${sku}, 'scene_render', ${key}, 'video/mp4', 9, 'x', 'composed')`;
    const first = await buildExport(ctx);
    const second = await buildExport(ctx);
    const [a] = await ownerPool()`select kind, storage_key from assets where id = ${second.assetId}`;
    expect(a!.kind).toBe('export_archive');
    const files = Object.keys(unzipSync(new Uint8Array(await storage().get(a!.storage_key as string))));
    expect(files.some((f) => f.endsWith('.zip'))).toBe(false);
    expect(files.some((f) => f.startsWith('assets/scene_render/'))).toBe(true);
    expect(files).toContain('data/skus.csv');
    expect(first.assetId).not.toBe(second.assetId);
    const csv = strFromU8(unzipSync(new Uint8Array(await storage().get(a!.storage_key as string)))['data/skus.csv']!);
    expect(csv.split('\r\n')[0]).toContain('name');
    expect(csv).toContain('Dew Serum');
  });

  it('CSV quotes delimiters and encodes nested values as JSON', () => {
    expect(toCsv([{ a: 'x,y', b: { k: 1 }, c: null }, { a: 'say "hi"', d: 2 }])).toBe('a,b,c,d\r\n"x,y","{""k"":1}",,\r\n"say ""hi""",,,2\r\n');
  });
});
