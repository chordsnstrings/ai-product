import { createHmac } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { expect, type Page } from '@playwright/test';

const root = new URL('../../', import.meta.url).pathname;
export const fixture = (name: string) => `${root}tests/e2e/fixtures/${name}`;

/** Follow the dev JSONL outbox (EMAIL_DEV_FILE) for the newest magic link sent to `email`. */
export async function magicLinkFor(email: string, timeoutMs = 20_000): Promise<string> {
  const file = process.env.EMAIL_DEV_FILE || `${root}.storage/e2e-mail.jsonl`;
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (existsSync(file)) {
      const hit = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { to: string; template: string; data: { url: string } })
        .filter((m) => m.to === email && m.template === 'magic_link').pop();
      if (hit) return hit.data.url;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`no magic link for ${email} (is the web server running with EMAIL_DEV_FILE?)`);
}

export function staffCreds(): { email: string; password: string; secret: string } {
  return JSON.parse(readFileSync(`${root}.storage/e2e-staff.json`, 'utf8'));
}

/** RFC 6238 TOTP (SHA-1, 30s, 6 digits) — same as the staff login. */
export function totp(secretB32: string, t = Date.now()) {
  const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of secretB32.replace(/=+$/, '').toUpperCase()) bits += B32.indexOf(c).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(t / 30_000)));
  const h = createHmac('sha1', key).update(counter).digest();
  const o = h[h.length - 1]! & 0xf;
  return ((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0');
}

/** Minimal accessibility floor on every page we visit (full audits run in CI with axe separately). */
export async function a11yFloor(page: Page) {
  expect(await page.getAttribute('html', 'lang')).toBe('en');
  const unlabeledImages = await page.locator('img:not([alt])').count();
  expect(unlabeledImages, 'images without alt').toBe(0);
  const noHorizontalScroll = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  expect(noHorizontalScroll, 'no horizontal page scroll').toBe(true);
  await headingOutline(page);
}

/** WCAG 1.3.1 / 2.4.6: exactly one h1 and no skipped heading levels (an h2 section, then h3 inside it). */
export async function headingOutline(page: Page) {
  const levels = await page.evaluate(() =>
    Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6'))
      .filter((h) => (h as HTMLElement).offsetParent !== null || getComputedStyle(h).position === 'fixed')
      .map((h) => Number(h.tagName.slice(1))),
  );
  expect(levels.filter((l) => l === 1), `one h1 on ${page.url()}`).toHaveLength(1);
  levels.reduce((prev, l) => {
    expect(l - prev, `heading h${l} after h${prev} skips a level on ${page.url()}`).toBeLessThanOrEqual(1);
    return l;
  }, 1);
}
