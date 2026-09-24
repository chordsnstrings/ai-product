import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool } from '@arkiv/db';
import { makeTenant, truncateAll } from '@arkiv/db/testing';
import { newId } from '@arkiv/shared';
import { dmarcFor, sendingDomains } from './domains';
import { templateSamples } from './samples';
import { handleResendEvent, MARKETING_COMPLAINT_THRESHOLD, renderEmail, sendEmail } from './send';
import { quietHoursDelay, SEQUENCES } from './sequences';
import { MARKETING_TEMPLATES, type TemplateName } from './templates';

beforeEach(truncateAll);
afterEach(async () => {
  await ownerPool()`delete from platform_settings where key = 'email.marketing_paused'`;
});
afterAll(closeAll);

const sample = { productName: 'Dew Serum', url: 'http://localhost/storyboard/1', standalonePrice: '$49' };

describe('complaint-rate guard (plan 05 §18)', () => {
  it('pauses marketing sends above 0.1% complaints over 30 days, audited, and leaves transactional mail alone', async () => {
    // 1,000 marketing sends in the last 30 days, then two complaints (0.2%).
    await ownerPool()`insert into email_log (to_email, template, stream, idempotency_key, status, provider_id)
                      select 'r' || g || '@example.com', 'storyboard_saved', 'marketing', 'bulk-' || g, 'delivered', 'msg-' || g from generate_series(1, 1000) g`;
    await handleResendEvent({ type: 'email.complained', data: { email_id: 'msg-1', to: ['r1@example.com'] } });
    expect((await ownerPool()`select value from platform_settings where key = 'email.marketing_paused'`).length).toBe(0); // 0.1% is not above
    await handleResendEvent({ type: 'email.complained', data: { email_id: 'msg-2', to: ['r2@example.com'] } });
    const [p] = await ownerPool()`select value from platform_settings where key = 'email.marketing_paused'`;
    expect(p!.value).toMatchObject({ complaints: 2, sent: 1000, threshold: MARKETING_COMPLAINT_THRESHOLD, by: 'system' });
    expect(await ownerPool()`select action from admin_audit_log where action = 'system.email.marketing_paused'`).toHaveLength(1);
    expect(await ownerPool()`select kind from platform_alerts where kind = 'email.marketing_paused' and resolved_at is null`).toHaveLength(1);
    // A third complaint doesn't re-audit.
    await handleResendEvent({ type: 'email.complained', data: { email_id: 'msg-3', to: ['r3@example.com'] } });
    expect(await ownerPool()`select action from admin_audit_log where action = 'system.email.marketing_paused'`).toHaveLength(1);

    expect((await sendEmail('storyboard_saved', 'fresh@example.com', sample, { idempotencyKey: newId() })).status).toBe('paused');
    expect((await sendEmail('receipt', 'fresh@example.com', { productName: 'Dew Serum', amount: '$19.00', description: 'ad', url: 'http://localhost/x' }, { idempotencyKey: newId() })).status).toBe('logged');
    // Staff resumed (the setting is cleared to null): marketing flows again.
    await ownerPool()`update platform_settings set value = 'null'::jsonb where key = 'email.marketing_paused'`;
    expect((await sendEmail('storyboard_saved', 'fresh@example.com', sample, { idempotencyKey: newId() })).status).toBe('logged');
  });
});

describe('owner bounce banner (plan 05 §18, 02 M13)', () => {
  it('flags the workspaces the address owns on a hard bounce and clears on delivery; soft bounces and non-owners do not', async () => {
    const owner = await makeTenant({ email: 'owner@brand.example' });
    const editor = await makeTenant({ email: 'editor@brand.example', role: 'MEMBER' });
    const flag = async (ws: string) => (await ownerPool()`select owner_email_bouncing_at is not null as b from workspaces where id = ${ws}`)[0]!.b;
    await handleResendEvent({ type: 'email.bounced', data: { to: ['Owner@Brand.example'], bounce: { type: 'Transient' } } });
    expect(await flag(owner.workspaceId)).toBe(false);
    await handleResendEvent({ type: 'email.bounced', data: { to: ['owner@brand.example'], bounce: { type: 'Permanent' } } });
    await handleResendEvent({ type: 'email.bounced', data: { to: ['editor@brand.example'] } });
    expect(await flag(owner.workspaceId)).toBe(true);
    expect(await flag(editor.workspaceId)).toBe(false);
    await handleResendEvent({ type: 'email.delivered', data: { to: ['owner@brand.example'] } });
    expect(await flag(owner.workspaceId)).toBe(false);
  });
});

describe('quiet hours and sequences (plan 05 §18)', () => {
  it('holds marketing email between 20:00 and 08:00 in the workspace timezone, never transactional', () => {
    const at = (iso: string) => new Date(iso);
    // 21:30 in New York (01:30 UTC next day, EDT) → 08:00 New York = 12:00 UTC.
    expect(quietHoursDelay('storyboard_saved', 'America/New_York', at('2026-09-25T01:30:00Z'))?.toISOString()).toBe('2026-09-25T12:00:00.000Z');
    // 06:15 in Berlin (04:15 UTC, CEST) → 08:00 Berlin = 06:00 UTC.
    expect(quietHoursDelay('new_concept', 'Europe/Berlin', at('2026-09-25T04:15:00Z'))?.toISOString()).toBe('2026-09-25T06:00:00.000Z');
    expect(quietHoursDelay('storyboard_saved', 'America/New_York', at('2026-09-25T15:00:00Z'))).toBeNull();
    expect(quietHoursDelay('receipt', 'America/New_York', at('2026-09-25T03:00:00Z'))).toBeNull();
    // An unknown zone is treated as UTC.
    expect(quietHoursDelay('storyboard_saved', 'Mars/Olympus', at('2026-09-25T22:00:00Z'))?.toISOString()).toBe('2026-09-26T08:00:00.000Z');
  });

  it('registers every automated sequence with its template, trigger and audience', () => {
    expect(SEQUENCES.map((s) => s.key)).toEqual(['offer_ending', 'storyboard_saved', 'new_concept', 'day30_review', 'weekly_brief']);
    for (const s of SEQUENCES) expect(s.trigger.length && s.audience.length && s.caps.length).toBeTruthy();
    expect(SEQUENCES.filter((s) => MARKETING_TEMPLATES.has(s.template)).map((s) => s.key)).toEqual(['storyboard_saved', 'new_concept']);
  });
});

describe('template previews (plan 05 §18)', () => {
  it('every template renders with its sample data', async () => {
    const samples = templateSamples('http://localhost:3000');
    for (const t of Object.keys(samples) as TemplateName[]) {
      const r = await renderEmail(t, samples[t] as never, { unsubscribeUrl: 'http://localhost/api/unsubscribe?t=x' });
      expect(r.subject.length, t).toBeGreaterThan(3);
      expect(r.html, t).toContain('<html');
      expect(r.html.includes('api/unsubscribe'), t).toBe(MARKETING_TEMPLATES.has(t));
    }
  });
});

describe('sending domains (plan 05 §18)', () => {
  it('reads DMARC from the subdomain or the organisational domain', async () => {
    const dns: Record<string, string[][]> = { '_dmarc.arkiv.example': [['v=DMARC1; p=quarantine; rua=mailto:d@arkiv.example']] };
    const lookup = async (n: string) => {
      if (!dns[n]) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
      return dns[n]!;
    };
    expect(await dmarcFor('mail.arkiv.example', lookup)).toEqual({ status: 'verified', policy: 'quarantine' });
    expect(await dmarcFor('mail.other.example', lookup)).toEqual({ status: 'missing', policy: null });
    expect(sendingDomains().length).toBeGreaterThanOrEqual(1);
  });
});
