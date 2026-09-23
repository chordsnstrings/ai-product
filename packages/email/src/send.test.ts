import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool } from '@arkiv/db';
import { truncateAll } from '@arkiv/db/testing';
import { devOutbox, sendEmail } from './send';

beforeEach(truncateAll);
afterEach(async () => {
  await ownerPool()`update platform_settings set value = '"support@localhost"' where key = 'support.email'`;
});
afterAll(closeAll);

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
