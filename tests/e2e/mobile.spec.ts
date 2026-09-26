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

/** WCAG 2.4.7 / 4.1.2: the hidden sticky CTA is inert — Tab never lands on it while it is off-screen. */
test('hidden sticky CTA is out of the tab order', async ({ page }) => {
  await page.goto('/for/texture');
  const sticky = page.locator('.ak-sticky');
  await expect(sticky).toHaveAttribute('data-show', 'false');
  await expect(sticky).toHaveAttribute('inert', '');
  // Tabbing scrolls the page, so the sticky may legitimately appear; focus may only land in it once it is shown.
  for (let i = 0; i < 25; i++) {
    await page.keyboard.press('Tab');
    const inHidden = await page.evaluate(() => document.activeElement?.closest('.ak-sticky')?.getAttribute('data-show') === 'false');
    expect(inHidden, 'focus inside the hidden sticky CTA').toBe(false);
  }
  await page.mouse.wheel(0, 3000);
  await expect(sticky).toHaveAttribute('data-show', 'true');
  await expect(sticky).not.toHaveAttribute('inert', /.*/);
});

/**
 * Design §5 touch targets: every button, button-styled link, text button and chip control in the main content
 * offers at least a 44×44 hit area on a phone (its box, or the invisible ::before hit area of text buttons).
 */
for (const path of ['/', '/start', '/internal/catalogue?theme=light']) {
  test(`touch targets are at least 44×44 on ${path}`, async ({ page }) => {
    await page.goto(path);
    const small = await page.evaluate(() => {
      const out: string[] = [];
      const els = document.querySelectorAll<HTMLElement>('main button, main [role="button"], main a.ak-btn, main a.ak-textbtn, main a.ak-chip');
      for (const el of els) {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height || el.closest('[inert]') || getComputedStyle(el).visibility === 'hidden') continue;
        const b = getComputedStyle(el, '::before');
        const hit = b.content !== 'none' && b.position === 'absolute' ? { w: parseFloat(b.width) || 0, h: parseFloat(b.height) || 0 } : { w: 0, h: 0 };
        const w = Math.max(r.width, hit.w);
        const h = Math.max(r.height, hit.h);
        if (w < 43.5 || h < 43.5) out.push(`${el.tagName.toLowerCase()} “${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 40)}” ${Math.round(w)}×${Math.round(h)}`);
      }
      return out;
    });
    expect(small, 'targets under 44×44').toEqual([]);
  });
}
