import { expect, test } from '@playwright/test';
import { magicLinkFor } from './helpers';

/**
 * Customer sign-in in a real browser (plan 06 Phase 0 tests "auth e2e (magic link across devices, OAuth, rate
 * limit)"). Runs with mock providers, so Google and Apple go through the built-in mock identity provider.
 */
test('a magic link is only consumed by pressing Continue; a second click in the same browser says so', async ({ page }) => {
  const email = `e2e-auth-${Date.now()}@example.com`;
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Email me a link' }).click();
  await expect(page.getByText(`Check ${email}`)).toBeVisible();
  const link = await magicLinkFor(email);

  // Loading the page (as a link scanner running scripts would) leaves the link usable.
  await page.goto(link);
  await page.waitForTimeout(1500);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Sign in to Arkiv' })).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.waitForURL(/\/w\/[^/]+\/this-week|\/app/);

  await page.goto(link);
  await expect(page.getByRole('heading', { name: 'Already signed in' })).toBeVisible();
});

test('the original tab learns the link was used on another device', async ({ browser }) => {
  const email = `e2e-xdev-${Date.now()}@example.com`;
  const laptop = await browser.newContext();
  const phone = await browser.newContext();
  const a = await laptop.newPage();
  await a.goto('/login');
  await a.getByLabel('Email').fill(email);
  await a.getByRole('button', { name: 'Email me a link' }).click();
  const link = await magicLinkFor(email);
  const b = await phone.newPage();
  await b.goto(link);
  await b.getByRole('button', { name: 'Continue' }).click();
  await b.waitForURL(/\/w\/[^/]+\/this-week|\/app/);
  await expect(a.getByText('You’re signed in on your other device.')).toBeVisible({ timeout: 15_000 });
  await expect(a.getByRole('button', { name: 'Email me a link for this device' })).toBeVisible();
  await laptop.close();
  await phone.close();
});

test('Google through the mock identity provider signs in; a replayed callback in another browser is refused', async ({ browser }) => {
  const mine = await browser.newContext();
  const page = await mine.newPage();
  await page.goto('/login');
  await page.getByRole('link', { name: 'Continue with Google' }).click();
  await expect(page.getByRole('heading', { name: 'Continue with Google' })).toBeVisible();
  // Capture the callback URL the provider sends back, then let the flow finish.
  let callback = '';
  page.on('request', (r) => {
    if (r.url().includes('/api/auth/google/callback')) callback = r.url();
  });
  const address = `e2e-google-${Date.now()}@example.com`;
  await page.getByLabel('Or any verified address').fill(address);
  await page.getByRole('button', { name: 'Sign in as this address' }).click();
  await page.waitForURL(/\/w\/[^/]+\/this-week|\/app/);
  expect(callback).toContain('code=');

  // Login CSRF: the same callback delivered to a different browser must not sign it in.
  const victim = await browser.newContext();
  const v = await victim.newPage();
  await v.goto(callback);
  await expect(v).toHaveURL(/\/login\?error=/);
  await mine.close();
  await victim.close();
});
