import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool, withAdmin, withSystem } from '@arkiv/db';
import { makeTenant, truncateAll } from '@arkiv/db/testing';
import { newId, type StaffRole } from '@arkiv/shared';
import { startBreakGlass, type Staff } from './admin';
import { addGoldenCase, assertCandidatePrompt, DATASETS, evalDatasetFor, EVAL_WORKSPACE_SLUG, GOLDEN, loadCases, retireGoldenCase, runDeterministicEval, runModelEval } from './evals';

/** Plan 05 §11 golden datasets and eval runs (standard §51). */
beforeEach(truncateAll);
afterEach(async () => {
  await ownerPool()`delete from golden_cases`;
});
afterAll(closeAll);

async function staff(roles: StaffRole[]): Promise<Staff> {
  const id = newId();
  await ownerPool()`insert into staff_users (id, email, name, password_hash, roles) values (${id}, ${`${id.slice(-6)}@arkiv.test`}, ${roles.join('+')}, 'x', ${roles})`;
  return { staffId: id, email: `${id.slice(-6)}@arkiv.test`, name: roles.join('+'), roles };
}

describe('seed datasets', () => {
  it('cover packaging types, claims, deceptive review language and confounded performance, and the rules engines pass them', () => {
    expect(Object.keys(DATASETS)).toEqual(expect.arrayContaining(['compliance.classify', 'compliance.scan', 'reviews.deceptive', 'performance.confounded', 'extract.packaging']));
    for (const [name, info] of Object.entries(DATASETS)) {
      expect(GOLDEN[name]?.length, name).toBeGreaterThan(3);
      if (info.kind !== 'rules') continue;
      const r = runDeterministicEval(name);
      expect(r.results.filter((c) => !c.ok), name).toEqual([]);
      expect(r).toMatchObject({ passed: true, costMicros: 0 });
      expect(r.latencyP50Ms).not.toBeNull();
    }
  });

  it('gates model-backed routes with their model dataset and creative routes with the scan', () => {
    expect(evalDatasetFor('extract.product_facts')).toBe('extract.packaging');
    expect(evalDatasetFor('creative_director.storyboard')).toBe('compliance.scan');
    expect(evalDatasetFor('video.scene')).toBeNull();
    // The whole-creative implied-claim scan is gated by its own golden set (§43).
    expect(evalDatasetFor('qa.implied_claims')).toBe('implied.creative');
  });

  it('only lets a route move to a registered version of its own template', () => {
    expect(() => assertCandidatePrompt('storyboard@1.1.0', 'storyboard@1.0.0')).not.toThrow();
    expect(() => assertCandidatePrompt('storyboard@1.1.0', 'storyboard@9.9.9')).toThrow(/registered version/);
    expect(() => assertCandidatePrompt('storyboard@1.1.0', 'concepts@1.1.0')).toThrow(/registered version/);
    expect(() => assertCandidatePrompt('scene@1.0.0', 'scene@2.0.0')).not.toThrow(); // built in code: no template to check
  });
});

describe('model eval runs (template × model × dataset)', () => {
  it('runs every case through the gateway in the internal evals workspace, with per-case latency and cost', async () => {
    const runId = newId();
    const r = await runModelEval({ evalRunId: runId, dataset: 'extract.packaging', task: 'extract.product_facts', model: 'claude-opus-5-5', promptVersion: 'extract-product@1.1.0', cases: GOLDEN['extract.packaging']! });
    expect(r.results.filter((c) => !c.ok)).toEqual([]);
    expect(r.passed).toBe(true);
    expect(r.costMicros).toBeGreaterThan(0);
    for (const c of r.results) {
      expect(c.costMicros).toBeGreaterThan(0);
      expect(c.latencyMs).toBeGreaterThanOrEqual(0);
    }
    const [ws] = await ownerPool()`select id, is_test from workspaces where slug = ${EVAL_WORKSPACE_SLUG}`;
    expect(ws!.is_test).toBe(true);
    const calls = await ownerPool()`select task, model, prompt_version, status from provider_jobs where workspace_id = ${ws!.id}`;
    expect(calls).toHaveLength(r.cases);
    expect(calls.every((c) => c.prompt_version === 'extract-product@1.1.0' && c.status === 'succeeded')).toBe(true);
    const [auth] = await ownerPool()`select purpose, status from cost_authorizations where workspace_id = ${ws!.id} and idempotency_key = ${`eval:${runId}`}`;
    expect(auth).toEqual({ purpose: 'eval', status: 'settled' });
    // An older template version is evaluated as itself.
    const old = await runModelEval({ evalRunId: newId(), dataset: 'extract.packaging', task: 'extract.product_facts', model: 'claude-opus-5-5', promptVersion: 'extract-product@1.0.0', cases: GOLDEN['extract.packaging']!.slice(0, 1) });
    expect(old.cases).toBe(1);
    expect(await ownerPool()`select 1 from provider_jobs where workspace_id = ${ws!.id} and prompt_version = 'extract-product@1.0.0'`).toHaveLength(1);
  });

  it('refuses a candidate version that isn’t the dataset’s template', async () => {
    await expect(runModelEval({ evalRunId: newId(), dataset: 'extract.packaging', task: 'extract.product_facts', model: 'claude-opus-5-5', promptVersion: 'concepts@1.1.0', cases: [] })).rejects.toThrow(/registered/);
  });
});

describe('extending golden datasets (§11 consent rules)', () => {
  it('adds synthetic cases; production cases need consent and break-glass; retired cases drop out', async () => {
    const eng = await staff(['ENGINEERING']);
    const comp = await staff(['COMPLIANCE']);
    const t = await makeTenant();
    const synthetic = await withAdmin((tx) => addGoldenCase(tx, eng, { dataset: 'compliance.scan', input: 'Reverses sun damage overnight.', expected: 'block', source: 'synthetic' }));
    await expect(withAdmin((tx) => addGoldenCase(tx, eng, { dataset: 'compliance.scan', input: 'x', expected: 'maybe', source: 'synthetic' }))).rejects.toThrow(/one of/);
    await expect(withAdmin((tx) => addGoldenCase(tx, eng, { dataset: 'performance.confounded', input: 'not json', expected: 'ACTIONABLE', source: 'synthetic' }))).rejects.toThrow(/JSON/);
    const prod = { dataset: 'compliance.scan', input: 'Your pores, gone for good.', expected: 'block', source: 'production' as const, workspaceId: t.workspaceId };
    await expect(withAdmin((tx) => addGoldenCase(tx, comp, prod))).rejects.toThrow(/consent/);
    await expect(withAdmin((tx) => addGoldenCase(tx, comp, { ...prod, consentRef: 'ticket #812' }))).rejects.toThrow(/break-glass/);
    await startBreakGlass(comp, t.workspaceId, { reasonKind: 'compliance_review', reason: 'QA disagreement to golden set' });
    await withAdmin((tx) => addGoldenCase(tx, comp, { ...prod, consentRef: 'ticket #812', origin: { projectId: newId() } }));
    // The database enforces the rule too.
    await expect(ownerPool()`insert into golden_cases (dataset, input, expected, source, created_by) values ('compliance.scan', 'x', 'block', 'production', ${eng.staffId})`).rejects.toThrow();

    const cases = await withSystem((tx) => loadCases(tx, 'compliance.scan'));
    expect(cases.filter((c) => c.source === 'seed')).toHaveLength(GOLDEN['compliance.scan']!.length);
    expect(cases.filter((c) => c.source !== 'seed').map((c) => c.source).sort()).toEqual(['production', 'synthetic']);
    expect(runDeterministicEval('compliance.scan', cases).cases).toBe(cases.length);
    const [row] = await ownerPool()`select consent_ref, source_workspace_id from golden_cases where source = 'production'`;
    expect(row).toEqual({ consent_ref: 'ticket #812', source_workspace_id: t.workspaceId });
    expect(await ownerPool()`select action from admin_audit_log where action = 'golden.add'`).toHaveLength(2);

    await withAdmin((tx) => retireGoldenCase(tx, eng, synthetic, 'duplicate of cs-01'));
    expect((await withSystem((tx) => loadCases(tx, 'compliance.scan'))).length).toBe(cases.length - 1);
    // ANALYST can't add cases.
    const analyst = await staff(['ANALYST']);
    await expect(withAdmin((tx) => addGoldenCase(tx, analyst, { dataset: 'compliance.scan', input: 'y', expected: 'pass', source: 'synthetic' }))).rejects.toThrow(/role/);
  });
});
