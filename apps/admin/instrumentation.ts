import type { Instrumentation } from 'next';

/**
 * Observability bootstrap (plan 06 Phase 0 D10): names this service on logs and traces, and reports errors Next
 * catches outside our route wrappers (server components, actions) with the trace ids of the request. Spans are
 * exported over OTLP/HTTP when OTEL_EXPORTER_OTLP_ENDPOINT is set (@arkiv/shared/trace). Node runtime only.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { setLogService } = await import('@arkiv/shared/log');
  const { setTraceService } = await import('@arkiv/shared/trace');
  setLogService('admin');
  setTraceService('admin');
}

export const onRequestError: Instrumentation.onRequestError = async (err, request, context) => {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { reportError } = await import('@arkiv/shared/trace');
  reportError(err, { msg: 'unhandled server error', method: request.method, path: request.path.split('?')[0], routePath: context.routePath, routeType: context.routeType });
};
