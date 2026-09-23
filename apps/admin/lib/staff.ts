import { cookies, headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { getStaffSession, STAFF_COOKIE, type StaffSession } from '@arkiv/auth';
import { staffCan, type Permission, type Staff } from '@arkiv/core';
import { DomainError } from '@arkiv/shared';

export type StaffUser = Staff & { sessionId: string; reauthAt: Date };

async function meta() {
  const h = await headers();
  return { ip: h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? h.get('x-real-ip') ?? null, userAgent: h.get('user-agent') };
}

const toStaff = async (s: StaffSession): Promise<StaffUser> => ({ staffId: s.staffId, email: s.email, name: s.name, roles: s.roles, sessionId: s.sessionId, reauthAt: s.reauthAt, ...(await meta()) });

export async function currentStaff(): Promise<StaffUser | null> {
  const s = await getStaffSession((await cookies()).get(STAFF_COOKIE)?.value);
  return s ? toStaff(s) : null;
}

/** Page guard: no session → login; missing permission → 404 (modules a role can't use don't exist for it). */
export async function requireStaff(perm?: Permission): Promise<StaffUser> {
  const s = await currentStaff();
  if (!s) redirect('/login');
  if (perm && !staffCan(s.roles, perm)) notFound();
  return s;
}

/** API guard. */
export async function apiStaff(): Promise<StaffUser> {
  const s = await currentStaff();
  if (!s) throw new DomainError('UNAUTHENTICATED', 'Session expired. Sign in again.');
  return s;
}
