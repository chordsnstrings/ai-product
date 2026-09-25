/**
 * Keyboard-first console (plan 05 header "dense variant … keyboard-first"). Pure helpers, shared by the client
 * keyboard layer (components/keys.tsx) and its tests.
 *
 *  g then a letter   go to a module (only modules the staff member's roles can open)
 *  /                 focus the page's search field, or open the command palette where there is none
 *  ⌘K / Ctrl+K       command palette: jump to a module, or look up a tenant / user / audit entries
 *  j / k, ↓ / ↑      move between table rows;  Enter  opens the row's first link
 *  ?                 keyboard help
 */
export const GOTO: Record<string, string> = {
  p: '/',
  a: '/approvals',
  t: '/tenants',
  u: '/users',
  r: '/retention',
  f: '/funnel',
  o: '/offers',
  e: '/email',
  b: '/billing',
  l: '/ledger',
  j: '/jobs',
  q: '/qa',
  v: '/providers',
  c: '/claims',
  d: '/privacy',
  s: '/staff',
  x: '/audit',
};

/** The module a `g` chord goes to, if the staff member can open it. */
export function gotoTarget(key: string, allowed: ReadonlySet<string>): string | null {
  const href = GOTO[key.toLowerCase()];
  return href && allowed.has(href) ? href : null;
}

/** Keys typed into a field (or with a modifier) are the field's, never a shortcut. */
export function isTyping(target: { tagName?: string; isContentEditable?: boolean } | null | undefined): boolean {
  if (!target) return false;
  const tag = (target.tagName ?? '').toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || !!target.isContentEditable;
}

/** Row cursor movement, clamped to the table (no row focused yet: j starts at the first row, k at the last). */
export function moveRow(current: number, delta: 1 | -1, count: number): number {
  if (count <= 0) return -1;
  if (current < 0) return delta > 0 ? 0 : count - 1;
  return Math.max(0, Math.min(count - 1, current + delta));
}

export interface PaletteItem {
  label: string;
  href: string;
  hint?: string;
}

/**
 * Command palette entries for a query: lookups first (tenant, user, audit), then the modules whose label or group
 * matches. A uuid, email, Stripe customer or shop domain is a lookup; plain words also match module names.
 */
export function paletteItems(query: string, nav: { group: string; items: { href: string; label: string }[] }[]): PaletteItem[] {
  const q = query.trim();
  const out: PaletteItem[] = [];
  const allowed = new Set(nav.flatMap((g) => g.items.map((i) => i.href)));
  if (q) {
    const enc = encodeURIComponent(q);
    if (allowed.has('/tenants')) out.push({ label: `Find tenant “${q}”`, href: `/tenants?q=${enc}`, hint: 'name, slug, id, member email, cus_…, shop' });
    if (allowed.has('/users')) out.push({ label: `Find user “${q}”`, href: `/users?q=${enc}`, hint: 'email, name or id' });
    if (allowed.has('/audit')) out.push({ label: `Audit entries for “${q}”`, href: `/audit?q=${enc}` });
  }
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  for (const g of nav) {
    for (const i of g.items) {
      const hay = `${g.group} ${i.label}`.toLowerCase();
      if (words.every((w) => hay.includes(w))) out.push({ label: i.label, href: i.href, hint: g.group });
    }
  }
  // Lookups are the likely intent for an id or an email; module names for plain words.
  const looksLikeId = /@|^[0-9a-f-]{8,}$|^cus_|\.myshopify\.com$/i.test(q);
  return looksLikeId ? out : [...out.filter((x) => !x.href.includes('?')), ...out.filter((x) => x.href.includes('?'))];
}
