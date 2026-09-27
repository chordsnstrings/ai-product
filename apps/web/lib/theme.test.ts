import { describe, expect, it } from 'vitest';
import { parseTheme, themeCookie } from './theme';

describe('theme preference', () => {
  it('forces only light or dark; anything else follows the system', () => {
    expect(parseTheme('light')).toBe('light');
    expect(parseTheme('dark')).toBe('dark');
    expect(parseTheme('system')).toBeNull();
    expect(parseTheme('')).toBeNull();
    expect(parseTheme(undefined)).toBeNull();
    expect(parseTheme('dark; injected')).toBeNull();
  });

  it('keeps a choice for a year and clears it for "system"', () => {
    expect(themeCookie('dark')).toBe('arkiv_theme=dark; Path=/; SameSite=Lax; Max-Age=31536000');
    expect(themeCookie('system')).toBe('arkiv_theme=; Path=/; SameSite=Lax; Max-Age=0');
  });
});
