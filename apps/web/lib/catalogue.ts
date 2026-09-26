/** The design-system catalogue (/internal/catalogue, design §3) is a dev tool: on in dev/test, opt-in in production. */
export function catalogueEnabled(e: { NODE_ENV: string; CATALOGUE_ENABLED?: string }): boolean {
  return e.NODE_ENV !== 'production' || e.CATALOGUE_ENABLED === '1';
}

/** `?theme=dark` / `?theme=light` pins the catalogue's theme (visual regression); anything else follows the system. */
export function catalogueTheme(v: string | string[] | undefined): 'light' | 'dark' | null {
  return v === 'light' || v === 'dark' ? v : null;
}
