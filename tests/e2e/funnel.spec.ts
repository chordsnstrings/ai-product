import { expect, test } from '@playwright/test';
import { a11yFloor, fixture, magicLinkFor } from './helpers';

/**
 * The whole conversion funnel in a real browser (plan 03 P1–P10): anonymous upload → live cataloguing →
 * three concepts → save gate (magic link) → storyboard with honest offer → mock Stripe → production → exports.
 */
test('anonymous visitor to delivered ad', async ({ page }) => {
  await page.goto('/');
  await a11yFloor(page);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

  // P2: photo upload, no account.
  await page.locator('input[type=file][multiple]').setInputFiles(fixture('serum.jpg'));
  await page.getByRole('button', { name: /Analyze my product/ }).click();
  await page.waitForURL(/\/start\/[0-9a-f-]{36}/);
  const projectId = page.url().split('/').pop()!;

  // P3 cataloguing stream (plan 06 Phase 1 #9): server-sent events carrying the live project view.
  const streamed = await page.evaluate(
    (id) =>
      new Promise<{ id: string; steps: number }>((resolve, reject) => {
        const es = new EventSource(`/api/projects/${id}/stream`);
        const t = setTimeout(() => (es.close(), reject(new Error('no stream event'))), 20_000);
        es.addEventListener('project', (e) => {
          clearTimeout(t);
          es.close();
          const v = JSON.parse((e as MessageEvent<string>).data) as { project: { id: string }; steps: unknown[] };
          resolve({ id: v.project.id, steps: v.steps.length });
        });
      }),
    projectId,
  );
  expect(streamed.id).toBe(projectId);
  expect(streamed.steps).toBeGreaterThan(0);

  // P3/P4: real progress, then confirmation.
  await expect(page.getByText('Cataloguing your product').or(page.getByRole('link', { name: /show me 3 ad ideas/ }))).toBeVisible();
  const toConcepts = page.getByRole('link', { name: /show me 3 ad ideas/ });
  await expect(toConcepts).toBeVisible({ timeout: 180_000 });
  await a11yFloor(page);
  await toConcepts.click();

  // P5: three concepts, one marked as our pick.
  await page.waitForURL(`**/concepts/${projectId}`);
  const build = page.getByRole('button', { name: 'Build this storyboard' });
  await expect(build).toHaveCount(3);
  await expect(page.getByText('Our pick')).toBeVisible();
  await build.first().click();

  // P6: save gate — value first, then a light ask.
  await expect(page.getByRole('dialog', { name: /^Save .+ and see its storyboard$/ })).toBeVisible();
  const email = `e2e-${Date.now()}@example.com`;
  await page.getByLabel('Work email').fill(email);
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
  await expect(page.getByRole('dialog').getByText(email)).toBeVisible();
  const link = await magicLinkFor(email);
  await page.goto(link);
  // Scanner-safe (plan 03 Part C): loading the link consumes nothing; pressing Continue does.
  await expect(page.getByRole('heading', { name: 'Sign in to Arkiv' })).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();

  // Signed in: the idea picked before the save gate is carried through — its storyboard starts without choosing again.
  await page.waitForURL(`**/storyboard/${projectId}`);
  const makeAd = page.locator('#offer').getByRole('link', { name: /Make my ad/ });
  await expect(makeAd).toBeVisible({ timeout: 180_000 });
  await expect(page.locator('#offer')).toContainText('One-time — no subscription');
  await expect(page.locator('.ak-timer')).toBeVisible(); // server-issued intro expiry
  await a11yFloor(page);

  // Each frame's caption and controls are laid out below the image, not clipped by the frame.
  const editWords = page.getByRole('button', { name: 'Edit words' }).first();
  await editWords.scrollIntoViewIfNeeded();
  await expect(editWords).toBeInViewport();
  await expect(page.getByRole('button', { name: /Lock scene 1/ })).toHaveAttribute('aria-pressed', 'false');

  // Free, claim-checked edit.
  await editWords.click();
  await page.getByLabel('Spoken line').fill('Cures acne overnight');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('alert')).toContainText(/drug claim/i);
  await page.getByLabel('Spoken line').fill('Skin feels soft and looks dewy.');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();

  // P8: checkout (mock Stripe in dev/test).
  await makeAd.click();
  await page.waitForURL(/\/checkout\/mock\//);
  await page.getByRole('button', { name: 'Pay with test card' }).click();

  // P9 → P10.
  await page.waitForURL(/\/(produce|deliver)\//);
  await expect(page.getByRole('heading', { name: 'Your ad is ready' })).toBeVisible({ timeout: 420_000 });
  await expect(page.getByRole('link', { name: /MP4/ })).toHaveCount(3);
  await expect(page.locator('video')).toBeVisible();
  await a11yFloor(page);
});
