import { createHmac, timingSafeEqual } from 'node:crypto';
import { render } from '@react-email/render';
import { globalTx, type Tx } from '@arkiv/db';
import { env } from '@arkiv/shared';
import { createElement } from 'react';
import { build, SupportEmail, type TemplateMap, type TemplateName } from './templates';

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
  status: 'sent' | 'suppressed' | 'duplicate' | 'logged' | 'capped';
  providerId?: string | null;
}

/** Dev/test outbox so flows (e.g. magic links) are testable without a provider. */
export const devOutbox: { to: string; template: string; subject: string; html: string; data: unknown }[] = [];

async function resendClient() {
  const { Resend } = await import('resend');
  return new Resend(env().RESEND_API_KEY);
}

export async function sendEmail<T extends TemplateName>(template: T, to: string, data: TemplateMap[T], opts: SendOptions, tx?: Tx): Promise<SendResult> {
  const built = build(template, data);
  const run = async (t: Tx): Promise<SendResult> => {
    const email = to.trim().toLowerCase();
    const [sup] = await t`select stream from email_suppressions where email = ${email}`;
    if (sup && (sup.stream === 'all' || sup.stream === built.stream) && built.stream === 'marketing') return { status: 'suppressed' };
    if (sup && sup.stream === 'all' && built.stream === 'transactional' && template !== 'magic_link' && template !== 'security_alert') return { status: 'suppressed' };
    if (built.stream === 'marketing') {
      const [cap] = await t`select count(*) filter (where created_at > now() - interval '1 day')::int as d,
                                   count(*) filter (where created_at > now() - interval '7 days')::int as w
                            from email_log where to_email = ${email} and stream = 'marketing'`;
      if (cap!.d >= 1 || cap!.w >= 3) return { status: 'capped' };
    }
    const ins = await t`insert into email_log (workspace_id, to_email, template, stream, idempotency_key, status)
                        values (${opts.workspaceId ?? null}, ${email}, ${template}, ${built.stream}, ${opts.idempotencyKey}, 'queued')
                        on conflict (idempotency_key) do nothing returning id`;
    if (!ins.length) return { status: 'duplicate' };
    // Footer support address is a platform setting (plan 05 §20); omitted when unset.
    const [supportRow] = await t`select value from platform_settings where key = 'support.email'`;
    const supportEmail = typeof supportRow?.value === 'string' && supportRow.value.includes('@') ? supportRow.value : null;
    const element = createElement(SupportEmail.Provider, { value: supportEmail }, built.element);
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
      await t`update email_log set status = 'logged' where id = ${ins[0]!.id}`;
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
        headers: built.stream === 'marketing' ? { 'List-Unsubscribe': `<${env().APP_URL}/api/email/unsubscribe?e=${encodeURIComponent(signUnsub(email))}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } : undefined,
      },
      { idempotencyKey: opts.idempotencyKey },
    );
    if (r.error) {
      await t`update email_log set status = 'failed', events = events || ${t.json([{ at: new Date().toISOString(), error: r.error.message }])} where id = ${ins[0]!.id}`;
      throw new Error(`resend: ${r.error.message}`);
    }
    await t`update email_log set status = 'sent', provider_id = ${r.data?.id ?? null} where id = ${ins[0]!.id}`;
    return { status: 'sent', providerId: r.data?.id ?? null };
  };
  return tx ? run(tx) : globalTx(run);
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

export async function handleResendEvent(evt: { type: string; data: { email_id?: string; to?: string[] } }) {
  await globalTx(async (t) => {
    if (evt.data.email_id) {
      await t`update email_log set status = ${evt.type.replace('email.', '')}, events = events || ${t.json([{ type: evt.type, at: new Date().toISOString() }])}
              where provider_id = ${evt.data.email_id}`;
    }
    if (evt.type === 'email.bounced' || evt.type === 'email.complained') {
      for (const to of evt.data.to ?? []) {
        await t`insert into email_suppressions (email, reason, stream) values (${to.toLowerCase()}, ${evt.type === 'email.bounced' ? 'hard_bounce' : 'complaint'}, 'all')
                on conflict (email) do update set reason = excluded.reason, stream = 'all'`;
      }
    }
  });
}
