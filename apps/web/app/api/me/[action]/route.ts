import { z } from 'zod';
import { globalTx } from '@arkiv/db';
import { assertRecentLogin, revokeAllSessions, revokeSession } from '@arkiv/auth';
import { deleteUser } from '@arkiv/core';
import { DomainError } from '@arkiv/shared';
import { body, json, route } from '@/lib/http';
import { currentUser } from '@/lib/session';

/** User-level profile actions (not workspace-scoped). */
export const POST = route(async (req, { params }: { params: Promise<{ action: string }> }) => {
  const u = await currentUser();
  if (!u) throw new DomainError('UNAUTHENTICATED', 'Please log in.');
  const { action } = await params;
  switch (action) {
    case 'name': {
      const { name } = await body(req, z.object({ name: z.string().trim().min(1).max(80) }));
      await globalTx((tx) => tx`update users set name = ${name} where id = ${u.userId}`);
      return json({ ok: true });
    }
    case 'session-revoke': {
      const { id } = await body(req, z.object({ id: z.string().uuid() }));
      await revokeSession(id, u.userId);
      return json({ ok: true, next: id === u.sessionId ? '/login' : null });
    }
    case 'sessions-revoke-others':
      await revokeAllSessions(u.userId, u.sessionId);
      return json({ ok: true });
    case 'passkey-delete': {
      const { id } = await body(req, z.object({ id: z.string().uuid() }));
      await globalTx((tx) => tx`delete from passkeys where id = ${id} and user_id = ${u.userId}`);
      return json({ ok: true });
    }
    case 'delete-account': {
      // Standard §40 / plan 02 §7: type-to-confirm and a recent sign-in (M14 step-up).
      const { confirm } = await body(req, z.object({ confirm: z.string() }));
      if (confirm.trim().toLowerCase() !== u.email.toLowerCase()) throw new DomainError('INVALID', 'Type your email address to confirm.');
      assertRecentLogin(u);
      await deleteUser(u.userId, { by: 'self' });
      return json({ ok: true, next: '/' });
    }
    default:
      throw new DomainError('NOT_FOUND', 'Unknown action');
  }
});
