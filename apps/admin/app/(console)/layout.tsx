import type { ReactNode } from 'react';
import { staffCan } from '@arkiv/core';
import { withAdmin } from '@arkiv/db';
import { Nav } from '@/components/nav';
import { requireStaff } from '@/lib/staff';
import { NAV } from '@/lib/nav';

/** Dense console chrome: grouped left nav filtered by role; pending approvals count; kill-switch warning. */
export default async function ConsoleLayout({ children }: { children: ReactNode }) {
  const s = await requireStaff();
  const { pending, kills } = await withAdmin(async (tx) => ({
    pending: Number((await tx`select count(*)::int as n from approvals where status = 'pending' and requested_by <> ${s.staffId}`)[0]!.n),
    kills: (await tx`select key from feature_flags where key like 'kill.%' and enabled`).map((r) => r.key as string),
  }));
  const nav = NAV.map((g) => ({ group: g.group, items: g.items.filter((i) => staffCan(s.roles, i.perm)) })).filter((g) => g.items.length);
  return (
    <div className="ak-shell">
      <Nav nav={nav} staff={{ name: s.name, roles: s.roles }} pending={pending} />
      <main className="ak-main" style={{ maxWidth: 1400 }}>
        {kills.length ? <div className="ak-banner ak-banner--risk" style={{ marginBottom: 16 }}>Kill switch active: {kills.join(', ')}</div> : null}
        {children}
      </main>
    </div>
  );
}
