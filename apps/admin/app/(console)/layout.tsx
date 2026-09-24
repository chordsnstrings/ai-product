import type { ReactNode } from 'react';
import { staffCan } from '@arkiv/core';
import { withAdmin } from '@arkiv/db';
import { Nav } from '@/components/nav';
import { requireStaff } from '@/lib/staff';
import { NAV } from '@/lib/nav';
import { consolePrefs, TIMEZONES } from '@/lib/prefs';

/** Dense console chrome: grouped nav filtered by role (rail, or a menu sheet when narrow); console-wide range,
 * timezone and test-account preferences; pending approvals count; kill-switch warning. */
export default async function ConsoleLayout({ children }: { children: ReactNode }) {
  const s = await requireStaff();
  const prefs = await consolePrefs();
  const { pending, kills, drift } = await withAdmin(async (tx) => ({
    pending: Number((await tx`select count(*)::int as n from approvals where status = 'pending' and requested_by <> ${s.staffId}`)[0]!.n),
    kills: (await tx`select key from feature_flags where key like 'kill.%' and enabled`).map((r) => r.key as string),
    // Plan 05 §10 version drift: a pinned route answered with another model version (raised by the gateway).
    drift: (await tx`select subject_id from platform_alerts where kind = 'version_drift' and resolved_at is null order by created_at`).map((r) => r.subject_id as string),
  }));
  const nav = NAV.map((g) => ({ group: g.group, items: g.items.filter((i) => staffCan(s.roles, i.perm)) })).filter((g) => g.items.length);
  return (
    <div className="ak-shell">
      <Nav nav={nav} staff={{ name: s.name, roles: s.roles }} pending={pending} prefs={{ ...prefs, timezones: TIMEZONES }} />
      <main className="ak-main" style={{ maxWidth: 1400 }}>
        {kills.length ? <div className="ak-banner ak-banner--risk" style={{ marginBottom: 16 }}>Kill switch active: {kills.join(', ')}</div> : null}
        {drift.length ? <div className="ak-banner ak-banner--risk" style={{ marginBottom: 16 }}>Model version drift on {drift.join(', ')} — <a href="/providers">check routes</a>.</div> : null}
        {children}
      </main>
    </div>
  );
}
