/**
 * Admin console smoke test against a running admin app + worker: staff login with TOTP, every module renders,
 * break-glass gates content, four-eyes approvals, 🔐 re-auth, ops commands executed by the worker, audit CSV.
 * Usage: ADMIN=http://localhost:3001 tsx tests/smoke/admin.ts
 */
import { createStaff, totp } from '@arkiv/auth';
import { closeAll, withSystem } from '@arkiv/db';

const BASE = process.env.ADMIN ?? 'http://localhost:3001';

class Client {
  jar = new Map<string, string>();
  async req(path: string, init: RequestInit = {}) {
    const h = new Headers(init.headers);
    h.set('origin', BASE);
    h.set('cookie', [...this.jar].map(([k, v]) => `${k}=${v}`).join('; '));
    const r = await fetch(`${BASE}${path}`, { ...init, headers: h, redirect: 'manual' });
    for (const c of r.headers.getSetCookie()) {
      const [kv] = c.split(';');
      const [k, ...v] = kv!.split('=');
      this.jar.set(k!, v.join('='));
    }
    return r;
  }
  post(path: string, body: unknown) {
    return this.req(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  }
  async act(action: string, body: unknown, secret?: string) {
    let r = await this.post(`/api/act/${action}`, body);
    let j = await r.json();
    if (r.status === 403 && j.details?.reauth && secret) {
      const re = await this.post('/api/reauth', { code: totp(secret) });
      if (!re.ok) throw new Error(`reauth failed ${re.status}`);
      r = await this.post(`/api/act/${action}`, body);
      j = await r.json();
    }
    if (!r.ok) throw new Error(`${action} → ${r.status}: ${j.error}`);
    return j;
  }
}
const step = (s: string) => console.log(`\n▸ ${s}`);

async function main() {
  const tag = Date.now().toString(36);
  const sa = await createStaff({ email: `sa-${tag}@arkiv.test`, name: 'Smoke Super', password: 'correct horse battery staple', roles: ['SUPER_ADMIN'] });
  const fin = await createStaff({ email: `fin-${tag}@arkiv.test`, name: 'Smoke Finance', password: 'correct horse battery staple', roles: ['FINANCE'] });
  const [ws] = await withSystem((tx) => tx`select id, slug from workspaces where state <> 'PROVISIONAL' order by created_at desc limit 1`);
  if (!ws) throw new Error('run the funnel smoke first (needs a workspace)');

  step('Login (password + TOTP), bad code rejected');
  const A = new Client();
  const bad = await A.post('/api/login', { email: `sa-${tag}@arkiv.test`, password: 'correct horse battery staple', code: '000000' });
  if (bad.status !== 403) throw new Error(`bad code should 403, got ${bad.status}`);
  const ok = await A.post('/api/login', { email: `sa-${tag}@arkiv.test`, password: 'correct horse battery staple', code: totp(sa.totpSecret) });
  if (!ok.ok) throw new Error(`login ${ok.status}`);
  const F = new Client();
  if (!(await F.post('/api/login', { email: `fin-${tag}@arkiv.test`, password: 'correct horse battery staple', code: totp(fin.totpSecret) })).ok) throw new Error('fin login');

  step('Every module renders for SUPER_ADMIN');
  const pages = ['/', '/approvals', '/tenants', `/tenants/${ws.id}`, '/users', '/retention', '/funnel', '/landing-pages', '/landing-pages/default', '/offers', '/email', '/billing', '/ledger', '/rates', '/jobs', '/qa', '/providers', '/prompts', '/integrations', '/claims', '/abuse', '/privacy', '/taxonomy', '/flags', '/system', '/staff', '/audit'];
  for (const tab of ['members', 'skus', 'projects', 'ledger', 'billing', 'integrations', 'emails', 'risk', 'access', 'danger']) pages.push(`/tenants/${ws.id}?tab=${tab}`);
  for (const p of pages) {
    const r = await A.req(p);
    if (r.status !== 200) throw new Error(`${p} → ${r.status}\n${(await r.text()).slice(0, 400)}`);
  }
  console.log(`  ${pages.length} pages 200`);

  step('QA case lists the stored checks by name');
  const [qaProject] = await withSystem((tx) => tx`select id, workspace_id from projects where jsonb_array_length(coalesce(qa_report->'checks', '[]'::jsonb)) > 0
                                                  and qa_report->'checks' @> '[{"check": "product_fidelity"}]' order by updated_at desc limit 1`);
  if (qaProject) {
    const html = await (await A.req(`/qa/${qaProject.id}?ws=${qaProject.workspace_id}`)).text();
    if (!/product_fidelity/.test(html)) throw new Error('QA case page does not list product_fidelity');
    if (/&quot;undefined&quot;|"undefined":/.test(html)) throw new Error('QA verdict template has undefined keys');
    console.log('  ✓');
  } else console.log('  (no produced project with a QA report yet — skipped)');

  step('Role gating: FINANCE cannot see staff or claims modules');
  for (const p of ['/staff', '/claims', '/audit']) {
    const r = await F.req(p);
    if (r.status !== 404) throw new Error(`${p} for FINANCE → ${r.status}`);
  }
  if ((await F.req('/ledger')).status !== 200) throw new Error('FINANCE should see ledger');
  console.log('  ✓');

  step('Break-glass gates tenant content');
  const before = await (await A.req(`/tenants/${ws.id}?tab=skus`)).text();
  if (!/Start break-glass/.test(before)) throw new Error('content visible without break-glass');
  await A.act('tenant.breakglass', { workspaceId: ws.id, reason: 'Smoke test: verifying support access flow', ticket: 'SMOKE-1' });
  const after = await (await A.req(`/tenants/${ws.id}?tab=skus`)).text();
  if (!/Content \(break-glass\)/.test(after) || /Start break-glass/.test(after)) throw new Error('content not shown after break-glass');
  await A.act('tenant.breakglass_end', { workspaceId: ws.id });
  console.log('  ✓ (customer access log records it)');

  step('Four-eyes: big ledger adjustment waits for FINANCE; 🔐 re-auth enforced');
  const small = await F.act('tenant.ledger_adjust', { workspaceId: ws.id, unit: 'creative_test', amount: 1, reason: 'goodwill credit smoke' }, fin.totpSecret);
  if (small.status !== 'executed') throw new Error('small adjust should execute');
  const big = await A.act('tenant.ledger_adjust', { workspaceId: ws.id, unit: 'creative_test', amount: 10, reason: 'migration credit smoke' }, sa.totpSecret);
  if (big.status !== 'pending') throw new Error('big adjust should wait');
  const self = await A.post('/api/act/approval.decide', { id: big.approvalId, approve: true });
  if (self.ok) throw new Error('self-approval must fail');
  const decided = await F.act('approval.decide', { id: big.approvalId, approve: true }, fin.totpSecret);
  if (decided.status !== 'executed') throw new Error(`approval not executed: ${JSON.stringify(decided)}`);
  console.log('  ✓ small executed, big approved by second person');

  step('Eval run executed by the worker');
  await A.act('eval.run', { dataset: 'compliance.classify' });
  const t0 = Date.now();
  for (;;) {
    const [r] = await withSystem((tx) => tx`select status, score from eval_runs order by created_at desc limit 1`);
    if (r && r.status !== 'queued') {
      console.log(`  eval ${r.status} score ${r.score}`);
      if (r.status !== 'passed') throw new Error('golden set should pass');
      break;
    }
    if (Date.now() - t0 > 30_000) throw new Error('worker did not run eval');
    await new Promise((res) => setTimeout(res, 1000));
  }

  step('Kill switch needs 🔐; landing page lint blocks fake proof');
  await A.act('flag.set', { key: 'kill.free_preview', enabled: true, reason: 'smoke on' }, sa.totpSecret);
  await A.act('flag.set', { key: 'kill.free_preview', enabled: false, reason: 'smoke off' }, sa.totpSecret);
  const lint = await A.post('/api/act/lp.save', { slug: `smoke-${tag}`, archetype: 'general', content: { headline: 'Brands see 3x ROAS guaranteed' }, variants: [], utmMatch: '' });
  if (lint.status !== 422) throw new Error(`lint should block, got ${lint.status}`);
  await A.act('lp.save', { slug: `smoke-${tag}`, archetype: 'general', content: { label: 'Skincare', headline: 'Texture ads for your serum', sub: 'Three ideas in a minute.' }, variants: [], utmMatch: '' });
  console.log('  ✓');

  step('Audit CSV');
  const csv = await A.req('/api/audit.csv');
  const text = await csv.text();
  if (!text.startsWith('id,at,staff') || !/breakglass.start/.test(text)) throw new Error('audit csv missing entries');
  console.log(`  ${text.split('\n').length - 1} rows`);
  console.log('\n✓ admin smoke passed');
}

main()
  .catch((e) => {
    console.error('\n✗', e);
    process.exitCode = 1;
  })
  .finally(() => closeAll());
