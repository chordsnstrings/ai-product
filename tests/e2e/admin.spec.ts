import { expect, test } from '@playwright/test';
import { staffCreds, totp } from './helpers';

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
  await page.getByRole('link', { name: 'Tenants' }).click();
  await expect(page.getByRole('heading', { name: 'Tenants' })).toBeVisible();
  await page.getByRole('link', { name: 'Flags & config' }).click();
  // Turning a kill switch on asks for a fresh authenticator code, then a reason.
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
  expect(dialogs.some((m) => /authenticator/i.test(m))).toBe(true);
});
