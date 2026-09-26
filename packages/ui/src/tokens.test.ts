import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { contrast } from './contrast';

/**
 * Design §2.1 / §5: colour token pairs are checked for WCAG AA in CI — text ≥ 4.5:1, non-text UI (the input
 * border, WCAG 1.4.11) ≥ 3:1 — in both the light ("Paper") and dark ("Ink") themes.
 */
const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

function block(selector: string, from = 0): Record<string, string> {
  const i = css.indexOf(`${selector} {`, from);
  if (i < 0) throw new Error(`no block for ${selector}`);
  const body = css.slice(css.indexOf('{', i) + 1, css.indexOf('}', i));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) out[m[1]!] = m[2]!.trim().toLowerCase();
  return out;
}

const light = block(':root');
const darkMedia = block(":root:not([data-theme='light'])", css.indexOf('@media (prefers-color-scheme: dark)'));
const dark = block("[data-theme='dark']", css.indexOf('}\n}', css.indexOf('@media (prefers-color-scheme: dark)')));
const lightForced = block("[data-theme='light']", css.indexOf("/* Marketing surfaces"));

const COLOURS = ['paper', 'paper-raised', 'paper-sunk', 'ink', 'ink-2', 'stone', 'stone-text', 'rule', 'rule-strong', 'rule-input', 'accent', 'accent-ink', 'signal-gathering', 'signal-directional', 'signal-actionable', 'risk', 'risk-soft'];
const TEXT = ['ink', 'ink-2', 'stone-text', 'accent', 'signal-directional', 'signal-actionable', 'risk'];
const SURFACES = ['paper', 'paper-raised', 'paper-sunk'];

describe('design tokens', () => {
  it('parses every colour token in each theme block', () => {
    for (const t of [light, dark, lightForced]) for (const k of COLOURS) expect(t[k], k).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('keeps the OS-dark block identical to the manual dark theme', () => {
    expect(darkMedia).toEqual(dark);
  });

  it('keeps the forced-light block identical to the default light colours', () => {
    for (const k of COLOURS) expect(lightForced[k], k).toBe(light[k]);
  });

  for (const [name, t] of [['light', light], ['dark', dark]] as const) {
    describe(`${name} theme`, () => {
      it('text tokens reach 4.5:1 on every paper surface', () => {
        for (const fg of TEXT) for (const bg of SURFACES) expect(contrast(t[fg]!, t[bg]!), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      });

      it('filled chips, buttons and banners reach 4.5:1', () => {
        expect(contrast(t['accent-ink']!, t.accent!), 'accent-ink on accent').toBeGreaterThanOrEqual(4.5);
        expect(contrast(t.paper!, t.ink!), 'paper on ink (DEC chip, primary button)').toBeGreaterThanOrEqual(4.5);
        expect(contrast(t.paper!, t['signal-actionable']!), 'paper on actionable (verified claim chip)').toBeGreaterThanOrEqual(4.5);
        expect(contrast(t.paper!, t.risk!), 'paper on risk (danger button)').toBeGreaterThanOrEqual(4.5);
        expect(contrast(t.risk!, t['risk-soft']!), 'risk on risk-soft').toBeGreaterThanOrEqual(4.5);
        expect(contrast(t.ink!, t['risk-soft']!), 'ink on risk-soft (risk banner)').toBeGreaterThanOrEqual(4.5);
      });

      it('input borders reach 3:1 against the input fill (WCAG 1.4.11)', () => {
        expect(contrast(t['rule-input']!, t['paper-raised']!)).toBeGreaterThanOrEqual(3);
      });
    });
  }

  it('computes the WCAG ratio', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrast('#777777', '#ffffff')).toBeCloseTo(4.48, 2);
  });
});
