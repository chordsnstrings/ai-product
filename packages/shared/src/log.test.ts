import { afterEach, describe, expect, it, vi } from 'vitest';
import { bindLogContext, currentRequestId, logger, payloadBindings, withLogContext } from './log';

function capture() {
  const lines: Record<string, unknown>[] = [];
  const out = vi.spyOn(process.stdout, 'write').mockImplementation((s) => (lines.push(JSON.parse(String(s))), true));
  const err = vi.spyOn(process.stderr, 'write').mockImplementation((s) => (lines.push(JSON.parse(String(s))), true));
  return { lines, restore: () => (out.mockRestore(), err.mockRestore()) };
}

afterEach(() => {
  delete process.env.LOG_LEVEL;
});

describe('structured logs (standard §34)', () => {
  it('writes one JSON line per record with the ids of the request or job it belongs to', async () => {
    process.env.LOG_LEVEL = 'info';
    const c = capture();
    try {
      await withLogContext({ requestId: 'req-12345678', workspaceId: 'ws-1' }, async () => {
        await Promise.resolve();
        bindLogContext({ projectId: 'p-1' });
        expect(currentRequestId()).toBe('req-12345678');
        logger('jobs').info('job finished', { durationMs: 12 });
        await withLogContext({ jobId: 'job-1', queue: 'produce-project' }, async () => logger('gateway').error('provider call failed', { err: new Error('boom') }));
      });
      logger('jobs').debug('not written at info');
    } finally {
      c.restore();
    }
    expect(c.lines).toHaveLength(2);
    expect(c.lines[0]).toMatchObject({ level: 'info', component: 'jobs', msg: 'job finished', requestId: 'req-12345678', workspaceId: 'ws-1', projectId: 'p-1', durationMs: 12 });
    expect(c.lines[1]).toMatchObject({ level: 'error', component: 'gateway', requestId: 'req-12345678', jobId: 'job-1', queue: 'produce-project', err: { name: 'Error', message: 'boom' } });
    expect(typeof c.lines[0]!.ts).toBe('string');
    expect(currentRequestId()).toBeUndefined(); // contexts never leak past their scope
  });

  it('reads the domain ids a job payload carries', () => {
    expect(payloadBindings({ workspaceId: 'w', skuId: 's', projectId: 'p', requestId: 'r', actor: { kind: 'user' }, batch: 2 })).toEqual({ workspaceId: 'w', skuId: 's', projectId: 'p', requestId: 'r' });
  });

  it('is silent below the configured level', () => {
    process.env.LOG_LEVEL = 'silent';
    const c = capture();
    try {
      logger('x').error('hidden');
    } finally {
      c.restore();
    }
    expect(c.lines).toHaveLength(0);
  });
});
