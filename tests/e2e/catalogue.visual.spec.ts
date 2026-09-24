import { expect, test } from '@playwright/test';

/**
 * Design §8 visual regression: Playwright screenshots of the catalogue page (/internal/catalogue) per component
 * section and theme. Baselines are committed (Linux Chromium) under tests/e2e/__screenshots__; after an
 * intended visual change, refresh them with `pnpm e2e catalogue.visual --update-snapshots`.
 */
const SECTIONS = ['tokens', 'type', 'buttons', 'inputs', 'index-rows', 'specimens', 'metadata', 'chips', 'rail', 'ledger', 'banners', 'offer', 'sheets', 'upload', 'frames', 'dense-table', 'example-asset'];

for (const theme of ['light', 'dark'] as const) {
  test.describe(`catalogue · ${theme}`, () => {
    // The OS setting and the catalogue's own switch agree; reduced motion keeps entrance animations out of the shot.
    test.use({ colorScheme: theme, reducedMotion: 'reduce', viewport: { width: 1280, height: 900 } });

    test(`every section matches its baseline (${theme})`, async ({ page }) => {
      await page.goto(`/internal/catalogue?theme=${theme}`);
      await expect(page.getByRole('heading', { level: 1, name: 'The catalogue' })).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      await expect(page.locator('[data-catalogue-section]')).toHaveCount(SECTIONS.length);
      for (const id of SECTIONS) {
        const section = page.locator(`[data-catalogue-section="${id}"]`);
        await section.scrollIntoViewIfNeeded();
        await expect.soft(section).toHaveScreenshot(`${id}-${theme}.png`, { animations: 'disabled', caret: 'hide', mask: [page.locator('[data-catalogue-volatile]')] });
      }
    });
  });
}

test('the catalogue theme switch re-themes portalled sheets too', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/internal/catalogue?theme=dark');
  await page.getByRole('button', { name: 'Open a sheet' }).click();
  const sheet = page.getByRole('dialog', { name: /Edit this scene/ });
  await expect(sheet).toBeVisible();
  await expect(sheet).toHaveAttribute('data-theme', 'dark');
  const bg = await sheet.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bg).toBe('rgb(28, 27, 25)'); // dark --paper-raised
});

test('confirmation sheets replace the browser dialogs', async ({ page }) => {
  page.on('dialog', () => {
    throw new Error('native dialog');
  });
  await page.goto('/internal/catalogue?theme=light');
  await page.getByRole('button', { name: 'Confirm with a reason' }).click();
  const sheet = page.getByRole('dialog', { name: 'Turn on this kill switch?' });
  await expect(sheet.getByRole('button', { name: 'Turn on' })).toBeDisabled();
  await sheet.getByLabel('Reason (recorded in the audit log)').fill('drill');
  await sheet.getByRole('button', { name: 'Turn on' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Reason: drill' })).toBeVisible();
  await page.getByRole('button', { name: 'Confirm (danger)' }).click();
  await page.getByRole('dialog', { name: 'Remove this file?' }).getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Cancelled' })).toBeVisible();
});

test('ledger steps say their status in words and announce changes', async ({ page }) => {
  await page.goto('/internal/catalogue?theme=light');
  const ledger = page.locator('[data-catalogue-section="ledger"] .ak-ledger');
  await expect(ledger.locator('li[data-status="active"]')).toContainText('in progress');
  await expect(ledger.locator('li[data-status="failed"]')).toContainText('failed');
  await expect(ledger).not.toHaveAttribute('aria-live', /.*/);
  await page.getByRole('button', { name: 'Complete “Checking accuracy”' }).click();
  await expect(page.locator('#ak-announcer')).toHaveText('Checking accuracy — done');
});

test('provenance chips show source and time on focus', async ({ page }) => {
  await page.goto('/internal/catalogue?theme=light');
  const chip = page.getByRole('button', { name: /^Observed · product page · 23 Sep 2026 14:02 ET$/ });
  await chip.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(page.getByText('Observed · product page · 23 Sep 2026 14:02 ET', { exact: true }).last()).toBeVisible();
});
