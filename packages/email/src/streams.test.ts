import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool } from '@arkiv/db';
import { makeTenant, truncateAll } from '@arkiv/db/testing';
import { newId } from '@arkiv/shared';
import {
  addressBouncing,
  digestOptOutLink,
  handleResendEvent,
  sendEmail,
  setDigestPreference,
  setEmailTransportForTests,
  signDigestOptOut,
  suppressionBlocks,
  unsubscribe,
  verifyDigestOptOut,
  type EmailTransport,
} from './send';

beforeEach(truncateAll);
afterEach(async () => {
  setEmailTransportForTests(null);
  // A single test complaint is a 100% complaint rate: the guard pauses marketing platform-wide.
  await ownerPool()`delete from platform_settings where key = 'email.marketing_paused'`;
});
afterAll(closeAll);

const receipt = { workspaceName: 'Dew Co', productName: 'Dew Serum', amount: '$19.00', description: 'One ad', url: 'http://localhost/x' };
const saved = { workspaceName: 'Dew Co', productName: 'Dew Serum', url: 'http://localhost/storyboard/1', standalonePrice: '$49' };
const concept = { workspaceName: 'Dew Co', productName: 'Dew Serum', url: 'http://localhost/concepts/1', hook: 'Glass skin in 3 drops' };
const offer = { workspaceName: 'Dew Co', productName: 'Dew Serum', url: 'http://localhost/storyboard/1', endsAt: '15:42 ET', price: '$19', regular: '$49' };
const logRow = async (key: string) => (await ownerPool()`select status, events, stream from email_log where idempotency_key = ${key}`)[0];
const sups = async (email: string) => (await ownerPool()`select stream, reason from email_suppressions where email = ${email} order by stream, reason`).map((r) => `${r.stream}:${r.reason}`);

describe('failed sends are recorded (plan 05 §18 sending stats)', () => {
  it('keeps the log row as failed with the error, and a retry under the same key sends', async () => {
    const calls: string[] = [];
    let fail = true;
    const stub: EmailTransport = {
      send: async (_m, o) => {
        calls.push(o.idempotencyKey);
        return fail ? { error: { message: 'rate limited' } } : { data: { id: 'msg-retry-ok' } };
      },
    };
    setEmailTransportForTests(stub);
    await expect(sendEmail('receipt', 'buyer@example.com', receipt, { idempotencyKey: 'fail-1' })).rejects.toThrow(/rate limited/);
    const failed = await logRow('fail-1');
    expect(failed!.status).toBe('failed');
    expect(JSON.stringify(failed!.events)).toContain('rate limited');
    fail = false;
    expect(await sendEmail('receipt', 'buyer@example.com', receipt, { idempotencyKey: 'fail-1' })).toMatchObject({ status: 'sent', providerId: 'msg-retry-ok' });
    expect((await logRow('fail-1'))!.status).toBe('sent');
    expect(calls).toEqual(['fail-1', 'fail-1']);
    // Sent is final: a third delivery of the same job is a duplicate and never reaches the provider.
    expect((await sendEmail('receipt', 'buyer@example.com', receipt, { idempotencyKey: 'fail-1' })).status).toBe('duplicate');
    expect(calls).toHaveLength(2);
  });

  it('a transport exception is recorded the same way', async () => {
    setEmailTransportForTests({ send: async () => { throw new Error('socket hang up'); } });
    await expect(sendEmail('receipt', 'b@example.com', receipt, { idempotencyKey: 'fail-2' })).rejects.toThrow(/socket hang up/);
    expect((await logRow('fail-2'))!.status).toBe('failed');
  });
});

describe('marketing frequency cap under concurrency (plan 05 §18 max 1/day)', () => {
  it('two marketing sends to one address at once: one goes out, one is capped', async () => {
    const [a, b] = await Promise.all([
      sendEmail('storyboard_saved', 'race@example.com', saved, { idempotencyKey: 'race-1' }),
      sendEmail('new_concept', 'race@example.com', concept, { idempotencyKey: 'race-2' }),
    ]);
    expect([a.status, b.status].sort()).toEqual(['capped', 'logged']);
    const rows = await ownerPool()`select status from email_log where to_email = 'race@example.com' order by status`;
    expect(rows.map((r) => r.status)).toEqual(['capped', 'logged']);
  });
});

describe('suppression model (plan 05 §18: unsubscribe for marketing, never for transactional)', () => {
  it('a marketing complaint stops marketing only; receipts still go out', async () => {
    await ownerPool()`insert into email_log (to_email, template, stream, idempotency_key, status, provider_id) values ('c@example.com', 'new_concept', 'marketing', 'mk-1', 'delivered', 'msg-mk')`;
    await handleResendEvent({ type: 'email.complained', data: { email_id: 'msg-mk', to: ['c@example.com'] } });
    expect(await sups('c@example.com')).toEqual(['marketing:complaint']);
    expect((await sendEmail('receipt', 'c@example.com', receipt, { idempotencyKey: newId() })).status).toBe('logged');
    expect((await sendEmail('cancellation_confirmed', 'c@example.com', { workspaceName: 'Dew Co', planName: 'Growth', endsOn: '23 Oct 2026', exportUrl: 'http://x' }, { idempotencyKey: newId() })).status).toBe('logged');
    expect((await sendEmail('storyboard_saved', 'c@example.com', saved, { idempotencyKey: 'mk-2' })).status).toBe('suppressed');
  });

  it('a transactional complaint stops optional notices but never receipts, billing or security mail', async () => {
    await ownerPool()`insert into email_log (to_email, template, stream, idempotency_key, status, provider_id) values ('t@example.com', 'asset_ready', 'transactional', 'tx-1', 'delivered', 'msg-tx')`;
    await handleResendEvent({ type: 'email.complained', data: { email_id: 'msg-tx', to: ['t@example.com'] } });
    expect(await sups('t@example.com')).toEqual(['transactional:complaint']);
    expect((await sendEmail('receipt', 't@example.com', receipt, { idempotencyKey: newId() })).status).toBe('logged');
    expect((await sendEmail('security_alert', 't@example.com', { event: 'New sign-in', when: 'now', url: 'http://x' }, { idempotencyKey: newId() })).status).toBe('logged');
    expect((await sendEmail('asset_ready', 't@example.com', { workspaceName: 'Dew Co', productName: 'Dew Serum', url: 'http://x', catalogueNo: 'No. 001' }, { idempotencyKey: newId() })).status).toBe('suppressed');
  });

  it('keeps an unsubscribe and a bounce apart: a soft bounce suppresses nothing, a hard bounce everything but sign-in', async () => {
    await unsubscribe('both@example.com');
    await handleResendEvent({ type: 'email.bounced', data: { to: ['both@example.com'], bounce: { type: 'Transient' } } });
    expect(await sups('both@example.com')).toEqual(['marketing:unsubscribed']);
    expect(await addressBouncing('both@example.com')).toBe(false);
    await handleResendEvent({ type: 'email.bounced', data: { to: ['both@example.com'], bounce: { type: 'Permanent' } } });
    expect(await sups('both@example.com')).toEqual(['all:hard_bounce', 'marketing:unsubscribed']);
    expect(await addressBouncing('both@example.com')).toBe(true);
    expect((await sendEmail('receipt', 'both@example.com', receipt, { idempotencyKey: newId() })).status).toBe('suppressed');
    expect((await sendEmail('magic_link', 'both@example.com', { url: 'http://x/auth/magic/T', purpose: 'login' }, { idempotencyKey: newId() })).status).toBe('logged');
    // Clearing the bounce (what the console's unsuppress does) leaves the unsubscribe standing.
    await ownerPool()`delete from email_suppressions where email = 'both@example.com' and reason <> 'unsubscribed'`;
    expect(await sups('both@example.com')).toEqual(['marketing:unsubscribed']);
    expect((await sendEmail('new_concept', 'both@example.com', concept, { idempotencyKey: newId() })).status).toBe('suppressed');
  });

  it('the intro-price reminder honours a marketing unsubscribe (plan 04 L20) and carries the unsubscribe link', async () => {
    const r1 = await sendEmail('offer_ending', 'fan@example.com', offer, { idempotencyKey: newId() });
    expect(r1.status).toBe('logged');
    await unsubscribe('fan@example.com');
    expect((await sendEmail('offer_ending', 'fan@example.com', offer, { idempotencyKey: newId() })).status).toBe('suppressed');
    expect(suppressionBlocks('offer_ending', [{ stream: 'marketing' }])).toBe(true);
    expect(suppressionBlocks('receipt', [{ stream: 'marketing' }])).toBe(false);
  });
});

describe('sends that did not go out are logged (plan 05 §18 suppression list)', () => {
  it('records suppressed and capped attempts, and sends on a retry after the address is cleared', async () => {
    const t = await makeTenant();
    await ownerPool()`insert into email_suppressions (email, reason, stream) values ('gone@example.com', 'hard_bounce', 'all')`;
    expect((await sendEmail('receipt', 'gone@example.com', receipt, { idempotencyKey: 'supp-1', workspaceId: t.workspaceId })).status).toBe('suppressed');
    const [row] = await ownerPool()`select status, workspace_id, data from email_log where idempotency_key = 'supp-1'`;
    expect(row).toMatchObject({ status: 'suppressed', workspace_id: t.workspaceId });
    expect(row!.data).toMatchObject({ productName: 'Dew Serum' });
    await ownerPool()`delete from email_suppressions where email = 'gone@example.com'`;
    expect((await sendEmail('receipt', 'gone@example.com', receipt, { idempotencyKey: 'supp-1', workspaceId: t.workspaceId })).status).toBe('logged');
    const [after] = await ownerPool()`select status, events from email_log where idempotency_key = 'supp-1'`;
    expect(after!.status).toBe('logged');
    expect(after!.events).toEqual([expect.objectContaining({ type: 'retry', previous: 'suppressed' })]);
    // Another tenant can't take over the key.
    const other = await makeTenant();
    expect((await sendEmail('receipt', 'gone@example.com', receipt, { idempotencyKey: 'supp-1', workspaceId: other.workspaceId })).status).toBe('duplicate');
  });
});

describe('digest opt-out (plan 03 A10 weekly emails)', () => {
  it('signs one member, workspace and digest; the link turns off exactly that one', async () => {
    const t = await makeTenant();
    const o = { workspaceId: t.workspaceId, userId: t.userId, kind: 'friday_summary' as const };
    expect(verifyDigestOptOut(signDigestOptOut(o))).toEqual(o);
    const forged = signDigestOptOut(o).replace(/\.[^.]+$/, '.AAAAAAAAAAAAAAAAAAAAAA');
    expect(verifyDigestOptOut(forged)).toBeNull();
    expect(new URL(digestOptOutLink(o)).pathname).toBe('/api/notifications/opt-out');
    await setDigestPreference(o, false);
    expect(await ownerPool()`select kind, enabled from notification_prefs where user_id = ${t.userId}`).toEqual([{ kind: 'friday_summary', enabled: false }]);
    // A token for someone who isn't a member writes nothing.
    await setDigestPreference({ ...o, userId: newId() }, false);
    expect(await ownerPool()`select 1 from notification_prefs`).toHaveLength(1);
  });

  it('puts the turn-off link on digests only', async () => {
    const t = await makeTenant();
    const url = digestOptOutLink({ workspaceId: t.workspaceId, userId: t.userId, kind: 'weekly_brief' });
    const { devOutbox } = await import('./send');
    await sendEmail('weekly_brief', 'd@example.com', { workspaceName: 'Dew Co', week: '21 Sep 2026', recommendations: [{ hypothesis: 'Texture beats talking heads', slot: 'EXPLOIT' }], url: 'http://x' }, { idempotencyKey: newId(), optOutUrl: url });
    expect(devOutbox.at(-1)!.html).toContain('/api/notifications/opt-out');
    expect(devOutbox.at(-1)!.html).toContain('Turn it off');
    await sendEmail('receipt', 'd@example.com', receipt, { idempotencyKey: newId(), optOutUrl: url });
    expect(devOutbox.at(-1)!.html).not.toContain('/api/notifications/opt-out');
  });
});
