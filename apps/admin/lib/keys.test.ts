import { describe, expect, it } from 'vitest';
import { GOTO, gotoTarget, isTyping, moveRow, paletteItems } from './keys';
import { NAV } from './nav';

const nav = NAV.map((g) => ({ group: g.group, items: g.items.map(({ href, label }) => ({ href, label })) }));

describe('keyboard-first console (plan 05 dense variant)', () => {
  it('every g-chord goes to a real module, and only to modules the staff member can open', () => {
    const hrefs = new Set(nav.flatMap((g) => g.items.map((i) => i.href)));
    for (const href of Object.values(GOTO)) expect(hrefs.has(href), href).toBe(true);
    expect(gotoTarget('t', hrefs)).toBe('/tenants');
    expect(gotoTarget('J', hrefs)).toBe('/jobs');
    expect(gotoTarget('t', new Set(['/jobs']))).toBeNull();
    expect(gotoTarget('z', hrefs)).toBeNull();
  });

  it('never takes keys typed into a field', () => {
    expect(isTyping({ tagName: 'input' })).toBe(true);
    expect(isTyping({ tagName: 'TEXTAREA' })).toBe(true);
    expect(isTyping({ tagName: 'DIV', isContentEditable: true })).toBe(true);
    expect(isTyping({ tagName: 'TR' })).toBe(false);
    expect(isTyping(null)).toBe(false);
  });

  it('moves the row cursor within the table', () => {
    expect(moveRow(-1, 1, 5)).toBe(0);
    expect(moveRow(-1, -1, 5)).toBe(4);
    expect(moveRow(4, 1, 5)).toBe(4);
    expect(moveRow(0, -1, 5)).toBe(0);
    expect(moveRow(2, 1, 5)).toBe(3);
    expect(moveRow(0, 1, 0)).toBe(-1);
  });

  it('palette: lookups for ids and emails first, modules for words, limited to what the role can open', () => {
    const byEmail = paletteItems('jo@example.com', nav);
    expect(byEmail[0]).toMatchObject({ href: '/tenants?q=jo%40example.com' });
    expect(byEmail.map((x) => x.href)).toContain('/users?q=jo%40example.com');
    expect(paletteItems('ledger', nav)[0]).toMatchObject({ href: '/ledger', label: 'Ledger & COGS' });
    expect(paletteItems('', nav).length).toBe(nav.flatMap((g) => g.items).length);
    const support = [{ group: 'Customers', items: [{ href: '/tenants', label: 'Tenants' }] }];
    expect(paletteItems('acme', support).map((x) => x.href)).toEqual(['/tenants?q=acme']);
  });
});
