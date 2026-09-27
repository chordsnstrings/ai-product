import { createHmac, timingSafeEqual } from 'node:crypto';
import { render } from '@react-email/render';
import { globalTx, withTenant, type Tx } from '@arkiv/db';
import { env } from '@arkiv/shared';
import { build, isDigest, PROMOTIONAL_TEMPLATES, REQUIRED_TEMPLATES, type DigestKind, type TemplateMap, type TemplateName } from './templates';

/**
 * Email via Resend (decided). Transactional and marketing streams use separate sending subdomains; marketing
 * respects suppressions, unsubscribes and frequency caps (plan 05 §18). Every send carries an idempotency key
 * (Resend Idempotency-Key header + unique email_log row), so retries never double-send.
 */

export interface SendOptions {
  idempotencyKey: string;
  workspaceId?: string | null;
  /** A digest's signed "turn off" link for this recipient (List-Unsubscribe header and footer). */
  optOutUrl?: string | null;
}

export interface SendResult {
  status: 'sent' | 'suppressed' | 'duplicate' | 'logged' | 'capped' | 'paused';
  providerId?: string | null;
}

/** Dev/test outbox so flows (e.g. magic links) are testable without a provider. */
export const devOutbox: { to: string; template: string; subject: string; html: string; data: unknown }[] = [];

async function resendClient() {
  const { Resend } = await import('resend');
  return new Resend(env().RESEND_API_KEY);
}

/**
 * Templates whose link is a credential (sign-in, invite, signed download, ownership confirmation). Their link is
 * never stored with the email log, and they can't be resent from the log: the console issues a fresh one instead
 * (resend invite, send login link).
 */
export const SECRET_LINK_TEMPLATES: ReadonlySet<TemplateName> = new Set(['magic_link', 'invite', 'export_ready', 'ownership_transfer_confirm', 'staff_invite']);
export const REDACTED_LINK = '[single-use link — not stored]';

/** The template data kept on email_log (plan 05 §2.2 Emails "Resend, view rendered email"), minus credentials. */
export function storedEmailData(template: TemplateName, data: unknown): Record<string, unknown> {
  const d = { ...((data ?? {}) as Record<string, unknown>) };
  if (SECRET_LINK_TEMPLATES.has(template)) for (const k of ['url', 'exportUrl']) if (k in d) d[k] = REDACTED_LINK;
  return d;
}
export const canResendTemplate = (template: string) => isTemplateName(template) && !SECRET_LINK_TEMPLATES.has(template);

// Every template, as a record so a new template can't be left out.
const TEMPLATE_NAMES: Record<TemplateName, true> = {
  magic_link: true, invite: true, receipt: true, asset_ready: true, offer_ending: true, storyboard_saved: true, new_concept: true,
  export_ready: true, refund_issued: true, flag_expired: true, integration_disconnected: true, integration_expiring: true, shop_transfer_request: true, claim_review_result: true,
  claim_evidence_request: true, sku_out_of_scope: true, claims_guidance: true, media_review_result: true,
  cancellation_confirmed: true, plan_ended_payment_failed: true, subscription_started: true, price_change_notice: true, payment_failed: true, security_alert: true,
  weekly_brief: true, friday_summary: true, signal_update: true, day30_review: true, rights_expired: true, production_delayed: true, staff_break_glass: true, ownership_transfer_confirm: true, intervention: true,
  staff_invite: true, review_text_erased: true, invoice_receipt: true, qa_needs_you: true, plan_ended: true, purge_scheduled: true,
};
export const isTemplateName = (t: string): t is TemplateName => Object.hasOwn(TEMPLATE_NAMES, t);

/** Render a template to what the recipient saw (subject + HTML), for the console's email view. */
export async function renderEmail<T extends TemplateName>(template: T, data: TemplateMap[T], opts: { supportEmail?: string | null; unsubscribeUrl?: string | null } = {}) {
  const built = build(template, data, { supportEmail: opts.supportEmail ?? null, unsubscribeUrl: opts.unsubscribeUrl ?? null });
  return { subject: built.subject, stream: built.stream, html: await render(built.element as never) };
}

/** Log outcomes of an email that never reached the provider: shown in the console, retried under the same key. */
export const NOT_SENT_STATUSES = ['queued', 'failed', 'suppressed', 'capped', 'paused'] as const;

/** Sends to a hard-bouncing address still attempted: the person is actively trying to sign in or secure the account. */
const BOUNCE_EXEMPT: ReadonlySet<TemplateName> = new Set(['magic_link', 'security_alert']);

/** The provider call, replaceable in tests (a stub standing in for Resend). */
export interface EmailTransport {
  send(
    msg: { from: string; to: string; subject: string; html: string; text: string; headers?: Record<string, string> },
    opts: { idempotencyKey: string },
  ): Promise<{ data?: { id?: string | null } | null; error?: { message: string } | null }>;
}
let transportOverride: EmailTransport | null = null;
export function setEmailTransportForTests(t: EmailTransport | null) {
  transportOverride = t;
}
async function transport(): Promise<EmailTransport | null> {
  if (transportOverride) return transportOverride;
  if (!env().RESEND_API_KEY) return null;
  const client = await resendClient();
  return { send: (msg, o) => client.emails.send(msg, o) as never };
}

/**
 * Should this address get this template (plan 05 §18)? Each suppression row is one fact:
 *  - hard bounce (stream 'all'): nothing but sign-in and security mail is attempted;
 *  - unsubscribe or marketing complaint (stream 'marketing'): no promotional email (recovery reminders included);
 *  - transactional complaint: only the required notices (receipts, billing, security, deletion) still go out.
 */
export function suppressionBlocks(template: TemplateName, rows: readonly { stream: string }[]): boolean {
  if (rows.some((r) => r.stream === 'all') && !BOUNCE_EXEMPT.has(template)) return true;
  if (PROMOTIONAL_TEMPLATES.has(template)) return rows.some((r) => r.stream === 'marketing');
  return rows.some((r) => r.stream === 'transactional') && !REQUIRED_TEMPLATES.has(template);
}

/** Is mail to this address known not to arrive (a hard bounce)? The invite form tells the inviter at once. */
export async function addressBouncing(email: string): Promise<boolean> {
  const [r] = await globalTx((t) => t`select 1 from email_suppressions where email = ${email.trim().toLowerCase()} and stream = 'all' limit 1`);
  return !!r;
}

export async function sendEmail<T extends TemplateName>(template: T, to: string, data: TemplateMap[T], opts: SendOptions, tx?: Tx): Promise<SendResult> {
  const built = build(template, data);
  const email = to.trim().toLowerCase();
  // A send for a workspace runs in that tenant's context (the log row must match it); others need none. With a
  // caller's transaction everything runs in it; otherwise the log row is committed before the provider call and the
  // outcome is recorded in its own statement, so a failed send stays visible (and a retry resends under its key).
  const inTx = <R>(fn: (t: Tx) => Promise<R>): Promise<R> => (tx ? fn(tx) : opts.workspaceId ? withTenant(opts.workspaceId, fn) : globalTx(fn));

  const opened = await inTx(async (t) => {
    const sups = await t`select stream from email_suppressions where email = ${email}`;
    let blocked: 'suppressed' | 'paused' | null = suppressionBlocks(template, sups as unknown as { stream: string }[]) ? 'suppressed' : null;
    // Complaint-rate guard (plan 05 §18): while the marketing stream is paused, marketing email isn't sent at all.
    if (!blocked && built.stream === 'marketing' && (await marketingPaused(t))) blocked = 'paused';
    // email_log is tenant-scoped (RLS); the log row, the marketing frequency cap (per address, across workspaces,
    // serialized per address) and the dedupe go through a narrow SECURITY DEFINER function. Every outcome is logged.
    const [open] = await t`select id, outcome from email_log_open(${opts.workspaceId ?? null}, ${email}, ${template}, ${built.stream}, ${opts.idempotencyKey},
                                                                  ${t.json(storedEmailData(template, data) as never)}, ${blocked})`;
    // Footer support address is a platform setting (plan 05 §20); omitted when unset.
    const [supportRow] = await t`select value from platform_settings where key = 'support.email'`;
    const support = typeof supportRow?.value === 'string' && supportRow.value.includes('@') ? (supportRow.value as string) : null;
    return { id: (open!.id as string | null) ?? null, outcome: open!.outcome as string, support };
  });
  if (opened.outcome !== 'opened') return { status: opened.outcome as SendResult['status'] };
  const id = opened.id!;
  const mark = (status: string, providerId: string | null, event: Record<string, unknown> | null) =>
    inTx((t) => t`select email_log_mark(${id}, ${status}, ${providerId}, ${event ? t.json(event as never) : null})`);

  const unsubscribeUrl = PROMOTIONAL_TEMPLATES.has(template) ? unsubscribeLink(email) : isDigest(template) ? (opts.optOutUrl ?? null) : null;
  const element = build(template, data, { supportEmail: opened.support, unsubscribeUrl }).element;
  const html = await render(element as never);
  const text = await render(element as never, { plainText: true });
  const provider = await transport();
  if (!provider) {
    devOutbox.push({ to: email, template, subject: built.subject, html, data });
    if (devOutbox.length > 200) devOutbox.shift();
    if (env().NODE_ENV === 'development') console.info(`[email:dev] ${template} → ${email}: ${built.subject}`, JSON.stringify(data));
    // Local/e2e: optional JSONL outbox so browser tests can follow magic links across processes.
    if (process.env.EMAIL_DEV_FILE && env().NODE_ENV !== 'production') {
      const { appendFile } = await import('node:fs/promises');
      await appendFile(process.env.EMAIL_DEV_FILE, `${JSON.stringify({ at: new Date().toISOString(), to: email, template, subject: built.subject, data })}\n`).catch(() => {});
    }
    await mark('logged', null, null);
    return { status: 'logged' };
  }
  const from = built.stream === 'marketing' ? env().EMAIL_FROM.replace('@mail.', '@news.') : env().EMAIL_FROM;
  let r: Awaited<ReturnType<EmailTransport['send']>>;
  try {
    r = await provider.send(
      {
        from,
        to: email,
        subject: built.subject,
        html,
        text,
        headers: unsubscribeUrl ? { 'List-Unsubscribe': `<${unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } : undefined,
      },
      { idempotencyKey: opts.idempotencyKey },
    );
  } catch (e) {
    r = { error: { message: (e as Error).message } };
  }
  if (r.error) {
    await mark('failed', null, { at: new Date().toISOString(), error: r.error.message });
    throw new Error(`resend: ${r.error.message}`);
  }
  await mark('sent', r.data?.id ?? null, null);
  return { status: 'sent', providerId: r.data?.id ?? null };
}

/**
 * The recipient's unsubscribe link (apps/web/app/api/unsubscribe): an RFC 8058 one-click POST from the mail
 * client unsubscribes directly; a GET (a click, or a link scanner) only opens a confirmation page.
 */
export function unsubscribeLink(email: string): string {
  return `${env().APP_URL}/api/unsubscribe?t=${encodeURIComponent(signUnsub(email))}`;
}

export function signUnsub(email: string) {
  const sig = createHmac('sha256', env().APP_SECRET).update(`unsub:${email}`).digest('base64url').slice(0, 22);
  return `${Buffer.from(email).toString('base64url')}.${sig}`;
}
export function verifyUnsub(token: string): string | null {
  const [b, sig] = token.split('.');
  if (!b || !sig) return null;
  const email = Buffer.from(b, 'base64url').toString('utf8');
  return signUnsub(email) === token ? email : null;
}

export async function unsubscribe(email: string) {
  // Its own row: a bounce or complaint on the same address is a separate fact (clearing it never re-subscribes).
  await globalTx((t) => t`insert into email_suppressions (email, reason, stream) values (${email.trim().toLowerCase()}, 'unsubscribed', 'marketing')
                            on conflict (email, stream, reason) do nothing`);
}

// ───────────── Digest opt-out (plan 03 A10 "Weekly"; stored apart from suppressions) ─────────────

export interface DigestOptOut {
  workspaceId: string;
  userId: string;
  kind: DigestKind;
}

const digestSig = (payload: string) => createHmac('sha256', env().APP_SECRET).update(`digest:${payload}`).digest('base64url').slice(0, 22);

/** A signed token naming one member, one workspace and one digest: the link turns off exactly that email. */
export function signDigestOptOut(o: DigestOptOut): string {
  const payload = Buffer.from(JSON.stringify([o.workspaceId, o.userId, o.kind])).toString('base64url');
  return `${payload}.${digestSig(payload)}`;
}

export function verifyDigestOptOut(token: string): DigestOptOut | null {
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = digestSig(payload);
  if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const [workspaceId, userId, kind] = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as [string, string, string];
    if (typeof workspaceId !== 'string' || typeof userId !== 'string' || !isDigest(kind)) return null;
    return { workspaceId, userId, kind };
  } catch {
    return null;
  }
}

/** The one-click "turn off" URL for a digest (apps/web/app/api/notifications/opt-out). */
export function digestOptOutLink(o: DigestOptOut): string {
  return `${env().APP_URL}/api/notifications/opt-out?t=${encodeURIComponent(signDigestOptOut(o))}`;
}

/** Turn one digest on or off for a member of a workspace (Profile settings, or the email's link). */
export async function setDigestPreference(o: DigestOptOut, enabled: boolean): Promise<void> {
  await withTenant(o.workspaceId, (t) => t`insert into notification_prefs (workspace_id, user_id, kind, enabled)
                                            select ${o.workspaceId}, ${o.userId}, ${o.kind}, ${enabled}
                                            where exists (select 1 from memberships where workspace_id = ${o.workspaceId} and user_id = ${o.userId})
                                            on conflict (workspace_id, user_id, kind) do update set enabled = excluded.enabled, updated_at = now()`);
}

/**
 * Resend webhooks are signed Svix-style: base64(HMAC-SHA256(secret, `${id}.${timestamp}.${body}`)).
 * Bounces and complaints feed suppression; complaint rate is monitored in admin (plan 05 §18).
 */
export function verifyResendWebhook(body: string, headers: { id: string | null; timestamp: string | null; signature: string | null }): boolean {
  const secret = env().RESEND_WEBHOOK_SECRET;
  if (!secret || !headers.id || !headers.timestamp || !headers.signature) return false;
  if (Math.abs(Date.now() / 1000 - Number(headers.timestamp)) > 300) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expected = createHmac('sha256', key).update(`${headers.id}.${headers.timestamp}.${body}`).digest('base64');
  return headers.signature.split(' ').some((s) => {
    const v = s.split(',')[1] ?? '';
    const a = Buffer.from(v);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  });
}

/** Complaint rate above this (30 days, marketing stream) pauses marketing sends (plan 05 §18). */
export const MARKETING_COMPLAINT_THRESHOLD = 0.001;

/** Is the marketing stream paused (setting `email.marketing_paused` holds the pause record; null/absent = running)? */
export async function marketingPaused(t: Tx): Promise<boolean> {
  const [p] = await t`select value from platform_settings where key = 'email.marketing_paused'`;
  return !!p && typeof p.value === 'object' && p.value !== null;
}

export interface ResendEvent {
  type: string;
  created_at?: string;
  data: { email_id?: string; to?: string[]; bounce?: { type?: string } };
}

/**
 * One Resend delivery event (standard §47 "Duplicate webhook"). The status only moves forward (queued → sent →
 * delivered → opened → clicked; a bounce or complaint is final), so a late or repeated event can't regress it, and
 * an event is appended to the log once per delivery id (Svix `svix-id`).
 */
export async function handleResendEvent(evt: ResendEvent, deliveryId?: string | null) {
  await globalTx(async (t) => {
    let stream: string | null = null;
    if (evt.data.email_id) {
      const entry = { type: evt.type, at: evt.created_at ?? new Date().toISOString(), ...(deliveryId ? { id: deliveryId } : {}) };
      await t`select email_log_event(${evt.data.email_id}, ${evt.type.replace('email.', '')}, ${t.json(entry)})`;
      const [l] = await t`select stream from email_log_lookup(${evt.data.email_id})`;
      stream = (l?.stream as string | undefined) ?? null;
    }
    const hardBounce = evt.type === 'email.bounced' && !/transient|soft/i.test(evt.data.bounce?.type ?? '');
    // A hard bounce stops every stream (the mailbox doesn't exist); a soft one suppresses nothing.
    if (hardBounce) {
      for (const to of evt.data.to ?? []) {
        await t`insert into email_suppressions (email, reason, stream) values (${to.toLowerCase()}, 'hard_bounce', 'all') on conflict (email, stream, reason) do nothing`;
      }
    }
    // A complaint suppresses the stream it came from (plan 05 §18): one about a marketing email stops marketing
    // only; one about a transactional email stops the optional notices, never receipts, billing or security mail.
    // Unknown origin (no log row) is treated as marketing.
    if (evt.type === 'email.complained') {
      const from = stream === 'transactional' ? 'transactional' : 'marketing';
      for (const to of evt.data.to ?? []) {
        await t`insert into email_suppressions (email, reason, stream) values (${to.toLowerCase()}, 'complaint', ${from}) on conflict (email, stream, reason) do nothing`;
      }
    }
    // A hard bounce on an Owner's address raises the tenant banner; a later delivery to it clears it (plan 05 §18).
    if (hardBounce || evt.type === 'email.delivered') {
      for (const to of evt.data.to ?? []) await t`select email_owner_bounce(${to.toLowerCase()}, ${hardBounce})`;
    }
    // Each marketing complaint re-checks the 30-day marketing complaint rate; above the threshold marketing pauses (audited).
    if (evt.type === 'email.complained' && stream !== 'transactional') await t`select email_marketing_complaint_check(${MARKETING_COMPLAINT_THRESHOLD})`;
  });
}
