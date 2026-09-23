import { withAdmin } from '@arkiv/db';
import { audit, staffCan } from '@arkiv/core';
import { currentStaff } from '@/lib/staff';

const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;

export async function GET(req: Request) {
  const s = await currentStaff();
  if (!s || !staffCan(s.roles, 'audit.read')) return new Response('Not found', { status: 404 });
  const q = new URL(req.url).searchParams;
  const rows = await withAdmin(async (tx) => {
    await audit(tx, s, 'audit.export', { type: 'audit', id: null }, { reason: q.toString() });
    return tx`select a.id, a.at, s.email, a.staff_roles, a.action, a.target_type, a.target_id, a.workspace_id, a.reason, a.before, a.after, a.ip, a.user_agent
              from admin_audit_log a left join staff_users s on s.id = a.staff_id where (${q.get('ws') ?? ''} = '' or a.workspace_id::text = ${q.get('ws') ?? ''}) order by a.id desc limit 50000`;
  });
  const head = ['id', 'at', 'staff', 'roles', 'action', 'target_type', 'target_id', 'workspace_id', 'reason', 'before', 'after', 'ip', 'user_agent'];
  const body = [head.join(','), ...rows.map((r) => [r.id, new Date(r.at as string).toISOString(), r.email, (r.staff_roles as string[] | null)?.join('|'), r.action, r.target_type, r.target_id, r.workspace_id, r.reason, JSON.stringify(r.before ?? ''), JSON.stringify(r.after ?? ''), r.ip, r.user_agent].map(esc).join(','))].join('\n');
  return new Response(body, { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="arkiv-audit-${new Date().toISOString().slice(0, 10)}.csv"` } });
}
