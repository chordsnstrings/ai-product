import Link from 'next/link';
import { notFound } from 'next/navigation';
import { withAdmin } from '@arkiv/db';
import { audit, shouldMaskPii } from '@arkiv/core';
import { geoLabel, type EdgeGeo } from '@arkiv/shared';
import { ActButton } from '@/components/act';
import { dt, Mono, Page, Section, Table } from '@/components/ui';
import { piiView } from '@/lib/mask';
import { requireStaff } from '@/lib/staff';

export const metadata = { title: 'User' };

/**
 * Plan 05 §3. Staff can lock, force logout, resend verification and send a sign-in link (the reset: a password is
 * optional and set by the user from Profile) — never set a credential. Sign-in history (one row per session, with
 * its method) and failed sign-ins show the edge's location. SUPPORT sees PII
 * masked (§0.2) unless they hold break-glass on one of the user's workspaces.
 */
export default async function User({ params }: { params: Promise<{ id: string }> }) {
  const s = await requireStaff('users.read');
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const d0 = await withAdmin(async (tx) => {
    const [u] = await tx`select * from users where id = ${id}`;
    if (!u) return null;
    const [bg] = await tx`select 1 from break_glass_sessions b join memberships m on m.workspace_id = b.workspace_id and m.user_id = ${id}
                          where b.staff_id = ${s.staffId} and b.ended_at is null and b.expires_at > now() limit 1`;
    await audit(tx, s, 'user.view', { type: 'user', id });
    return {
      u,
      bg: !!bg,
      ws: await tx`select w.id, w.name, w.slug, m.role from memberships m join workspaces w on w.id = m.workspace_id where m.user_id = ${id}`,
      // §3 "login history": every sign-in is a session row (how, when, from where), newest first.
      sessions: await tx`select id, ip, user_agent, geo, method, created_at, last_seen_at, revoked_at, expires_at from sessions where user_id = ${id} order by created_at desc limit 50`,
      // §3 "failed logins": every refused sign-in for this account (by user or by its address).
      failed: await tx`select method, outcome, reason, ip, user_agent, geo, at from login_attempts where user_id = ${id} or email = ${u.email} order by at desc limit 50`,
      idents: await tx`select provider, email, created_at from user_identities where user_id = ${id}`,
      links: await tx`select purpose, created_at, consumed_at, expires_at, created_ip from magic_links where email = ${u.email} order by created_at desc limit 20`,
      emails: await tx`select template, status, created_at from email_log where to_email = ${u.email} order by created_at desc limit 30`,
    };
  });
  if (!d0) notFound();
  const { u } = d0;
  const pii = piiView(shouldMaskPii(s.roles, d0.bg));
  return (
    <Page title={pii.email(u.email)} sub={<><Mono>{id}</Mono> · {u.locked_at ? `locked: ${u.locked_reason}` : 'active'} · verified {dt(u.email_verified_at)}{pii.mask ? ' · PII masked for your role' : ''}</>} actions={
      <>
        <ActButton action="user.force_logout" payload={{ userId: id }} reason>Force logout everywhere</ActButton>
        {!u.locked_at && !u.email_verified_at ? <ActButton action="user.resend_verification" payload={{ userId: id }} reason="Why (ticket #)">Resend verification</ActButton> : null}
        {!u.locked_at ? <ActButton action="user.send_login_link" payload={{ userId: id }} reason="Why (ticket #) — a sign-in link is the reset; the user can then change their password in Profile">Send sign-in link</ActButton> : null}
        {u.locked_at ? <ActButton action="user.unlock" payload={{ userId: id }} reason>🔐 Unlock</ActButton> : <ActButton danger action="user.lock" payload={{ userId: id }} reason="Why (e.g. account takeover suspicion, ticket #)">🔐 Lock account</ActButton>}
      </>
    }>
      <Section title="Workspaces"><Table head={['Workspace', 'Role']} rows={d0.ws.map((w) => [<Link key="w" href={`/tenants/${w.id}`}>{w.name as string} <span className="ak-muted">({w.slug as string})</span></Link>, String(w.role).toLowerCase()])} /></Section>
      <Section title="Sign-in methods"><Table head={['Provider', 'Email', 'Linked']} rows={[...d0.idents.map((i) => [i.provider as string, i.email ? pii.email(i.email) : '—', dt(i.created_at)]), ...(u.password_set_at ? [['password', '—', dt(u.password_set_at)]] : [])]} /></Section>
      <Section title="Terms"><p className="ak-small">{u.terms_accepted_at ? <>Accepted Terms {String(u.terms_version)} and Privacy {String(u.privacy_version)} on {dt(u.terms_accepted_at)} by creating the account{u.terms_method ? ` (${String(u.terms_method).replace('_', ' ')})` : ''}.</> : 'No acceptance recorded (account created before acceptance was logged).'}</p></Section>
      <Section title={`Sign-in history (${d0.sessions.length})`}><Table head={['Signed in', 'Method', 'Last seen', 'IP', 'Location', 'Device', 'Status']} rows={d0.sessions.map((x) => [dt(x.created_at), x.method ? String(x.method).replace('_', ' ') : '—', dt(x.last_seen_at), <Mono key="i">{pii.ip(x.ip)}</Mono>, geoLabel(x.geo as EdgeGeo | null) || '—', <span key="d" className="ak-small">{pii.mask ? pii.ua(x.user_agent) : String(x.user_agent ?? '').slice(0, 70)}</span>, x.revoked_at ? 'signed out' : new Date(x.expires_at as string) < new Date() ? 'expired' : 'active'])} empty="No sign-ins yet." /></Section>
      <Section title={`Failed sign-ins (${d0.failed.length})`}><Table head={['When', 'Method', 'Outcome', 'Reason', 'IP', 'Location', 'Device']} rows={d0.failed.map((f) => [dt(f.at), String(f.method).replace('_', ' '), f.outcome as string, <span key="r" className="ak-small">{f.reason as string}</span>, <Mono key="i">{pii.ip(f.ip)}</Mono>, geoLabel(f.geo as EdgeGeo | null) || '—', <span key="d" className="ak-small">{pii.ua(f.user_agent)}</span>])} empty="No failed sign-ins." /></Section>
      <Section title="Login links"><Table head={['Sent', 'Purpose', 'Used', 'IP']} rows={d0.links.map((l) => [dt(l.created_at), l.purpose as string, l.consumed_at ? dt(l.consumed_at) : new Date(l.expires_at as string) < new Date() ? 'expired' : 'unused', <Mono key="i">{pii.ip(l.created_ip)}</Mono>])} /></Section>
      <Section title="Email"><Table head={['When', 'Template', 'Status']} rows={d0.emails.map((e) => [dt(e.created_at), e.template as string, e.status as string])} /></Section>
    </Page>
  );
}
