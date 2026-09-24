import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool } from '@arkiv/db';
import { truncateAll } from '@arkiv/db/testing';
import { canResendTemplate, devOutbox, REDACTED_LINK, renderEmail, sendEmail, storedEmailData, unsubscribeLink, verifyUnsub } from './send';

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

describe('compliance emails (plan 05 §14)', () => {
  it('renders the evidence request, out-of-scope, guidance and media review emails', async () => {
    const ev = await renderEmail('claim_evidence_request', { claim: 'Clinically proven to reduce redness', productName: 'Dew Serum', note: 'Send the study summary.', url: 'http://localhost/w/x/products/1/claims' });
    expect(ev.subject).toBe('More evidence needed: Clinically proven to reduce redness');
    expect(ev.html).toContain('Send the study summary.');
    const oos = await renderEmail('sku_out_of_scope', { productName: 'Daily SPF 50', reason: 'Sunscreens are OTC drugs', url: 'http://localhost/w/x/products' });
    expect(oos.html).toContain('Sunscreens are OTC drugs');
    const g = await renderEmail('claims_guidance', { workspaceName: 'Dew Co', blocked: 3, examples: ['Cures acne'], url: 'http://localhost/w/x/products' });
    expect(g.html).toContain('Cures acne');
    const m = await renderEmail('media_review_result', { productName: 'Dew Serum', outcome: 'rejected', note: 'It shows a before/after comparison.', url: 'http://localhost/w/x/products/1' });
    expect(m.subject).toMatch(/won’t be used/);
    for (const t of ['claim_evidence_request', 'sku_out_of_scope', 'claims_guidance', 'media_review_result']) expect(canResendTemplate(t)).toBe(true);
  });
});

describe('marketing unsubscribe (plan 04 L20 one-click unsubscribe)', () => {
  it('links the recipient’s signed unsubscribe URL on marketing emails only', async () => {
    const url = new URL(unsubscribeLink('buyer@example.com'));
    // The route the List-Unsubscribe header and the footer point to exists (apps/web/app/api/unsubscribe) and takes `t`.
    expect(url.pathname).toBe('/api/unsubscribe');
    expect(verifyUnsub(url.searchParams.get('t')!)).toBe('buyer@example.com');

    await sendEmail('new_concept', 'buyer@example.com', { productName: 'Dew Serum', url: 'http://localhost/x', hook: 'Glass skin in 3 drops' }, { idempotencyKey: 'unsub-footer-1' });
    const marketing = devOutbox.at(-1)!;
    expect(marketing.html).toContain('Unsubscribe');
    expect(marketing.html).toContain(url.searchParams.get('t')!);

    await sendEmail('receipt', 'buyer@example.com', { productName: 'Dew Serum', amount: '$19.00', description: 'One ad', url: 'http://localhost/x' }, { idempotencyKey: 'unsub-footer-2' });
    expect(devOutbox.at(-1)!.html).not.toContain('/api/unsubscribe');
  });
});
