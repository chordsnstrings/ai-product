import { createHmac, timingSafeEqual } from 'node:crypto';
import { render } from '@react-email/render';
import { globalTx, withTenant, type Tx } from '@arkiv/db';
import { env } from '@arkiv/shared';
import { build, type TemplateMap, type TemplateName } from './templates';

/**
 * Email via Resend (decided). Transactional and marketing streams use separate sending subdomains; marketing
 * respects suppressions, unsubscribes and frequency caps (plan 05 §18). Every send carries an idempotency key
 * (Resend Idempotency-Key header + unique email_log row), so retries never double-send.
 */

export interface SendOptions {
  idempotencyKey: string;
  workspaceId?: string | null;
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
export const SECRET_LINK_TEMPLATES: ReadonlySet<TemplateName> = new Set(['magic_link', 'invite', 'export_ready', 'ownership_transfer_confirm']);
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
  export_ready: true, refund_issued: true, flag_expired: true, integration_disconnected: true, claim_review_result: true,
  claim_evidence_request: true, sku_out_of_scope: true, claims_guidance: true, media_review_result: true,
  cancellation_confirmed: true, plan_ended_payment_failed: true, subscription_started: true, price_change_notice: true, payment_failed: true, security_alert: true,
  weekly_brief: true, friday_summary: true, signal_update: true, day30_review: true, staff_break_glass: true, ownership_transfer_confirm: true, intervention: true,
};
export const isTemplateName = (t: string): t is TemplateName => Object.hasOwn(TEMPLATE_NAMES, t);

/** Render a template to what the recipient saw (subject + HTML), for the console's email view. */
export async function renderEmail<T extends TemplateName>(template: T, data: TemplateMap[T], opts: { supportEmail?: string | null; unsubscribeUrl?: string | null } = {}) {
  const built = build(template, data, { supportEmail: opts.supportEmail ?? null, unsubscribeUrl: opts.unsubscribeUrl ?? null });
  return { subject: built.subject, stream: built.stream, html: await render(built.element as never) };
}

export async function sendEmail<T extends TemplateName>(template: T, to: string, data: TemplateMap[T], opts: SendOptions, tx?: Tx): Promise<SendResult> {
  const built = build(template, data);
  const run = async (t: Tx): Promise<SendResult> => {
    const email = to.trim().toLowerCase();
    const [sup] = await t`select stream from email_suppressions where email = ${email}`;
    if (sup && (sup.stream === 'all' || sup.stream === built.stream) && built.stream === 'marketing') return { status: 'suppressed' };
    if (sup && sup.stream === 'all' && built.stream === 'transactional' && template !== 'magic_link' && template !== 'security_alert') return { status: 'suppressed' };
    // Complaint-rate guard (plan 05 §18): while the marketing stream is paused, marketing email isn't sent at all.
    if (built.stream === 'marketing' && (await marketingPaused(t))) return { status: 'paused' };
    // email_log is tenant-scoped (RLS); the log row, the marketing frequency cap (per address, across
    // workspaces) and the dedupe go through a narrow SECURITY DEFINER function.
    const [open] = await t`select id, outcome from email_log_open(${opts.workspaceId ?? null}, ${email}, ${template}, ${built.stream}, ${opts.idempotencyKey}, ${t.json(storedEmailData(template, data) as never)})`;
    if (open!.outcome === 'capped') return { status: 'capped' };
    if (open!.outcome === 'duplicate') return { status: 'duplicate' };
    const ins = [{ id: open!.id as string }];
    // Footer support address is a platform setting (plan 05 §20); omitted when unset.
    const [supportRow] = await t`select value from platform_settings where key = 'support.email'`;
    const supportEmail = typeof supportRow?.value === 'string' && supportRow.value.includes('@') ? supportRow.value : null;
    const unsubscribeUrl = built.stream === 'marketing' ? unsubscribeLink(email) : null;
    const element = build(template, data, { supportEmail, unsubscribeUrl }).element;
    const html = await render(element as never);
    const text = await render(element as never, { plainText: true });
    if (!env().RESEND_API_KEY) {
      devOutbox.push({ to: email, template, subject: built.subject, html, data });
      if (devOutbox.length > 200) devOutbox.shift();
      if (env().NODE_ENV === 'development') console.info(`[email:dev] ${template} → ${email}: ${built.subject}`, JSON.stringify(data));
      // Local/e2e: optional JSONL outbox so browser tests can follow magic links across processes.
      if (process.env.EMAIL_DEV_FILE && env().NODE_ENV !== 'production') {
        const { appendFile } = await import('node:fs/promises');
        await appendFile(process.env.EMAIL_DEV_FILE, `${JSON.stringify({ at: new Date().toISOString(), to: email, template, subject: built.subject, data })}\n`).catch(() => {});
      }
      await t`select email_log_mark(${ins[0]!.id}, 'logged', null, null)`;
      return { status: 'logged' };
    }
    const from = built.stream === 'marketing' ? env().EMAIL_FROM.replace('@mail.', '@news.') : env().EMAIL_FROM;
    const r = await (await resendClient()).emails.send(
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
    if (r.error) {
      await t`select email_log_mark(${ins[0]!.id}, 'failed', null, ${t.json({ at: new Date().toISOString(), error: r.error.message })})`;
      throw new Error(`resend: ${r.error.message}`);
    }
    await t`select email_log_mark(${ins[0]!.id}, 'sent', ${r.data?.id ?? null}, null)`;
    return { status: 'sent', providerId: r.data?.id ?? null };
  };
  // A send for a workspace runs in that tenant's context (the log row must match it); others need none.
  return tx ? run(tx) : opts.workspaceId ? withTenant(opts.workspaceId, run) : globalTx(run);
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
  await globalTx((t) => t`insert into email_suppressions (email, reason, stream) values (${email}, 'unsubscribed', 'marketing')
                            on conflict (email) do update set reason = 'unsubscribed'`);
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
  data: { email_id?: string; to?: string[]; bounce?: { type?: string } };
}

export async function handleResendEvent(evt: ResendEvent) {
  await globalTx(async (t) => {
    if (evt.data.email_id) {
      await t`select email_log_event(${evt.data.email_id}, ${evt.type.replace('email.', '')}, ${t.json({ type: evt.type, at: new Date().toISOString() })})`;
    }
    const hardBounce = evt.type === 'email.bounced' && !/transient|soft/i.test(evt.data.bounce?.type ?? '');
    if (evt.type === 'email.bounced' || evt.type === 'email.complained') {
      for (const to of evt.data.to ?? []) {
        await t`insert into email_suppressions (email, reason, stream) values (${to.toLowerCase()}, ${evt.type === 'email.bounced' ? 'hard_bounce' : 'complaint'}, 'all')
                on conflict (email) do update set reason = excluded.reason, stream = 'all'`;
      }
    }
    // A hard bounce on an Owner's address raises the tenant banner; a later delivery to it clears it (plan 05 §18).
    if (hardBounce || evt.type === 'email.delivered') {
      for (const to of evt.data.to ?? []) await t`select email_owner_bounce(${to.toLowerCase()}, ${hardBounce})`;
    }
    // Each complaint re-checks the 30-day marketing complaint rate; above the threshold marketing pauses (audited).
    if (evt.type === 'email.complained') await t`select email_marketing_complaint_check(${MARKETING_COMPLAINT_THRESHOLD})`;
  });
}
