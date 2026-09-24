import { withAdmin } from '@arkiv/db';
import { audit, staffCan } from '@arkiv/core';
import { auditFilters, auditRows } from '@/lib/audit-query';
import { currentStaff } from '@/lib/staff';

const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;

/** Plan 05 §0.4 CSV export: the same q / staff / workspace filters as the audit page; the export is itself audited. */
export async function GET(req: Request) {
  const s = await currentStaff();
  if (!s || !staffCan(s.roles, 'audit.read')) return new Response('Not found', { status: 404 });
  const f = auditFilters(new URL(req.url).searchParams);
  const rows = await withAdmin(async (tx) => {
    await audit(tx, s, 'audit.export', { type: 'audit', id: null }, { after: f });
    return auditRows(tx, f, 50000);
  });
  const head = ['id', 'at', 'staff', 'roles', 'action', 'target_type', 'target_id', 'workspace_id', 'reason', 'before', 'after', 'ip', 'user_agent'];
  const body = [head.join(','), ...rows.map((r) => [r.id, new Date(r.at as string).toISOString(), r.email, (r.staff_roles as string[] | null)?.join('|'), r.action, r.target_type, r.target_id, r.workspace_id, r.reason, JSON.stringify(r.before ?? ''), JSON.stringify(r.after ?? ''), r.ip, r.user_agent].map(esc).join(','))].join('\n');
  return new Response(body, { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="arkiv-audit-${new Date().toISOString().slice(0, 10)}.csv"` } });
}
