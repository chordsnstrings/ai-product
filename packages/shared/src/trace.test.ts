import { createServer, type Server } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { logger, redact } from './log';
import { activeSpan, flushTraces, reportError, withSpan } from './trace';

/** Plan 06 Phase 0 D10: structured logs with redaction, OpenTelemetry (OTLP) traces, error tracking. */
function capture() {
  const lines: Record<string, unknown>[] = [];
  const out = vi.spyOn(process.stdout, 'write').mockImplementation((s) => (lines.push(JSON.parse(String(s))), true));
  const err = vi.spyOn(process.stderr, 'write').mockImplementation((s) => (lines.push(JSON.parse(String(s))), true));
  return { lines, restore: () => (out.mockRestore(), err.mockRestore()) };
}

let server: Server;
const received: { path: string; headers: Record<string, unknown>; body: { resourceSpans: { resource: unknown; scopeSpans: { spans: Record<string, unknown>[] }[] }[] } }[] = [];
beforeAll(async () => {
  server = createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      received.push({ path: req.url ?? '', headers: req.headers, body: JSON.parse(b) });
      res.writeHead(200).end('{}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
afterEach(() => {
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  delete process.env.OTEL_EXPORTER_OTLP_HEADERS;
  delete process.env.LOG_LEVEL;
  received.length = 0;
});

describe('log redaction', () => {
  it('replaces secret-named fields and masks email addresses and bearer credentials in text', () => {
    expect(redact({ email: 'a@b.co', token: 't', nested: { password: 'p', refresh_token: 'r', token_enc: 'x', note: 'mail me at jo@shop.com' }, inputTokens: 1200, to: 'MERCHANT', header: 'Bearer abcdefghijkl' })).toEqual({
      email: '[redacted]',
      token: '[redacted]',
      nested: { password: '[redacted]', refresh_token: '[redacted]', token_enc: '[redacted]', note: 'mail me at [email]' },
      inputTokens: 1200,
      to: 'MERCHANT',
      header: 'Bearer [redacted]',
    });
  });

  it('never writes an email or a credential to a log line, including error messages', () => {
    process.env.LOG_LEVEL = 'info';
    const c = capture();
    try {
      logger('auth').info('magic link sent to jo@shop.com', { email: 'jo@shop.com', apiKey: 'sk_live_x' });
      logger('auth').error('send failed', { err: new Error('rejected recipient jo@shop.com') });
    } finally {
      c.restore();
    }
    const text = JSON.stringify(c.lines);
    expect(text).not.toContain('jo@shop.com');
    expect(text).not.toContain('sk_live_x');
    expect(c.lines[0]).toMatchObject({ msg: 'magic link sent to [email]', email: '[redacted]', apiKey: '[redacted]' });
  });
});

describe('traces', () => {
  it('nests spans in one trace and stamps log lines with the trace ids', async () => {
    process.env.LOG_LEVEL = 'info';
    const c = capture();
    let outer: { traceId: string; spanId: string } | null = null;
    let inner: { traceId: string; spanId: string } | null = null;
    try {
      await withSpan('job produce-project', { 'arkiv.queue': 'produce-project' }, async (s) => {
        outer = s;
        await withSpan('provider video.scene', {}, async (t) => {
          inner = t;
          logger('gateway').info('provider call succeeded');
        });
      });
    } finally {
      c.restore();
    }
    expect(inner!.traceId).toBe(outer!.traceId);
    expect(inner!.spanId).not.toBe(outer!.spanId);
    expect(c.lines[0]).toMatchObject({ traceId: outer!.traceId, spanId: inner!.spanId });
    expect(activeSpan()).toBeNull();
  });

  it('exports finished spans over OTLP/HTTP JSON with headers, errors marked and exceptions recorded', async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    process.env.OTEL_EXPORTER_OTLP_HEADERS = 'Authorization=Basic%20abc,x-scope=arkiv';
    await withSpan('GET /api/health', { 'http.request.method': 'GET', n: 3 }, async () => {
      await expect(withSpan('db tenant transaction', {}, async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    }, { kind: 'server' });
    expect(await flushTraces()).toBe(2);
    expect(received).toHaveLength(1);
    expect(received[0]!.path).toBe('/v1/traces');
    expect(received[0]!.headers).toMatchObject({ authorization: 'Basic abc', 'x-scope': 'arkiv' });
    const spans = received[0]!.body.resourceSpans[0]!.scopeSpans[0]!.spans;
    const [child, root] = spans;
    expect(root).toMatchObject({ name: 'GET /api/health', kind: 2, status: { code: 1 } });
    expect(root!.attributes).toContainEqual({ key: 'n', value: { intValue: '3' } });
    expect(child).toMatchObject({ name: 'db tenant transaction', parentSpanId: root!.spanId, traceId: root!.traceId, status: { code: 2, message: 'boom' } });
    expect((child!.events as { name: string }[])[0]!.name).toBe('exception');
    expect(BigInt(child!.endTimeUnixNano as string) >= BigInt(child!.startTimeUnixNano as string)).toBe(true);
  });

  it('reportError logs the error and, outside a span, exports a one-off error span', async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const c = capture();
    try {
      reportError(new Error('worker crashed'), { msg: 'dispatch error' });
    } finally {
      c.restore();
    }
    expect(c.lines[0]).toMatchObject({ level: 'error', component: 'errors', msg: 'dispatch error', err: { message: 'worker crashed' } });
    await flushTraces();
    const [span] = received[0]!.body.resourceSpans[0]!.scopeSpans[0]!.spans;
    expect(span).toMatchObject({ name: 'error', status: { code: 2, message: 'worker crashed' } });
  });

  it('exports nothing without an endpoint', async () => {
    await withSpan('x', {}, async () => {});
    expect(await flushTraces()).toBe(0);
    expect(received).toHaveLength(0);
  });
});
