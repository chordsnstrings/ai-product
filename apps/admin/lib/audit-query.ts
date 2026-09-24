import type { Tx } from '@arkiv/db';

/** Audit log filters (plan 05 §0.4). The page and the CSV export share them, so an export matches the screen. */
export interface AuditFilters {
  q?: string | null;
  staff?: string | null;
  ws?: string | null;
}

export const auditFilters = (p: URLSearchParams | Record<string, string | undefined>): AuditFilters => {
  const get = (k: string) => (p instanceof URLSearchParams ? p.get(k) : p[k]) ?? '';
  return { q: get('q').trim(), staff: get('staff').trim(), ws: get('ws').trim() };
};

export function auditRows(tx: Tx, f: AuditFilters, limit: number) {
  const q = f.q ?? '';
  const staff = f.staff ?? '';
  const ws = f.ws ?? '';
  return tx`select a.*, s.name, s.email from admin_audit_log a left join staff_users s on s.id = a.staff_id
    where (${q} = '' or a.action ilike ${'%' + q + '%'} or a.target_id = ${q})
      and (${staff} = '' or s.email ilike ${'%' + staff + '%'})
      and (${ws} = '' or a.workspace_id::text = ${ws})
    order by a.id desc limit ${limit}`;
}

/** One changed field between an audit row's `before` and `after` (nested objects flattened to a.b.c paths). */
export interface FieldChange {
  path: string;
  before: unknown;
  after: unknown;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Field-level diff of two JSON values; arrays and scalars compare as whole values. */
export function jsonDiff(before: unknown, after: unknown, path = ''): FieldChange[] {
  if (isObj(before) && isObj(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    return keys.flatMap((k) => jsonDiff(before[k], after[k], path ? `${path}.${k}` : k));
  }
  if (isObj(before) && after === undefined) return jsonDiff(before, {}, path);
  if (isObj(after) && before === undefined) return jsonDiff({}, after, path);
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  return [{ path: path || '(value)', before, after }];
}
