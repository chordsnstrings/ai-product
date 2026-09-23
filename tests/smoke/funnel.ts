/**
 * End-to-end HTTP smoke test of the conversion funnel against a running web + worker (mock providers, mock Stripe):
 *   photo → analysis → concepts → save gate → magic link → storyboard → checkout → production → exports → app pages.
 * Usage: BASE=http://localhost:3000 WEB_LOG=path/to/web.log tsx tests/smoke/funnel.ts
 */
import { readFileSync } from 'node:fs';
import { productPhoto } from '@arkiv/core/testing';

const BASE = process.env.BASE ?? 'http://localhost:3000';
const WEB_LOG = process.env.WEB_LOG;
const jar = new Map<string, string>();

async function http(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('origin', BASE);
  headers.set('cookie', [...jar].map(([k, v]) => `${k}=${v}`).join('; '));
  const r = await fetch(`${BASE}${path}`, { ...init, headers, redirect: 'manual' });
  for (const c of r.headers.getSetCookie()) {
    const [kv] = c.split(';');
    const [k, ...v] = kv!.split('=');
    if (/max-age=0|expires=thu, 01 jan 1970/i.test(c) || v.join('=') === '') jar.delete(k!);
    else jar.set(k!, v.join('='));
  }
  return r;
}
const post = (path: string, body: unknown) => http(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
async function ok<T>(r: Response | Promise<Response>): Promise<T> {
  const res = await r;
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${res.url}: ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : {}) as T;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(label: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 180_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout: ${label}`);
    await sleep(1000);
  }
}
const step = (s: string) => console.log(`\n▸ ${s}`);

type View = { project: { state: string }; sku: { status: string; name: string }; concepts: { id: string; isPick: boolean }[]; storyboard: { status: string; scenes: { id: string }[] } | null; quote: { kind: string; priceMicros: number }; exports: { aspect: string; download: string }[]; access: { workspaceSlug: string | null } };

async function main() {
  step('Landing + pricing render');
  for (const p of ['/', '/pricing', '/for/texture', '/legal/terms', '/login']) {
    const r = await http(p);
    if (r.status !== 200) throw new Error(`${p} → ${r.status}`);
    console.log(`  ${p} 200`);
  }

  step('Upload a product photo (no account)');
  const photo = await productPhoto('DEW SERUM', '#E8DCC8');
  const fd = new FormData();
  fd.append('photos', new Blob([new Uint8Array(photo)], { type: 'image/jpeg' }), 'serum.jpg');
  fd.set('page', 'smoke');
  const { projectId } = await ok<{ projectId: string }>(http('/api/preview', { method: 'POST', body: fd }));
  console.log(`  project ${projectId}; provisional cookie: ${jar.has('arkiv_preview')}`);

  step('Analysis → concepts');
  const withConcepts = await until('concepts', async () => {
    const v = await ok<View>(http(`/api/projects/${projectId}`));
    if (v.sku.status === 'rejected') throw new Error('SKU rejected');
    return v.concepts.length === 3 ? v : null;
  });
  console.log(`  ${withConcepts.sku.name}: ${withConcepts.concepts.length} concepts`);

  step('Save gate blocks anonymous storyboard');
  const pick = withConcepts.concepts.find((c) => c.isPick)!;
  const gated = await post(`/api/projects/${projectId}/select`, { conceptId: pick.id });
  if (gated.status !== 403) throw new Error(`expected 403, got ${gated.status}`);
  console.log('  403 needsAccount ✓');

  step('Magic link sign-in (dev email log)');
  const email = `smoke+${Date.now()}@example.com`;
  await ok(post('/api/auth/magic', { email, next: `/concepts/${projectId}` }));
  if (!WEB_LOG) throw new Error('WEB_LOG not set');
  const url = await until('magic link in log', async () => {
    const m = [...readFileSync(WEB_LOG, 'utf8').matchAll(/\[email:dev\] magic_link → ([^:]+): .*?"url":"([^"]+)"/g)].filter((x) => x[1] === email).pop();
    return m?.[2] ?? null;
  }, 20_000);
  const token = url.split('/').pop()!;
  const page = await http(`/auth/magic/${token}`);
  if (page.status !== 200) throw new Error(`magic GET ${page.status}`);
  const consumed = await ok<{ next: string }>(post('/api/auth/magic/consume', { token }));
  console.log(`  signed in → ${consumed.next}; session: ${jar.has('arkiv_session')}; preview cookie cleared: ${!jar.has('arkiv_preview')}`);
  const reuse = await post('/api/auth/magic/consume', { token });
  if (reuse.status !== 409) throw new Error(`link reuse should 409, got ${reuse.status}`);

  step('Select concept → storyboard');
  await ok(post(`/api/projects/${projectId}/select`, { conceptId: pick.id }));
  const sb = await until('storyboard ready', async () => {
    const v = await ok<View>(http(`/api/projects/${projectId}`));
    return v.storyboard?.status === 'ready' ? v : null;
  });
  console.log(`  ${sb.storyboard!.scenes.length} scenes; quote ${sb.quote.kind} $${sb.quote.priceMicros / 1e6}`);

  step('Scene edit is claim-checked');
  const bad = await post(`/api/scenes/${sb.storyboard!.scenes[0]!.id}/edit`, { projectId, spokenLine: 'Cures acne overnight' });
  console.log(`  drug claim → ${bad.status} ${(await bad.json()).error}`);
  if (bad.status !== 422) throw new Error('drug claim must be blocked');
  await ok(post(`/api/scenes/${sb.storyboard!.scenes[0]!.id}/edit`, { projectId, spokenLine: 'Skin feels soft and looks dewy.' }));

  step('Checkout (mock Stripe) → production');
  const co = await ok<{ sessionId: string; url: string }>(post(`/api/projects/${projectId}/checkout`, {}));
  const mockPage = await http(`/checkout/mock/${co.sessionId}`);
  if (mockPage.status !== 200) throw new Error(`mock checkout page ${mockPage.status}`);
  await ok(post(`/api/checkout/mock/${co.sessionId}`, {}));
  const done = await until('production complete', async () => {
    const v = await ok<View>(http(`/api/projects/${projectId}`));
    if (['PROVIDER_FAILED', 'REFUNDED', 'BLOCKED_COMPLIANCE'].includes(v.project.state)) throw new Error(`production ended ${v.project.state}`);
    return v.project.state === 'COMPLETE' ? v : null;
  }, 420_000);
  console.log(`  exports: ${done.exports.map((e) => e.aspect).join(', ')}`);

  step('Download (tracked) → signed file');
  const dl = await http(done.exports[0]!.download);
  const loc = dl.headers.get('location');
  if (dl.status !== 303 || !loc) throw new Error(`download ${dl.status}`);
  const file = await fetch(loc);
  const bytes = Buffer.from(await file.arrayBuffer());
  if (file.status !== 200 || bytes.subarray(4, 8).toString() !== 'ftyp') throw new Error('export is not an mp4');
  console.log(`  mp4 ${bytes.length} bytes ✓`);

  step('App pages');
  const slug = done.access.workspaceSlug!;
  for (const p of ['this-week', 'map', 'results', 'products', 'settings/members', 'settings/billing', 'settings/integrations', 'settings/brand', 'settings/access-log', 'settings/data', 'settings/profile']) {
    const r = await http(`/w/${slug}/${p}`);
    if (r.status !== 200) throw new Error(`/w/${slug}/${p} → ${r.status}: ${(await r.text()).slice(0, 200)}`);
    console.log(`  /w/${slug}/${p} 200`);
  }
  const other = await http(`/w/not-${slug}/this-week`);
  console.log(`  foreign workspace → ${other.status}`);
  if (other.status !== 404) throw new Error('foreign workspace must 404');

  step('Subscribe (consent required) → plan active');
  const noConsent = await post(`/api/w/${slug}/subscribe`, { plan: 'GROWTH', agreed: false });
  if (noConsent.status !== 422) throw new Error(`subscribe without consent should 422, got ${noConsent.status}`);
  const sub = await ok<{ sessionId: string }>(post(`/api/w/${slug}/subscribe`, { plan: 'GROWTH', agreed: true }));
  await ok(post(`/api/checkout/mock/${sub.sessionId}`, {}));
  const billing = await (await http(`/w/${slug}/settings/billing`)).text();
  if (!/Growth/.test(billing) || !/7 of 7/.test(billing)) throw new Error('plan not active on billing page');
  console.log('  Growth active, 7 of 7 tests ✓');

  step('Cancel in two clicks → uncancel');
  const c = await ok<{ endsAt: string }>(post(`/api/w/${slug}/cancel`, { reason: 'too_expensive' }));
  console.log(`  cancelled, ends ${c.endsAt}`);
  await ok(post(`/api/w/${slug}/uncancel`, {}));

  step('Retention loop: recommendations → Studio → produce → results');
  await ok(post(`/api/w/${slug}/rec-refresh`, {}));
  await until('recommendations', async () => (await import('./db').then((m) => m.openRecommendations(slug))).rows.length > 0 || null, 180_000);
  const { rows } = await import('./db').then((m) => m.openRecommendations(slug));
  const accepted = await ok<{ experimentId: string; projectId: string }>(post(`/api/w/${slug}/rec-accept`, { id: rows[0]!.id }));
  await until('experiment storyboard', async () => {
    const v = await ok<View>(http(`/api/projects/${accepted.projectId}`));
    return v.storyboard?.status === 'ready' ? v : null;
  });
  const studio = await http(`/w/${slug}/studio/${accepted.experimentId}`);
  if (studio.status !== 200) throw new Error(`studio ${studio.status}`);
  await ok(post(`/api/w/${slug}/experiment-approve`, { experimentId: accepted.experimentId }));
  const codes = await until('variants ready', async () => {
    const r = await import('./db').then((m) => m.experimentState(slug, accepted.experimentId));
    return r.state === 'READY_TO_RUN' ? r.codes : null;
  }, 420_000);
  console.log(`  variants ${codes.join(', ')} ready`);
  await ok(post(`/api/w/${slug}/experiment-live`, { experimentId: accepted.experimentId }));
  const today = new Date();
  const lines = ['Ad name,Day,Spend,Impressions,Clicks,Purchases'];
  for (let d = 0; d < 7; d++) {
    const day = new Date(today.getTime() - (d + 1) * 86400_000).toISOString().slice(0, 10);
    codes.forEach((c, i) => lines.push(`Spring test — ${c},${day},40,${4000 + i * 10},${i === 0 ? 120 : 60},${i === 0 ? 6 : 3}`));
  }
  const csv = new FormData();
  csv.append('file', new Blob([lines.join('\n')], { type: 'text/csv' }), 'report.csv');
  const up = await ok<{ inserted?: number }>(http(`/api/w/${slug}/performance-csv`, { method: 'POST', body: csv }));
  console.log(`  CSV ingested ${JSON.stringify(up)}`);
  const results = await until('results computed', async () => {
    const html = await (await http(`/w/${slug}/results/${accepted.experimentId}`)).text();
    return /Chance best/.test(html) ? html : null;
  }, 60_000);
  console.log(`  results page shows ${(results.match(/<tr>/g) ?? []).length - 1} result rows`);

  console.log('\n✓ funnel smoke passed');
}

main().catch((e) => {
  console.error('\n✗', e);
  process.exit(1);
});
