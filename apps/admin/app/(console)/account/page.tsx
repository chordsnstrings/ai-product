import { listStaffPasskeys } from '@arkiv/auth';
import { withAdmin } from '@arkiv/db';
import { ActButton } from '@/components/act';
import { AddPasskey } from '@/components/passkeys';
import { ago, d, Page, Section, Table } from '@/components/ui';
import { requireStaff } from '@/lib/staff';

export const metadata = { title: 'Passkeys' };

/** Your own sign-in factors (plan 05 §0.1): passkeys for sign-in and the 🔐 re-auth tap. */
export default async function Account() {
  const s = await requireStaff('account.self');
  const [keys, [me]] = await Promise.all([listStaffPasskeys(s.staffId), withAdmin((tx) => tx`select require_passkey from staff_users where id = ${s.staffId}`)]);
  return (
    <Page title="Passkeys" sub={`${s.email} · ${me?.require_passkey ? 'a passkey is required for this account (authenticator codes are refused)' : 'passkey or authenticator code'}`}>
      <p className="ak-small" style={{ maxWidth: 640 }}>A passkey replaces the authenticator code at sign-in (after your password) and confirms 🔐 actions with a tap. It only works on this console’s address, so a look-alike site can’t use it.</p>
      <Section title="Your passkeys">
        <Table
          head={['Name', 'Added', 'Last used', '']}
          rows={keys.map((k) => [k.name as string, d(k.created_at), k.last_used_at ? ago(k.last_used_at) : 'never', <ActButton key="r" small danger action="account.passkey_remove" payload={{ passkeyId: k.id }} confirm={`Remove “${k.name as string}”?`}>🔐 Remove</ActButton>])}
          empty="No passkeys yet."
        />
      </Section>
      <Section title="Add a passkey">
        <AddPasskey />
      </Section>
    </Page>
  );
}
