/**
 * Captures every page (marketing, funnel stages, workspace app, admin) against running dev servers.
 * Usage: OUT=dir SLUG=<workspace slug> tsx tests/screenshots.ts
 */
import { chromium, devices, type BrowserContext, type Page } from '@playwright/test';
import { createSession, createStaff, totp } from '@arkiv/auth';
import { closeAll, withSystem } from '@arkiv/db';

const WEB = 'http://localhost:3000';
const ADMIN = 'http://localhost:3001';
const OUT = process.env.OUT!;
const SLUG = process.env.SLUG!;
const fixture = new URL('./e2e/fixtures/serum.jpg', import.meta.url).pathname;
let n = 0;

async function shot(page: Page, name: string, url?: string, wait?: () => Promise<unknown>) {
  if (url) await page.goto(url, { waitUntil: 'networkidle' }).catch(() => {});
  if (wait) await wait().catch((e) => console.warn(`  wait failed for ${name}: ${(e as Error).message.split('\n')[0]}`));
  await page.waitForTimeout(700); // let micro-animations settle
  const file = `${OUT}/${String(++n).padStart(2, '0')}-${name}.png`;
  await page.screenshot({ path: file, fullPage: true });
  console.log(file);
}

async function main() {
  const browser = await chromium.launch({ executablePath: process.env.PW_EXECUTABLE_PATH });
  const [ws] = await withSystem((tx) => tx`select id from workspaces where slug = ${SLUG}`);
  const [owner] = await withSystem((tx) => tx`select user_id from memberships where workspace_id = ${ws!.id} and role = 'OWNER'`);
  const [exp] = await withSystem((tx) => tx`select id from experiments where workspace_id = ${ws!.id} limit 1`);
  const [sku] = await withSystem((tx) => tx`select id from skus where workspace_id = ${ws!.id} and status = 'active' order by catalogue_no limit 1`);
  const desktop = { viewport: { width: 1440, height: 900 } };

  // ── Marketing (anonymous) ──
  const anon = await browser.newContext(desktop);
  const a = await anon.newPage();
  await shot(a, 'landing', `${WEB}/`);
  await shot(a, 'landing-texture', `${WEB}/for/texture?utm_source=tiktok`);
  await shot(a, 'pricing', `${WEB}/pricing`);
  await shot(a, 'legal-terms', `${WEB}/legal/terms`);
  await shot(a, 'login', `${WEB}/login`);
  await shot(a, 'magic-link-expired', `${WEB}/auth/magic/not-a-real-token-000000000000`);
  await shot(a, 'invite-not-found', `${WEB}/invite/not-a-real-token-000000000000`);
  await shot(a, 'start-upload', `${WEB}/start`);
  // Design-system catalogue (design §3), both themes.
  await shot(a, 'catalogue-light', `${WEB}/internal/catalogue?theme=light`);
  await shot(a, 'catalogue-dark', `${WEB}/internal/catalogue?theme=dark`);

  // Anonymous funnel up to the save gate.
  await a.locator('input[type=file][multiple]').setInputFiles(fixture);
  await a.getByRole('button', { name: /Analyze my product/ }).click();
  await a.waitForURL(/\/start\/[0-9a-f-]{36}/);
  await shot(a, 'funnel-cataloguing');
  await shot(a, 'funnel-product-confirmation', undefined, () => a.getByRole('link', { name: /show me 3 ad ideas/ }).waitFor({ timeout: 180_000 }));
  await a.getByRole('link', { name: /show me 3 ad ideas/ }).click();
  await shot(a, 'funnel-concepts', undefined, () => a.getByRole('button', { name: 'Build this storyboard' }).first().waitFor());
  await a.getByRole('button', { name: 'Build this storyboard' }).first().click();
  await shot(a, 'funnel-save-gate', undefined, () => a.getByRole('dialog').waitFor());

  // ── Signed-in customer ──
  const { token } = await createSession(owner!.user_id as string, { userAgent: 'screenshots' });
  const ctx: BrowserContext = await browser.newContext(desktop);
  await ctx.addCookies([{ name: 'arkiv_session', value: token, url: WEB }]);
  const p = await ctx.newPage();
  await p.goto(`${WEB}/start`);
  await p.locator('input[type=file][multiple]').setInputFiles(fixture);
  await p.getByRole('button', { name: /Analyze my product/ }).click();
  await p.waitForURL(/\/start\/[0-9a-f-]{36}/);
  await p.getByRole('link', { name: /show me 3 ad ideas/ }).waitFor({ timeout: 180_000 });
  await p.getByRole('link', { name: /show me 3 ad ideas/ }).click();
  await p.getByRole('button', { name: 'Build this storyboard' }).first().click();
  await p.waitForURL(/\/storyboard\//);
  await shot(p, 'funnel-storyboard-drawing');
  await shot(p, 'funnel-storyboard-offer', undefined, () => p.locator('#offer').waitFor({ timeout: 180_000 }));
  await p.getByRole('button', { name: 'Edit words' }).first().click();
  await p.getByLabel('Spoken line').fill('Cures acne overnight');
  await p.getByRole('button', { name: 'Save' }).click();
  await shot(p, 'funnel-claim-blocked', undefined, () => p.getByRole('alert').waitFor());
  await p.keyboard.press('Escape');
  await p.locator('#offer').getByRole('link', { name: /Make my ad/ }).click();
  await p.waitForURL(/\/checkout\/mock\//);
  await shot(p, 'funnel-checkout');
  await p.getByRole('button', { name: 'Pay with test card' }).click();
  await p.waitForURL(/\/produce\//);
  await shot(p, 'funnel-production', undefined, () => p.locator('.ak-ledger li[data-status="done"]').first().waitFor({ timeout: 60_000 }));
  await shot(p, 'funnel-delivery', undefined, () => p.getByRole('heading', { name: 'Your ad is ready' }).waitFor({ timeout: 420_000 }));

  // Workspace app.
  const w = `${WEB}/w/${SLUG}`;
  for (const [name, path] of [
    ['app-this-week', 'this-week'], ['app-creative-map', 'map'], ['app-results', 'results'], ['app-result-detail', `results/${exp?.id}`],
    ['app-studio', `studio/${exp?.id}`], ['app-products', 'products'], ['app-product-facts', `products/${sku?.id}`],
    ['app-product-packaging', `products/${sku?.id}?tab=look`], ['app-product-customer-language', `products/${sku?.id}?tab=language`],
    ['app-product-assets', `products/${sku?.id}?tab=assets`], ['app-product-past-ads', `products/${sku?.id}?tab=history`],
    ['app-claims-vault', `products/${sku?.id}/claims`], ['settings-members', 'settings/members'], ['settings-billing', 'settings/billing'],
    ['settings-integrations', 'settings/integrations'], ['settings-brand', 'settings/brand'], ['settings-access-log', 'settings/access-log'],
    ['settings-data', 'settings/data'], ['settings-profile', 'settings/profile'],
  ] as const) await shot(p, name, `${w}/${path}`);
  await p.goto(`${w}/settings/billing`);
  const cancel = p.getByRole('button', { name: 'Cancel plan' });
  if (await cancel.count()) {
    await cancel.first().click();
    await shot(p, 'settings-cancel-screen-1');
  }
  await shot(p, 'app-plan-picker', `${WEB}/app/plan?plan=GROWTH`);

  // Phone views.
  const phone = await browser.newContext({ ...devices['Pixel 7'] });
  await phone.addCookies([{ name: 'arkiv_session', value: token, url: WEB }]);
  const m = await phone.newPage();
  await shot(m, 'mobile-landing', `${WEB}/`);
  await shot(m, 'mobile-pricing', `${WEB}/pricing`);
  await shot(m, 'mobile-this-week', `${w}/this-week`);
  await shot(m, 'mobile-studio', `${w}/studio/${exp?.id}`);

  // ── Admin console ──
  const email = `shots-${Date.now().toString(36)}@arkiv.test`;
  const s = await createStaff({ email, name: 'Screenshot Admin', password: 'screenshots correct horse battery', roles: ['SUPER_ADMIN'] });
  const adm = await browser.newContext(desktop);
  const ap = await adm.newPage();
  await shot(ap, 'admin-login', `${ADMIN}/login`);
  await ap.getByLabel('Email').fill(email);
  await ap.getByLabel('Password').fill('screenshots correct horse battery');
  await ap.getByLabel('Authenticator code').fill(totp(s.totpSecret));
  await ap.getByRole('button', { name: 'Sign in' }).click();
  await ap.waitForURL(`${ADMIN}/`);
  const [user] = [owner!.user_id as string];
  for (const [name, path] of [
    ['admin-pulse', '/'], ['admin-approvals', '/approvals'], ['admin-tenants', '/tenants'],
    ...['overview', 'members', 'skus', 'projects', 'ledger', 'billing', 'integrations', 'emails', 'risk', 'access', 'danger'].map((t) => [`admin-tenant-${t}`, `/tenants/${ws!.id}?tab=${t}`]),
    ['admin-users', '/users'], ['admin-user-detail', `/users/${user}`], ['admin-retention', '/retention'], ['admin-funnel', '/funnel'],
    ['admin-landing-pages', '/landing-pages'], ['admin-landing-page-editor', '/landing-pages/default'], ['admin-offers', '/offers'], ['admin-email', '/email'],
    ['admin-billing', '/billing'], ['admin-billing-reconciliation', '/billing?tab=recon'], ['admin-ledger-cogs', '/ledger'], ['admin-ledger-margin', '/ledger?tab=margin'],
    ['admin-ledger-explorer', '/ledger?tab=explorer'], ['admin-rate-tables', '/rates'], ['admin-jobs', '/jobs'], ['admin-qa-review', '/qa'],
    ['admin-providers', '/providers'], ['admin-prompts-evals', '/prompts'], ['admin-integrations', '/integrations'], ['admin-claims', '/claims'],
    ['admin-abuse-rights', '/abuse'], ['admin-privacy', '/privacy'], ['admin-taxonomy', '/taxonomy'], ['admin-flags', '/flags'],
    ['admin-system', '/system'], ['admin-staff', '/staff'], ['admin-audit', '/audit'],
  ] as [string, string][]) await shot(ap, name, `${ADMIN}${path}`);

  await browser.close();
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => closeAll());
