import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool, withSystem, withTenant } from '@arkiv/db';
import { makeSku, makeTenant, truncateAll } from '@arkiv/db/testing';
import { newId } from '@arkiv/shared';
import { armStats, canaryRegression, evaluateCanaries, type ArmStats } from './canary';
import { authorize } from './cost-governor';
import { effectiveFlag, expiredFlagAlerts, isFlagOn } from './flags';
import { canaryBucket, route, synthesizeVoice } from './model-gateway';
import { ctxFor } from './testing';

/** model_routes and feature_flags are reference data (kept across truncation): restore after each test. */
async function restore() {
  await ownerPool()`update model_routes set canary = null, circuit_open = false`;
  await ownerPool()`delete from feature_flags where key like 'test.%'`;
  await ownerPool()`update feature_flags set enabled = false where key like 'kill.%'`;
}
beforeEach(async () => {
  await truncateAll();
  await restore();
});
afterEach(restore);
afterAll(closeAll);

async function speak(workspaceId: string, userId: string) {
  const ctx = ctxFor(workspaceId, userId);
  const auth = await withTenant(workspaceId, (tx) => authorize(tx, ctx, { purpose: 'taste', lines: [{ kind: 'tts', provider: 'minimax', model: 'speech-2.8-hd', chars: 2000 }], idempotencyKey: `tts:${newId()}` }));
  await synthesizeVoice({ ctx, token: auth.token, task: 'tts.voiceover', subject: null, text: 'Soft, dewy skin in one step.', voice: 'warm_female' });
  const [job] = await ownerPool()`select provider, model, arm from provider_jobs where workspace_id = ${workspaceId} order by created_at desc limit 1`;
  return job!;
}

describe('canary routing (plan 05 §11)', () => {
  it('splits traffic deterministically per workspace and tags each call with its arm', async () => {
    await ownerPool()`update model_routes set canary = ${ownerPool().json({ model: 'speech-2.8-turbo', promptVersion: 'voiceover@1.1.0', pct: 25 })} where task = 'tts.voiceover'`;
    const ids = Array.from({ length: 400 }, () => newId());
    const arms = await withSystem(async (tx) => Promise.all(ids.map(async (id) => (await route(tx, 'tts.voiceover', id)).arm)));
    const share = arms.filter((a) => a === 'canary').length / ids.length;
    expect(share).toBeGreaterThan(0.18);
    expect(share).toBeLessThan(0.32);
    for (const id of ids.slice(0, 20)) {
      const r = await withSystem((tx) => route(tx, 'tts.voiceover', id));
      expect(r.arm === 'canary').toBe(canaryBucket('tts.voiceover', id) < 25);
      if (r.arm === 'canary') expect(r).toMatchObject({ model: 'speech-2.8-turbo', promptVersion: 'voiceover@1.1.0' });
    }
    expect((await withSystem((tx) => route(tx, 'tts.voiceover'))).arm).toBe('stable'); // no workspace → stable
  });

  it('voice-over uses the routed model (canary included), not a hard-coded one', async () => {
    const t = await makeTenant();
    expect(await speak(t.workspaceId, t.userId)).toMatchObject({ provider: 'minimax', model: 'speech-2.8-hd', arm: 'stable' });
    await ownerPool()`update model_routes set canary = ${ownerPool().json({ model: 'speech-2.8-turbo', promptVersion: 'voiceover@1.1.0', pct: 100 })} where task = 'tts.voiceover'`;
    expect(await speak(t.workspaceId, t.userId)).toMatchObject({ provider: 'minimax', model: 'speech-2.8-turbo', arm: 'canary' });
  });

  it('a killed provider is refused; voice-over falls back to the approved provider', async () => {
    const t = await makeTenant();
    await ownerPool()`update feature_flags set enabled = true where key = 'kill.provider.minimax'`;
    expect(await speak(t.workspaceId, t.userId)).toMatchObject({ provider: 'byteplus' });
    await ownerPool()`update feature_flags set enabled = true where key = 'kill.provider.byteplus'`;
    await expect(speak(t.workspaceId, t.userId)).rejects.toMatchObject({ code: 'UNAVAILABLE', details: { killSwitch: 'byteplus' } });
  });

  it('rolls back a canary whose QA first-pass or claim-block rate regresses (audited)', async () => {
    const s = (projects: number, blocked: number, qaFirst: number, qaFirstPassed: number): ArmStats => ({ projects, blocked, qaFirst, qaFirstPassed });
    expect(canaryRegression(s(40, 2, 80, 64), s(30, 1, 40, 30))).toBeNull(); // 75% vs 80%: within tolerance
    expect(canaryRegression(s(40, 2, 80, 64), s(30, 1, 40, 24))).toMatch(/QA first-pass 60\.0% vs 80\.0%/);
    expect(canaryRegression(s(40, 2, 80, 64), s(30, 6, 40, 32))).toMatch(/claim-block rate 20\.0% vs 5\.0%/);
    expect(canaryRegression(s(40, 2, 80, 64), s(5, 5, 5, 0))).toBeNull(); // too little canary data to judge

    const t = await makeTenant();
    const canary = { model: 'dreamina-seedance-2-5', promptVersion: 'scene@2.0.0', pct: 25, startedAt: new Date(Date.now() - 3600_000).toISOString() };
    await ownerPool()`update model_routes set canary = ${ownerPool().json(canary)} where task = 'video.scene'`;
    for (const arm of ['stable', 'canary'] as const) {
      for (let i = 0; i < 25; i++) {
        const pid = newId();
        await ownerPool()`insert into provider_jobs (workspace_id, project_id, provider, task, model, request_hash, status, arm) values (${t.workspaceId}, ${pid}, 'byteplus', 'video.scene', 'm', 'h', 'succeeded', ${arm})`;
        if (arm === 'canary' && i < 8) await ownerPool()`insert into events (workspace_id, type, actor, subject_type, subject_id, payload) values (${t.workspaceId}, 'PROJECT_STATE_CHANGED', 'system:x', 'project', ${pid}, '{"to": "BLOCKED_COMPLIANCE"}')`;
      }
    }
    const rolled = await withSystem((tx) => evaluateCanaries(tx));
    expect(rolled).toEqual([{ task: 'video.scene', why: expect.stringMatching(/claim-block rate 32\.0% vs 0\.0%/) }]);
    const [r] = await ownerPool()`select canary from model_routes where task = 'video.scene'`;
    expect(r!.canary).toBeNull();
    const [a] = await ownerPool()`select staff_id, action, target_id, reason from admin_audit_log where action = 'route.canary_rollback'`;
    expect(a).toMatchObject({ staff_id: null, target_id: 'video.scene' });
    expect(await withSystem((tx) => evaluateCanaries(tx))).toEqual([]); // nothing left to roll back
  });

  it('measures first-attempt scene QA per arm from the projects each arm served', async () => {
    const t = await makeTenant();
    const sku = await makeSku(t.workspaceId);
    const q = ownerPool();
    const mk = async (arm: 'stable' | 'canary', firstPass: boolean) => {
      const pid = newId();
      const sb = newId();
      const scene = newId();
      await q`insert into projects (id, workspace_id, sku_id, kind, state, created_by, storyboard_id) values (${pid}, ${t.workspaceId}, ${sku}, 'taste', 'COMPLETE', 'test', ${sb})`;
      await q`insert into storyboards (id, workspace_id, project_id, concept_id) values (${sb}, ${t.workspaceId}, ${pid}, ${newId()})`;
      await q`insert into scenes (id, workspace_id, storyboard_id, position, purpose, duration_ms, visual_plan, production_mode) values (${scene}, ${t.workspaceId}, ${sb}, 0, 'hook', 4000, 'x', 'GENERATIVE_INTERACTION')`;
      await q`insert into provider_jobs (workspace_id, project_id, provider, task, model, request_hash, status, arm) values (${t.workspaceId}, ${pid}, 'byteplus', 'video.scene', 'm', 'h', 'succeeded', ${arm})`;
      await q`insert into events (workspace_id, type, actor, subject_type, subject_id, payload) values (${t.workspaceId}, ${firstPass ? 'QA_PASSED' : 'QA_FAILED'}, 'system:x', 'scene', ${scene}, '{"attempt": 1}')`;
      if (!firstPass) await q`insert into events (workspace_id, type, actor, subject_type, subject_id, payload) values (${t.workspaceId}, 'QA_PASSED', 'system:x', 'scene', ${scene}, '{"attempt": 2}')`;
    };
    for (let i = 0; i < 20; i++) await mk('stable', i < 18); // 90%
    for (let i = 0; i < 20; i++) await mk('canary', i < 12); // 60%
    const stats = await withSystem((tx) => armStats(tx, 'video.scene', new Date(Date.now() - 3600_000)));
    expect(stats.stable).toMatchObject({ projects: 20, qaFirst: 20, qaFirstPassed: 18 });
    expect(stats.canary).toMatchObject({ projects: 20, qaFirst: 20, qaFirstPassed: 12 });
    expect(canaryRegression(stats.stable, stats.canary)).toMatch(/QA first-pass 60\.0% vs 90\.0%/);
  });
});

describe('feature flags (plan 05 §20)', () => {
  it('plan-based flags follow the workspace plan', async () => {
    await ownerPool()`insert into feature_flags (key, description, owner, kind, enabled, rules) values ('test.plan', 'plan flag', 'growth', 'plan', true, '{"plans": ["GROWTH", "SCALE"]}')`;
    const growth = await makeTenant({ plan: 'GROWTH', state: 'ACTIVE_PAID' });
    const launch = await makeTenant({ plan: 'LAUNCH', state: 'ACTIVE_PAID' });
    const free = await makeTenant();
    expect(await withTenant(growth.workspaceId, (tx) => isFlagOn(tx, 'test.plan', growth.workspaceId))).toBe(true);
    expect(await withTenant(launch.workspaceId, (tx) => isFlagOn(tx, 'test.plan', launch.workspaceId))).toBe(false);
    expect(await withTenant(free.workspaceId, (tx) => isFlagOn(tx, 'test.plan', free.workspaceId))).toBe(false);
    expect(await withSystem((tx) => isFlagOn(tx, 'test.plan'))).toBe(false);
  });

  it('per-environment values override the default', async () => {
    expect(effectiveFlag(false, { env: { staging: true } }, 'staging')).toEqual({ enabled: true, rules: { env: { staging: true } } });
    expect(effectiveFlag(true, { env: { production: false } }, 'production').enabled).toBe(false);
    expect(effectiveFlag(true, { pct: 5, env: { staging: { pct: 100 } } }, 'staging').rules.pct).toBe(100);
    expect(effectiveFlag(true, { pct: 5, env: { staging: { pct: 100 } } }, 'production').rules.pct).toBe(5);
    // Tests run with APP_ENV unset → the "test" environment.
    await ownerPool()`insert into feature_flags (key, description, owner, kind, enabled, rules) values ('test.env', 'env flag', 'eng', 'boolean', false, '{"env": {"test": true}}')`;
    expect(await withSystem((tx) => isFlagOn(tx, 'test.env'))).toBe(true);
  });

  it('expired flags alert their owner (email, staff name or role; SUPER_ADMIN fallback)', async () => {
    const sa = newId();
    const growth = newId();
    await ownerPool()`insert into staff_users (id, email, name, password_hash, roles) values (${sa}, 'founder@arkiv.test', 'Founder', 'x', '{SUPER_ADMIN}'), (${growth}, 'growth@arkiv.test', 'Gia', 'x', '{GROWTH}')`;
    await ownerPool()`insert into feature_flags (key, description, owner, kind, expires_at) values
      ('test.a', 'a', 'pm@arkiv.test', 'boolean', now() - interval '1 day'),
      ('test.b', 'b', 'growth', 'boolean', now() - interval '2 days'),
      ('test.c', 'c', 'nobody', 'boolean', now() - interval '3 days'),
      ('test.d', 'd', 'growth', 'boolean', now() + interval '3 days')`;
    const alerts = await withSystem((tx) => expiredFlagAlerts(tx));
    expect(alerts.filter((a) => a.key.startsWith('test.')).map((a) => [a.key, a.to])).toEqual([
      ['test.c', ['founder@arkiv.test']],
      ['test.b', ['growth@arkiv.test']],
      ['test.a', ['pm@arkiv.test']],
    ]);
  });
});
