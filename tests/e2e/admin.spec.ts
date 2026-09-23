import { expect, test } from '@playwright/test';
import { headingOutline, staffCreds, totp } from './helpers';

const ADMIN = 'http://localhost:3001';

/** Staff console: password + TOTP login, Pulse, tenant list, and the kill-switch 🔐 prompt. */
test('staff can sign in and use the console', async ({ page }) => {
  const c = staffCreds();
  await page.goto(`${ADMIN}/login`);
  await page.getByLabel('Email').fill(c.email);
  await page.getByLabel('Password').fill(c.password);
  await page.getByLabel('Authenticator code').fill(totp(c.secret));
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Platform Pulse' })).toBeVisible();
  await headingOutline(page);
  await page.getByRole('link', { name: 'Tenants' }).click();
  await expect(page.getByRole('heading', { name: 'Tenants' })).toBeVisible();
  await expect(page.getByLabel('Search tenants')).toBeVisible(); // filters have visible labels, not placeholders only
  await page.getByRole('link', { name: 'Flags & config' }).click();
  await expect(page.getByRole('heading', { name: 'Kill switches' })).toBeVisible(); // Section titles are headings
  await headingOutline(page);
  // Turning a kill switch on asks for confirmation and a reason (and a fresh code if 2FA is older than 5 min).
  const dialogs: string[] = [];
  page.on('dialog', async (d) => {
    dialogs.push(d.message());
    if (d.type() === 'confirm') await d.accept();
    else if (/authenticator/i.test(d.message())) await d.accept(totp(c.secret));
    else await d.accept('e2e toggle');
  });
  const row = page.locator('tr', { hasText: 'kill.read_only' });
  await row.getByRole('button', { name: /Turn on/ }).click();
  await expect(row.getByText('ON', { exact: true })).toBeVisible();
  await row.getByRole('button', { name: /Turn off/ }).click();
  await expect(row.getByText('ON', { exact: true })).toBeHidden();
  // A fresh login counts as a recent second factor (5 min), so only the confirm + reason prompts appear here;
  // the stale-session 🔐 path is exercised by tests/smoke/admin.ts.
  expect(dialogs.some((m) => /reason/i.test(m))).toBe(true);
});
