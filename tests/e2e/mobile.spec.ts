import { expect, test } from '@playwright/test';
import { a11yFloor } from './helpers';

/** Phone-first landing (plan 04 L19): upload reachable in the hero, sticky CTA after it scrolls away, no sideways scroll. */
test('landing works on a phone', async ({ page }) => {
  await page.goto('/for/texture?utm_source=tiktok&utm_content=texture-demo');
  await a11yFloor(page);
  await expect(page.getByRole('button', { name: /Analyze my product/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Take a photo' })).toBeVisible();
  await page.mouse.wheel(0, 3000);
  await expect(page.locator('.ak-sticky[data-show="true"]')).toBeVisible();
});

test('pricing is honest on a phone', async ({ page }) => {
  await page.goto('/pricing');
  await a11yFloor(page);
  await expect(page.getByText('Recommended')).toBeVisible();
  await expect(page.getByText(/Cancel/).first()).toBeVisible();
});
