import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool, withAdmin } from '@arkiv/db';
import { makeSku, makeTenant, truncateAll } from '@arkiv/db/testing';
import { newId } from '@arkiv/shared';
import { qaQueueSql } from './admin';
import { labelDiff, qaCalibration, reviewedChecks } from './qa-metrics';

/** Plan 05 §13: QA review queue, label-OCR diff, and precision/recall against human verdicts. */
beforeEach(truncateAll);
afterAll(closeAll);

describe('QA calibration (precision / recall vs human verdicts)', () => {
  it('scores each check per provider, treating a failed check as a positive', () => {
    const rows = qaCalibration([
      { check: 'product_fidelity', provider: 'byteplus', autoPass: false, agree: true, score: 90 }, // TP
      { check: 'product_fidelity', provider: 'byteplus', autoPass: false, agree: true, score: 80 }, // TP
      { check: 'product_fidelity', provider: 'byteplus', autoPass: false, agree: false, score: 30 }, // FP: really fine
      { check: 'product_fidelity', provider: 'byteplus', autoPass: true, agree: false, score: 70 }, // FN: missed defect
      { check: 'product_fidelity', provider: 'byteplus', autoPass: true, agree: true, score: 20 }, // TN
      { check: 'claims', provider: 'byteplus', autoPass: true, agree: true },
    ]);
    const f = rows.find((r) => r.check === 'product_fidelity')!;
    expect(f).toMatchObject({ tp: 2, fp: 1, fn: 1, tn: 1, goodScoreMedian: 25, badScoreMedian: 80, suggestedThreshold: 52.5 });
    expect(f.precision).toBeCloseTo(2 / 3);
    expect(f.recall).toBeCloseTo(2 / 3);
    const c = rows.find((r) => r.check === 'claims')!;
    expect(c).toMatchObject({ tp: 0, tn: 1, precision: null, recall: null, suggestedThreshold: null });
  });

  it('joins stored verdicts to the report check they judged and to the rendering provider', async () => {
    const t = await makeTenant();
    const sku = await makeSku(t.workspaceId);
    const pid = newId();
    const report = { checks: [{ check: 'product_fidelity', pass: false, hard: true, detail: 'label', data: { paletteDistance: 88 } }, { check: 'claims', pass: true, hard: true, detail: 'ok' }] };
    await ownerPool()`insert into projects (id, workspace_id, sku_id, kind, state, created_by, qa_report) values (${pid}, ${t.workspaceId}, ${sku}, 'taste', 'COMPLETE', 'test', ${ownerPool().json(report)})`;
    await ownerPool()`insert into provider_jobs (workspace_id, project_id, provider, task, model, request_hash, status) values (${t.workspaceId}, ${pid}, 'byteplus', 'video.scene', 'm', 'h', 'succeeded')`;
    await ownerPool()`insert into qa_reviews (workspace_id, project_id, staff_id, verdicts) values (${t.workspaceId}, ${pid}, ${newId()}, ${ownerPool().json({ '1:product_fidelity': 'disagree', '2:claims': 'agree', '3:visual': 'agree' })})`;
    const rows = await withAdmin((tx) => reviewedChecks(tx, { includeTest: true }));
    // "3:visual" names no check in the report: ignored.
    expect(rows.sort((a, b) => b.check.localeCompare(a.check))).toEqual([
      { check: 'product_fidelity', provider: 'byteplus', autoPass: false, agree: false, score: 88 },
      { check: 'claims', provider: 'byteplus', autoPass: true, agree: true, score: null },
    ]);
  });
});

describe('QA review queue (plan 05 §13)', () => {
  it('queues outputs whose technique was switched after failing QA twice', async () => {
    const t = await makeTenant();
    const sku = await makeSku(t.workspaceId);
    const switched = newId();
    const plain = newId();
    const report = (extra: Record<string, unknown>) => ({ pass: true, checks: [{ check: 'product_fidelity', pass: true, hard: false, detail: 'Scene 2: switched to exact product composite', data: extra }] });
    await ownerPool()`insert into projects (id, workspace_id, sku_id, kind, state, created_by, qa_report) values
                      (${switched}, ${t.workspaceId}, ${sku}, 'taste', 'COMPLETE', 'test', ${ownerPool().json(report({ techniqueSwitch: { sceneId: newId(), from: 'generative', to: 'exact_product_composite', why: 'repeated QA failure' } }) as never)}),
                      (${plain}, ${t.workspaceId}, ${sku}, 'taste', 'COMPLETE', 'test', ${ownerPool().json(report({}) as never)})`;
    const q = await withAdmin((tx) => tx`select id, why from (${qaQueueSql(tx, { includeTest: true })}) q`);
    expect(q.find((r) => r.id === switched)?.why).toBe('technique switched');
    expect(q.find((r) => r.id === plain)?.why ?? 'calibration sample').toBe('calibration sample');
  });
});

describe('label OCR diff', () => {
  it('marks words missing from, and extra on, the output label', () => {
    expect(labelDiff('GLOW SERUM 30 ml', 'GLOW SERUMM 30 ml')).toEqual([
      { word: 'GLOW', status: 'same' },
      { word: 'SERUM', status: 'missing' },
      { word: 'SERUMM', status: 'extra' },
      { word: '30', status: 'same' },
      { word: 'ml', status: 'same' },
    ]);
    expect(labelDiff('Dew', null)).toEqual([{ word: 'Dew', status: 'missing' }]);
    expect(labelDiff('glow serum', 'GLOW Serum')).toEqual([{ word: 'GLOW', status: 'same' }, { word: 'Serum', status: 'same' }]);
  });
});
