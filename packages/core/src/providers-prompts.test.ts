import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { closeAll, ownerPool, withSystem, withTenant } from '@arkiv/db';
import { makeTenant, truncateAll } from '@arkiv/db/testing';
import { MockImage, MockLlm, MockTts, MockVideo, setProviders, type LlmJsonRequest, type LlmJsonResult } from '@arkiv/providers';
import { newId } from '@arkiv/shared';
import { circuitTrips, evaluateCircuits, CIRCUIT_BREAKER } from './circuits';
import { authorize } from './cost-governor';
import { llmJson, routedLines, routedPrompt, versionDrift } from './model-gateway';
import { findPrompt, latestPrompt, parsePromptRef, PROMPT_HASHES, PROMPT_TEMPLATES, promptRef } from './prompts';
import PROMPT_LOCK from './prompts.lock.json';
import { clearSettingsCache } from './settings';
import { ctxFor } from './testing';

/** Plan 05 §10–§11: automatic circuit breaker, version drift alerts, and the prompt registry the gateway routes by. */
async function restore() {
  await ownerPool()`update model_routes set canary = null, circuit_open = false, circuit_until = null, circuit_auto = false, circuit_reason = null,
                      circuit_changed_at = null, pinned_model_version = null`;
  await ownerPool()`update model_routes set prompt_version = 'fidelity@1.1.0' where task = 'qa.fidelity'`;
  await ownerPool()`delete from platform_settings where key like 'circuit.%'`;
  clearSettingsCache();
}
beforeEach(async () => {
  await truncateAll();
  await restore();
});
afterEach(async () => {
  setProviders(undefined);
  await restore();
});
afterAll(closeAll);

class RecordingLlm extends MockLlm {
  systems: string[] = [];
  version: string | null = null;
  override async json<T>(req: LlmJsonRequest<T>): Promise<LlmJsonResult<T>> {
    this.systems.push(req.system);
    const r = await super.json(req);
    return this.version ? { ...r, modelVersion: this.version } : r;
  }
}
const install = (llm: MockLlm) => setProviders({ llm, image: new MockImage(), video: new MockVideo(), tts: new MockTts('minimax'), ttsFallback: new MockTts('byteplus-speech'), wireModel: (m) => m });

async function tokenFor(workspaceId: string, userId: string) {
  const ctx = ctxFor(workspaceId, userId);
  const lines = await withTenant(workspaceId, (tx) => routedLines(tx, workspaceId, [{ task: 'qa.fidelity', kind: 'llm', inputTokens: 40_000, outputTokens: 8_000 }]));
  const a = await withTenant(workspaceId, (tx) => authorize(tx, ctx, { purpose: 'creative_test', lines, idempotencyKey: `pp:${newId()}` }));
  return { ctx, token: a.token };
}
const inspect = (ctx: ReturnType<typeof ctxFor>, token: string, text = 'Same product?') =>
  llmJson({ ctx, token, task: 'qa.fidelity', template: 'fidelity', content: [{ type: 'text', text }], schema: z.object({ ok: z.boolean() }), mock: () => ({ ok: true }), maxTokens: 300 });

/** Finished provider jobs on a route, `failed` of them outage-class. */
async function jobs(workspaceId: string, task: string, provider: string, ok: number, failed: number, kind = 'server') {
  for (let i = 0; i < ok + failed; i++) {
    const bad = i < failed;
    await ownerPool()`insert into provider_jobs (workspace_id, provider, task, model, request_hash, status, completed_at, raw_meta)
                      values (${workspaceId}, ${provider}, ${task}, 'm', ${newId()}, ${bad ? 'failed' : 'succeeded'}, now() - interval '1 minute', ${ownerPool().json(bad ? { errorKind: kind } : {})})`;
  }
}

describe('automatic circuit breaker (plan 05 §10)', () => {
  it('trips only on enough calls at the error-rate threshold', () => {
    expect(circuitTrips({ calls: CIRCUIT_BREAKER.minCalls - 1, failed: CIRCUIT_BREAKER.minCalls - 1 })).toBe(false);
    expect(circuitTrips({ calls: 10, failed: 5 })).toBe(true);
    expect(circuitTrips({ calls: 10, failed: 4 })).toBe(false);
  });

  it('opens a route whose outage-class errors cross the threshold, audits it, alerts, and trial-closes after the cool-down', async () => {
    const t = await makeTenant();
    await jobs(t.workspaceId, 'video.scene', 'byteplus', 4, 8);
    // Content refusals are not an outage: a route failing on moderation stays closed.
    await jobs(t.workspaceId, 'qa.fidelity', 'anthropic', 2, 10, 'moderation');
    const changed = await withSystem((tx) => evaluateCircuits(tx));
    expect(changed).toEqual(expect.arrayContaining([expect.objectContaining({ task: 'video.scene', action: 'opened' })]));
    expect(changed.find((c) => c.task === 'qa.fidelity')).toBeUndefined();
    const [r] = await ownerPool()`select circuit_open, circuit_auto, circuit_reason, circuit_until > now() as later from model_routes where task = 'video.scene'`;
    expect(r).toMatchObject({ circuit_open: true, circuit_auto: true, later: true });
    expect(r!.circuit_reason).toMatch(/67% of 12 calls/);
    expect(await ownerPool()`select 1 from admin_audit_log where action = 'route.circuit_auto_open' and target_id = 'video.scene' and staff_id is null`).toHaveLength(1);
    expect(await ownerPool()`select severity from platform_alerts where kind = 'circuit_auto_open' and subject_id = 'video.scene' and resolved_at is null`).toEqual([{ severity: 'risk' }]);
    // One failing route doesn't take down the provider's other services...
    expect(changed.map((c) => c.task)).toEqual(['video.scene']);

    // Cool-down passed: a trial close; the failures from before it don't re-open the route.
    await ownerPool()`update model_routes set circuit_until = now() - interval '1 second' where circuit_auto`;
    const again = await withSystem((tx) => evaluateCircuits(tx));
    expect(again.filter((c) => c.action === 'closed').map((c) => c.task)).toContain('video.scene');
    expect(again.filter((c) => c.action === 'opened')).toEqual([]);
    const [closed] = await ownerPool()`select circuit_open, circuit_auto from model_routes where task = 'video.scene'`;
    expect(closed).toEqual({ circuit_open: false, circuit_auto: false });
  });

  it('opens every route of a provider that is failing across its routes', async () => {
    const t = await makeTenant();
    // Neither route has enough calls on its own; together the provider is clearly down.
    await jobs(t.workspaceId, 'video.scene', 'byteplus', 1, 5);
    await jobs(t.workspaceId, 'image.storyboard_frame', 'byteplus', 1, 4);
    const changed = await withSystem((tx) => evaluateCircuits(tx));
    const opened = changed.map((c) => c.task);
    expect(opened).toEqual(expect.arrayContaining(['video.scene', 'image.storyboard_frame', 'image.environment_plate']));
    expect(opened).not.toContain('qa.fidelity'); // another provider
    expect(changed[0]!.why).toMatch(/byteplus error rate 82% of 11 calls across its routes/);
  });

  it('never closes a circuit staff opened, and honours tuned thresholds', async () => {
    const t = await makeTenant();
    await ownerPool()`update model_routes set circuit_open = true, circuit_auto = false, circuit_until = now() - interval '1 minute' where task = 'tts.voiceover'`;
    await ownerPool()`insert into platform_settings (key, value) values ('circuit.min_calls', '50') on conflict (key) do update set value = excluded.value`;
    clearSettingsCache();
    await jobs(t.workspaceId, 'video.scene', 'byteplus', 0, 20);
    expect(await withSystem((tx) => evaluateCircuits(tx))).toEqual([]);
    const [r] = await ownerPool()`select circuit_open from model_routes where task = 'tts.voiceover'`;
    expect(r!.circuit_open).toBe(true);
  });

  it('the gateway keeps the failure class on the job, which is what the breaker counts', async () => {
    install(new MockLlm());
    const t = await makeTenant();
    const { ctx, token } = await tokenFor(t.workspaceId, t.userId);
    await expect(inspect(ctx, token, 'x [[fail:server]]')).rejects.toMatchObject({ kind: 'server' });
    const [j] = await ownerPool()`select status, raw_meta->>'errorKind' as kind from provider_jobs where workspace_id = ${t.workspaceId}`;
    expect(j).toEqual({ status: 'failed', kind: 'server' });
  });
});

describe('version drift (plan 05 §10, standard §48)', () => {
  it('compares against the pinned version only (mock adapters echo it tagged -mock)', () => {
    expect(versionDrift(null, 'anything')).toBe(false);
    expect(versionDrift('m-2026', 'm-2026')).toBe(false);
    expect(versionDrift('m-2026', 'm-2026-mock')).toBe(false);
    expect(versionDrift('m-2026', 'm-2027')).toBe(true);
  });

  it('raises one Pulse alert per route when a pinned route answers with another version', async () => {
    const llm = new RecordingLlm();
    install(llm);
    const t = await makeTenant();
    await ownerPool()`update model_routes set pinned_model_version = 'claude-pinned-1' where task = 'qa.fidelity'`;
    const { ctx, token } = await tokenFor(t.workspaceId, t.userId);
    await inspect(ctx, token);
    expect(await ownerPool()`select 1 from platform_alerts where kind = 'version_drift'`).toHaveLength(0);
    llm.version = 'claude-pinned-2';
    await inspect(ctx, token);
    await inspect(ctx, token);
    const alerts = await ownerPool()`select subject_type, subject_id, details from platform_alerts where kind = 'version_drift' and resolved_at is null`;
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ subject_type: 'route', subject_id: 'qa.fidelity', details: { pinned: 'claude-pinned-1', returned: 'claude-pinned-2' } });
  });
});

describe('prompt registry (plan 05 §11)', () => {
  it('registers a template for every LLM route’s live prompt version, with semver metadata', async () => {
    for (const t of PROMPT_TEMPLATES) {
      expect(parsePromptRef(promptRef(t)), promptRef(t)).not.toBeNull();
      expect(t.changelog.length && t.author.length && t.outputSchema.length).toBeTruthy();
    }
    expect(new Set(PROMPT_TEMPLATES.map(promptRef)).size).toBe(PROMPT_TEMPLATES.length);
    const llmRoutes = await ownerPool()`select task, prompt_version from model_routes where provider = 'anthropic' and task <> 'vision.fingerprint' and task <> 'extract.claims'`;
    for (const r of llmRoutes) expect(findPrompt(r.prompt_version as string), `${r.task} → ${r.prompt_version}`).toBeDefined();
    expect(latestPrompt('concepts').version).toBe('1.2.0');
  });

  it('sends the text of the route’s prompt version, so a rollback really changes what the model reads', async () => {
    const llm = new RecordingLlm();
    install(llm);
    const t = await makeTenant();
    const { ctx, token } = await tokenFor(t.workspaceId, t.userId);
    await inspect(ctx, token);
    await ownerPool()`update model_routes set prompt_version = 'fidelity@1.0.0' where task = 'qa.fidelity'`;
    const r = await inspect(ctx, token);
    expect(llm.systems[0]).toBe(findPrompt('fidelity@1.1.0')!.text);
    expect(llm.systems[1]).toBe(findPrompt('fidelity@1.0.0')!.text);
    expect(r.promptVersion).toBe('fidelity@1.0.0');
  });

  it('refuses a route pointing at an unregistered version, before anything is debited', async () => {
    install(new MockLlm());
    const t = await makeTenant();
    const { ctx, token } = await tokenFor(t.workspaceId, t.userId);
    await ownerPool()`update model_routes set prompt_version = 'fidelity@9.9.9' where task = 'qa.fidelity'`;
    await expect(inspect(ctx, token)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(await ownerPool()`select 1 from provider_jobs where workspace_id = ${t.workspaceId}`).toHaveLength(0);
    expect(() => routedPrompt({ task: 'qa.fidelity', promptVersion: 'concepts@1.1.0' }, 'fidelity')).toThrow();
  });
});

describe('prompt versions name exactly one text (standard §41)', () => {
  it('pins every registered version’s content hash: editing a version’s text needs a new version', () => {
    // A mismatch here means a registered template's text changed. Add a new version (and route to it through an
    // eval) instead of editing the old one; add the new version's hash to prompts.lock.json.
    expect(PROMPT_HASHES).toEqual(PROMPT_LOCK);
  });

  it('routes only to registered, pinned versions', async () => {
    const routes = await ownerPool()`select task, prompt_version from model_routes where task like any (array['extract.%', 'creative_director.%', 'genome.%', 'customer_language.%', 'qa.%'])`;
    expect(routes.length).toBeGreaterThan(0);
    for (const r of routes) expect(PROMPT_HASHES[r.prompt_version as string], r.task as string).toBeDefined();
  });
});
