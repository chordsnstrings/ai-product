import { z } from 'zod';
import { globalTx } from '@arkiv/db';
import { assertRecentLogin, removePassword, requestMagicLink, revokeAllSessions, revokeSession, rotateSession, securityNotice, setPassword } from '@arkiv/auth';
import { deleteUser, recordFunnel } from '@arkiv/core';
import { DomainError } from '@arkiv/shared';
import { body, clientIp, json, route } from '@/lib/http';
import { currentUser, setSessionCookie } from '@/lib/session';

/** User-level profile actions (not workspace-scoped). */
export const POST = route(async (req, { params }: { params: Promise<{ action: string }> }) => {
  const u = await currentUser();
  if (!u) throw new DomainError('UNAUTHENTICATED', 'Please log in.');
  const { action } = await params;
  /** A sign-in method changed: new session token for this browser, every other session signed out (plan 03 Part C). */
  const privilegeChanged = async () => {
    const s = await rotateSession(u.sessionId, u.userId);
    await setSessionCookie(s.token);
    await revokeAllSessions(u.userId, s.sessionId);
  };
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
      const gone = await globalTx((tx) => tx`delete from passkeys where id = ${id} and user_id = ${u.userId} returning name`);
      if (gone.length) {
        const s = await rotateSession(u.sessionId, u.userId);
        await setSessionCookie(s.token);
        await securityNotice(u.userId, `Passkey removed (${(gone[0]!.name as string) ?? 'Passkey'})`, `passkey-delete:${id}`);
      }
      return json({ ok: true });
    }
    case 'passkey-prompt': {
      // The post-purchase passkey suggestion (plan 06 Phase 3 #8): shown (funnel event) or dismissed for good.
      const { event } = await body(req, z.object({ event: z.enum(['shown', 'dismissed']) }));
      if (event === 'dismissed') await globalTx((tx) => tx`update users set passkey_prompt_dismissed_at = coalesce(passkey_prompt_dismissed_at, now()) where id = ${u.userId}`);
      else await recordFunnel('PASSKEY_PROMPT_SHOWN', { workspaceId: u.lastWorkspaceId, props: {} });
      return json({ ok: true });
    }
    case 'password-set': {
      // Standard §34 optional password. Setting or changing it needs a recent sign-in (M14 step-up) and signs out
      // every other session.
      const { password } = await body(req, z.object({ password: z.string().max(200) }));
      assertRecentLogin(u);
      const [had] = await globalTx((tx) => tx`select password_hash is not null as has from users where id = ${u.userId}`);
      await setPassword(u.userId, password);
      await privilegeChanged();
      await securityNotice(u.userId, had?.has ? 'Password changed' : 'Password added', `password-set:${u.sessionId}:${Date.now()}`);
      return json({ ok: true });
    }
    case 'password-remove': {
      assertRecentLogin(u);
      await removePassword(u.userId);
      await privilegeChanged();
      await securityNotice(u.userId, 'Password removed', `password-remove:${u.sessionId}:${Date.now()}`);
      return json({ ok: true });
    }
    case 'identity-unlink': {
      // Disconnect Google/Apple from Profile. The emailed link always remains, so an account is never left
      // without a way in; the address it goes to must still be yours.
      const { provider } = await body(req, z.object({ provider: z.enum(['google', 'apple']) }));
      assertRecentLogin(u);
      const gone = await globalTx((tx) => tx`delete from user_identities where user_id = ${u.userId} and provider = ${provider} returning email`);
      if (!gone.length) throw new DomainError('NOT_FOUND', 'That sign-in method isn’t connected.');
      await privilegeChanged();
      await securityNotice(u.userId, `${provider === 'google' ? 'Google' : 'Apple'} sign-in disconnected`, `unlink:${provider}:${u.sessionId}:${Date.now()}`);
      return json({ ok: true });
    }
    case 'step-up': {
      // "Confirm it's you": an emailed link that signs this person in afresh, then returns to where they were.
      const { next } = await body(req, z.object({ next: z.string().max(300).nullish() }));
      await requestMagicLink({ email: u.email, purpose: 'step_up', redirectTo: next ?? null, ip: clientIp(req) });
      return json({ ok: true, sentTo: u.email });
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
