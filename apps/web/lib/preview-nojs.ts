import { NextResponse } from 'next/server';
import { DomainError, env } from '@arkiv/shared';
import { logger } from '@arkiv/shared/log';

const log = logger('preview-nojs');

/**
 * The plain HTML upload form (plan 03 P1 "JS disabled → the plain form still posts a URL") posts to /api/preview with
 * `nojs=1` and is answered with redirects instead of JSON: to the preview on success, or back to /start with the
 * reason and the link that was entered, so nothing typed is lost.
 */
export function noJsAnswer(result: { projectId: string } | { error: unknown; url: string | null }): NextResponse {
  const base = env().APP_URL;
  if ('projectId' in result) return NextResponse.redirect(`${base}/start/${encodeURIComponent(result.projectId)}`, 303);
  const e = result.error;
  if (!(e instanceof DomainError)) log.error('preview (no-JS form) failed', { err: e });
  const q = new URLSearchParams({ error: (e instanceof DomainError ? e.message : 'Something went wrong. Please try again.').slice(0, 200) });
  if (result.url) q.set('url', result.url.slice(0, 500));
  return NextResponse.redirect(`${base}/start?${q}`, 303);
}

/** What /start shows after a no-JS post came back: the reason, and the link to put back in the field. */
export function noJsReturn(sp: { error?: string | string[]; url?: string | string[] }): { error: string | null; url: string } {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';
  return { error: one(sp.error).slice(0, 200) || null, url: one(sp.url).slice(0, 500) };
}
