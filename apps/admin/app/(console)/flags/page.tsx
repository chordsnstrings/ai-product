import { withAdmin } from '@arkiv/db';
import { ActButton, ActForm } from '@/components/act';
import { dt, Mono, Page, Section, Table } from '@/components/ui';
import { requireStaff } from '@/lib/staff';

export const metadata = { title: 'Flags & config' };

/** Plan 05 §20. Kill switches need a fresh second factor. */
export default async function Flags() {
  await requireStaff('flags.manage');
  const d0 = await withAdmin(async (tx) => ({
    flags: await tx`select * from feature_flags order by (key like 'kill.%') desc, key`,
    settings: await tx`select * from platform_settings order by key`,
  }));
  const kills = d0.flags.filter((f) => String(f.key).startsWith('kill.'));
  const flags = d0.flags.filter((f) => !String(f.key).startsWith('kill.'));
  return (
    <Page title="Feature flags & config">
      <Section title="Kill switches">
        <Table head={['Switch', 'What it does', 'State', '']} rows={kills.map((f) => [<Mono key="k">{f.key as string}</Mono>, f.description as string, f.enabled ? <span key="s" className="ak-chip ak-chip--risk">ON</span> : 'off',
          <ActButton key="t" small danger={!f.enabled} action="flag.set" payload={{ key: f.key, enabled: !f.enabled }} reason confirm={f.enabled ? 'Turn off?' : 'Turn ON this kill switch? It takes effect immediately.'}>{f.enabled ? '🔐 Turn off' : '🔐 Turn on'}</ActButton>])} />
      </Section>
      <Section title="Flags">
        <Table head={['Key', 'Description', 'Owner', 'Kind', 'Enabled', 'Rules', 'Expires', '']} rows={flags.map((f) => {
          const expired = f.expires_at && new Date(f.expires_at as string) < new Date();
          return [<Mono key="k">{f.key as string}</Mono>, f.description as string, f.owner as string, f.kind as string, f.enabled ? 'yes' : 'no', <Mono key="r">{JSON.stringify(f.rules)}</Mono>, <span key="e" style={{ color: expired ? 'var(--risk)' : undefined }}>{f.expires_at ? dt(f.expires_at) : '—'}</span>,
            <ActForm key="f" inline action="flag.set" extra={{ key: f.key }} submit="Save" fields={[{ name: 'enabled', label: 'On', type: 'checkbox', defaultValue: f.enabled as boolean }, { name: 'rules', label: 'Rules JSON', type: 'json', defaultValue: JSON.stringify(f.rules) }, { name: 'reason', label: 'Reason', required: true }]} />];
        })} />
        <div className="ak-panel" style={{ maxWidth: 560, marginTop: 12 }}>
          <ActForm action="flag.create" submit="Create flag" fields={[{ name: 'key', label: 'Key', required: true }, { name: 'description', label: 'Description', required: true }, { name: 'owner', label: 'Owner', required: true }, { name: 'kind', label: 'Kind', type: 'select', options: ['boolean', 'percentage', 'workspace_allowlist', 'plan'] }, { name: 'expiresAt', label: 'Expiry', type: 'date' }]} />
        </div>
      </Section>
      <Section title="Platform settings">
        <Table head={['Key', 'Value', 'Updated', '']} rows={d0.settings.map((x) => [<Mono key="k">{x.key as string}</Mono>, <Mono key="v">{JSON.stringify(x.value)}</Mono>, dt(x.updated_at),
          <ActForm key="f" inline action="setting.set" extra={{ key: x.key }} submit="Save" fields={[{ name: 'value', label: 'Value (JSON)', type: 'json', defaultValue: JSON.stringify(x.value) }, { name: 'reason', label: 'Reason', required: true }]} />])} />
      </Section>
    </Page>
  );
}
