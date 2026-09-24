import type { ReactNode } from 'react';
import { apiVersions, setting, staffCan, upcomingSunsets } from '@arkiv/core';
import { withAdmin } from '@arkiv/db';
import { ConfirmHost, Toaster } from '@arkiv/ui/client';
import { Nav } from '@/components/nav';
import { requireStaff } from '@/lib/staff';
import { NAV } from '@/lib/nav';
import { consolePrefs, TIMEZONES } from '@/lib/prefs';

/** Dense console chrome: grouped nav filtered by role (rail, or a menu sheet when narrow); console-wide range,
 * timezone and test-account preferences; pending approvals count; kill-switch warning. */
export default async function ConsoleLayout({ children }: { children: ReactNode }) {
  const s = await requireStaff();
  const prefs = await consolePrefs();
  const { pending, kills, drift, sunsets } = await withAdmin(async (tx) => ({
    pending: Number((await tx`select count(*)::int as n from approvals where status = 'pending' and requested_by <> ${s.staffId}`)[0]!.n),
    kills: (await tx`select key from feature_flags where key like 'kill.%' and enabled`).map((r) => r.key as string),
    // Plan 05 §10 version drift: a pinned route answered with another model version (raised by the gateway).
    drift: (await tx`select subject_id from platform_alerts where kind = 'version_drift' and resolved_at is null order by created_at`).map((r) => r.subject_id as string),
    // Plan 05 §16: platform API versions nearing their sunset (dates kept in integrations.api_versions).
    sunsets: upcomingSunsets(await apiVersions(tx), await setting(tx, 'integrations.sunset_banner_days')),
  }));
  const nav = NAV.map((g) => ({ group: g.group, items: g.items.filter((i) => staffCan(s.roles, i.perm)) })).filter((g) => g.items.length);
  return (
    <div className="ak-shell">
      <Nav nav={nav} staff={{ name: s.name, roles: s.roles }} pending={pending} prefs={{ ...prefs, timezones: TIMEZONES }} />
      <main className="ak-main" style={{ maxWidth: 1400 }}>
        {kills.length ? <div className="ak-banner ak-banner--risk" style={{ marginBottom: 16 }}>Kill switch active: {kills.join(', ')}</div> : null}
        {sunsets.length ? (
          <div className="ak-banner ak-banner--warn" style={{ marginBottom: 16 }}>
            {sunsets.map((v) => `${v.api} ${v.version} ${v.daysLeft > 0 ? `is sunset in ${v.daysLeft} day${v.daysLeft === 1 ? '' : 's'}` : 'is past its sunset date'} (${v.sunsetOn})`).join(' · ')} — contract tests must pass on the new version before the switch flag is enabled. <a href="/integrations">Integrations</a>
          </div>
        ) : null}
        {drift.length ? <div className="ak-banner ak-banner--risk" style={{ marginBottom: 16 }}>Model version drift on {drift.join(', ')} — <a href="/providers">check routes</a>.</div> : null}
        {children}
      </main>
      <ConfirmHost />
      <Toaster />
    </div>
  );
}
