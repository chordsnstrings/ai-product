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
  // Turning a kill switch on asks for confirmation and a reason in the console's confirmation sheet (never the
  // browser's own dialogs), and a fresh code if 2FA is older than 5 min.
  page.on('dialog', () => {
    throw new Error('native browser dialog used instead of the confirmation sheet');
  });
  const answer = async (confirmName: RegExp) => {
    const sheet = page.getByRole('dialog');
    await expect(sheet).toBeVisible();
    await sheet.getByLabel(/reason/i).fill('e2e toggle');
    await sheet.getByRole('button', { name: confirmName }).click();
    await expect(sheet).toBeHidden();
  };
  const row = page.locator('tr', { hasText: 'kill.read_only' });
  await row.getByRole('button', { name: /Turn on/ }).click();
  await expect(page.getByRole('dialog', { name: /Turn ON this kill switch/ })).toBeVisible();
  await answer(/Turn on/);
  await expect(row.getByText('ON', { exact: true })).toBeVisible();
  await row.getByRole('button', { name: /Turn off/ }).click();
  await answer(/Turn off/);
  await expect(row.getByText('ON', { exact: true })).toBeHidden();
  // A fresh login counts as a recent second factor (5 min), so only the confirm + reason sheet appears here;
  // the stale-session 🔐 path is exercised by tests/smoke/admin.ts.
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
    const menu = page.getByRole('dialog', { name: 'Console' });
    // The button works once the page has hydrated; retry the click until the sheet opens.
    const openMenu = () => expect(async () => {
      await page.getByRole('button', { name: /^Menu/ }).click();
      await expect(menu).toBeVisible({ timeout: 1000 });
    }).toPass();
    await openMenu();
    await menu.getByRole('link', { name: 'Tenants' }).click();
    await expect(page.getByRole('heading', { name: 'Tenants' })).toBeVisible();
    await expect(menu).toBeHidden();
    await expect(page.getByLabel('Search tenants')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no horizontal page scroll').toBe(true);
    await openMenu();
    await menu.getByRole('link', { name: 'Audit log' }).click();
    await expect(page.getByRole('heading', { name: 'Audit log' })).toBeVisible();
  });
}
