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
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
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

/**
 * WCAG 1.4.10 reflow / 1.4.4 resize: at 320 CSS px (400% zoom) and 640 px (200% zoom) the rail is hidden, so the
 * console must offer the same navigation through the Menu button, without horizontal page scroll.
 */
for (const width of [320, 640]) {
  test(`console navigation stays reachable at ${width}px`, async ({ page }) => {
    const c = staffCreds();
    await page.setViewportSize({ width, height: 800 });
    await page.goto(`${ADMIN}/login`);
    await page.getByLabel('Email').fill(c.email);
    await page.getByLabel('Password').fill(c.password);
    await page.getByLabel('Authenticator code').fill(totp(c.secret));
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Platform Pulse' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Console', exact: true })).toBeHidden();
    await page.getByRole('button', { name: /^Menu/ }).click();
    const menu = page.getByRole('dialog', { name: 'Console' });
    await expect(menu).toBeVisible();
    await menu.getByRole('link', { name: 'Tenants' }).click();
    await expect(page.getByRole('heading', { name: 'Tenants' })).toBeVisible();
    await expect(menu).toBeHidden();
    await expect(page.getByLabel('Search tenants')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no horizontal page scroll').toBe(true);
    await page.getByRole('button', { name: /^Menu/ }).click();
    await menu.getByRole('link', { name: 'Audit log' }).click();
    await expect(page.getByRole('heading', { name: 'Audit log' })).toBeVisible();
  });
}
