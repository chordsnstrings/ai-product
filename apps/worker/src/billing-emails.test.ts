import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool } from '@arkiv/db';
import { makeTenant, truncateAll } from '@arkiv/db/testing';
import { MockStripe, setBillingGateway } from '@arkiv/billing';
import { devOutbox } from '@arkiv/email';
import { ctxFor } from '@arkiv/core/testing';
import { billingRecipients, sendQueuedEmail } from './emails';

/** Plan 02 §5 M13: when the Owner's email hard-bounces, billing email falls back to the Stripe billing email. */
let gw: MockStripe;
beforeEach(async () => {
  devOutbox.length = 0;
  gw = new MockStripe();
  setBillingGateway(gw);
  await truncateAll();
});
afterAll(closeAll);

async function tenantWithCustomer() {
  const t = await makeTenant({ state: 'ACTIVE_PAID' });
  const customer = `cus_${t.workspaceId.slice(0, 8)}`;
  await ownerPool()`update workspaces set stripe_customer_id = ${customer} where id = ${t.workspaceId}`;
  gw.emails.set(customer, 'billing@brand.com');
  return t;
}

describe('billing email recipients', () => {
  it('go to the Owner while the Owner’s address works', async () => {
    const t = await tenantWithCustomer();
    expect(await billingRecipients(t.workspaceId)).toEqual([t.email]);
  });

  it('add the Stripe billing email when every Owner address hard-bounces', async () => {
    const t = await tenantWithCustomer();
    await ownerPool()`insert into email_suppressions (email, reason, stream) values (${t.email.toUpperCase()}, 'hard_bounce', 'all')`;
    expect(await billingRecipients(t.workspaceId)).toEqual([t.email, 'billing@brand.com']);
    await sendQueuedEmail(ctxFor(t.workspaceId, t.userId, 'OWNER', 'ACTIVE_PAID'), { template: 'payment_failed' }, 'job-pf');
    // The bounced address is suppressed by the sender; the billing email gets the notice.
    expect(devOutbox.filter((m) => m.template === 'payment_failed').map((m) => m.to)).toEqual(['billing@brand.com']);
  });

  it('a complaint (not a bounce) or a second working Owner keeps the usual recipients; no customer means no fallback', async () => {
    const t = await tenantWithCustomer();
    await ownerPool()`insert into email_suppressions (email, reason, stream) values (${t.email}, 'complaint', 'all')`;
    expect(await billingRecipients(t.workspaceId)).toEqual([t.email]);
    await ownerPool()`update email_suppressions set reason = 'hard_bounce'`;
    const [u] = await ownerPool()`insert into users (email) values ('cofounder@brand.com') returning id`;
    await ownerPool()`insert into memberships (workspace_id, user_id, role) values (${t.workspaceId}, ${u!.id}, 'OWNER')`;
    expect((await billingRecipients(t.workspaceId)).sort()).toEqual([t.email, 'cofounder@brand.com'].sort());
    const other = await makeTenant({ state: 'ACTIVE_PAID' });
    await ownerPool()`insert into email_suppressions (email, reason, stream) values (${other.email}, 'hard_bounce', 'all')`;
    expect(await billingRecipients(other.workspaceId)).toEqual([other.email]);
  });
});
