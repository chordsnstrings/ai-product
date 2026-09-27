import { assertFreshReauth } from '@arkiv/auth';
import { assertStaff } from '@arkiv/core';
import { DomainError } from '@arkiv/shared';
import { ACTIONS, type ActionName } from '@/lib/actions';
import { assertSameOrigin, body, errorResponse, json } from '@/lib/http';
import { apiStaff } from '@/lib/staff';

export async function POST(req: Request, { params }: { params: Promise<{ action: string }> }) {
  try {
    assertSameOrigin(req);
    const { action } = await params;
    const def = ACTIONS[action as ActionName];
    if (!def) throw new DomainError('NOT_FOUND', 'Unknown action');
    const s = await apiStaff();
    assertStaff(s, def.perm);
    if ('reauth' in def && def.reauth) assertFreshReauth(s);
    const input = await body(req, def.schema as never);
    const result = await (def.run as (s: unknown, i: unknown) => Promise<unknown>)(s, input);
    return json((result && typeof result === 'object' ? result : { ok: true, result }) as object);
  } catch (e) {
    return errorResponse(e);
  }
}
