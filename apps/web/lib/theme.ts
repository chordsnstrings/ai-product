/**
 * The app's manual light/dark choice (design §2.1: "the app follows the system setting with a manual toggle").
 * Stored per browser in a plain preference cookie — no account data — and read by the workspace layout.
 */
export const THEME_COOKIE = 'arkiv_theme';
export type ThemeChoice = 'system' | 'light' | 'dark';

/** A forced theme, or null to follow the system setting. Anything unexpected means "system". */
export function parseTheme(v: string | null | undefined): 'light' | 'dark' | null {
  return v === 'light' || v === 'dark' ? v : null;
}

/** The Set-Cookie value for a choice: a year for light/dark, cleared for "system". */
export function themeCookie(choice: ThemeChoice): string {
  const base = `${THEME_COOKIE}=${choice === 'system' ? '' : choice}; Path=/; SameSite=Lax`;
  return choice === 'system' ? `${base}; Max-Age=0` : `${base}; Max-Age=${365 * 86400}`;
}
