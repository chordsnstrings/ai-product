import { withAdmin } from '@arkiv/db';
import { audit, setting, staffCan } from '@arkiv/core';
import { consolePrefs } from '@/lib/prefs';
import { currentStaff } from '@/lib/staff';
import { tenantFilters, tenantRows } from '@/lib/tenants-query';

const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;

/**
 * Plan 05 §2.1 "export CSV (metadata only)": the tenant list with the page's filters. No member emails, no
 * tenant content. The export is audited with the filters used.
 */
export async function GET(req: Request) {
  const s = await currentStaff();
  if (!s || !staffCan(s.roles, 'tenant.read')) return new Response('Not found', { status: 404 });
  const f = tenantFilters(Object.fromEntries(new URL(req.url).searchParams));
  const prefs = await consolePrefs();
  const rows = await withAdmin(async (tx) => {
    const r = await tenantRows(tx, f, { limit: 10000, tz: prefs.tz, freeCapMicros: Number(await setting(tx, 'free_preview.cogs_cap_micros')) });
    await audit(tx, s, 'tenants.export', { type: 'module', id: 'tenants' }, { after: { filters: f, rows: r.length } });
    return r;
  });
  const head = ['id', 'name', 'slug', 'state', 'plan', 'created_at', 'last_active', 'skus', 'creative_tests_used', 'creative_tests_granted', 'creative_tests_available', 'revenue_30d_usd', 'cogs_30d_usd', 'cogs_cap_30d_usd', 'churn_risk_score', 'churn_risk_band', 'connections', 'vip', 'test', 'tags'];
  const usd = (micros: unknown) => (Number(micros ?? 0) / 1e6).toFixed(2);
  const body = [
    head.join(','),
    ...rows.map((r) =>
      [
        r.id, r.name, r.slug, r.state, r.plan_code, new Date(r.created_at as string).toISOString(), r.last_active ? new Date(r.last_active as string).toISOString() : '', r.skus,
        r.period ? r.tests_used : '', r.period ? r.tests_granted : '', r.tests_available, usd(r.rev30), usd(r.cogs30), usd(r.cogs_cap30), r.risk_score, r.risk_band,
        ((r.conns as { provider: string; status: string; fresh: boolean }[]) ?? []).map((c) => `${c.provider}:${c.fresh ? 'fresh' : c.status}`).join(' '),
        r.is_vip ? 'yes' : 'no', r.is_test ? 'yes' : 'no', ((r.tags as string[]) ?? []).join('|'),
      ].map(esc).join(','),
    ),
  ].join('\n');
  return new Response(body, { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="arkiv-tenants-${new Date().toISOString().slice(0, 10)}.csv"` } });
}
