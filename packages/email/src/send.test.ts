import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool } from '@arkiv/db';
import { truncateAll } from '@arkiv/db/testing';
import { canResendTemplate, devOutbox, REDACTED_LINK, renderEmail, sendEmail, storedEmailData } from './send';

beforeEach(truncateAll);
afterEach(async () => {
  await ownerPool()`update platform_settings set value = '"support@localhost"' where key = 'support.email'`;
});
afterAll(closeAll);

describe('stored email data (plan 05 §2.2 Emails: resend, view rendered email)', () => {
  it('keeps the template data with the log row, minus single-use links', async () => {
    const receipt = { productName: 'Dew Serum', amount: '$19.00', description: 'One 15-second ad', url: 'http://localhost/produce/1' };
    await sendEmail('receipt', 'buyer@example.com', receipt, { idempotencyKey: 'stored-1' });
    await sendEmail('magic_link', 'buyer@example.com', { url: 'http://localhost/auth/magic/SECRET', purpose: 'login' }, { idempotencyKey: 'stored-2' });
    const rows = await ownerPool()`select idempotency_key, data from email_log where idempotency_key in ('stored-1', 'stored-2') order by idempotency_key`;
    expect(rows.map((r) => r.data)).toEqual([receipt, { url: REDACTED_LINK, purpose: 'login' }]);
    expect(JSON.stringify(rows)).not.toContain('SECRET');
    expect(storedEmailData('invite', { url: 'http://x/invite/T', workspaceName: 'W', inviterName: 'A', role: 'MEMBER' })).toMatchObject({ url: REDACTED_LINK, workspaceName: 'W' });
    expect(canResendTemplate('receipt')).toBe(true);
    expect(canResendTemplate('magic_link')).toBe(false);
    expect(canResendTemplate('ownership_transfer_confirm')).toBe(false);
    expect(canResendTemplate('not_a_template')).toBe(false);
  });

  it('renders a stored email the way the recipient saw it', async () => {
    const r = await renderEmail('intervention', { label: 'From the Arkiv team', headline: 'Reconnect your ad account', body: 'Read-only access.', cta: 'Reconnect', url: 'http://localhost/w/x/settings/integrations' }, { supportEmail: 'help@arkiv.example' });
    expect(r.subject).toBe('Reconnect your ad account');
    expect(r.html).toContain('http://localhost/w/x/settings/integrations');
    expect(r.html).toContain('help@arkiv.example');
  });
});

describe('email footer (plan 05 §20 support email setting)', () => {
  it('shows the support address from platform settings', async () => {
    const receipt = { productName: 'Dew Serum', amount: '$19.00', description: 'One 15-second ad', url: 'http://localhost/x' };
    await sendEmail('receipt', 'a@example.com', receipt, { idempotencyKey: 'support-footer-1' });
    expect(devOutbox.at(-1)!.html).toContain('support@localhost');
    await ownerPool()`update platform_settings set value = '"help@arkiv.example"' where key = 'support.email'`;
    await sendEmail('receipt', 'a@example.com', receipt, { idempotencyKey: 'support-footer-2' });
    expect(devOutbox.at(-1)!.html).toContain('help@arkiv.example');
  });
});
