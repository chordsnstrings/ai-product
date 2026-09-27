import { withAdmin } from '@arkiv/db';
import { appEnv, effectiveFlag, SETTING_DEFAULTS } from '@arkiv/core';
import { ActButton, ActForm } from '@/components/act';
import { dt, Mono, Page, Section, Table } from '@/components/ui';
import { requireStaff } from '@/lib/staff';

export const metadata = { title: 'Flags & config' };

const RULE_HINTS: Record<string, string> = {
  boolean: '{}',
  percentage: '{"pct": 10}',
  workspace_allowlist: '{"workspaces": ["<workspace id>"]}',
  plan: '{"plans": ["GROWTH", "SCALE"]}',
};

/** Plan 05 §20. Kill switches need a fresh second factor. Flags have a default plus per-environment values. */
export default async function Flags() {
  await requireStaff('flags.manage');
  const d0 = await withAdmin(async (tx) => ({
    flags: await tx`select * from feature_flags order by (key like 'kill.%') desc, key`,
    settings: await tx`select * from platform_settings order by key`,
  }));
  const kills = d0.flags.filter((f) => String(f.key).startsWith('kill.'));
  const flags = d0.flags.filter((f) => !String(f.key).startsWith('kill.'));
  const envName = appEnv();
  const stored = new Set(d0.settings.map((x) => x.key as string));
  return (
    <Page title="Feature flags & config" sub={<>This environment: <Mono>{envName}</Mono>. Per-environment values live under <Mono>{'rules.env'}</Mono>, e.g. <Mono>{'{"pct": 5, "env": {"staging": {"pct": 100}}}'}</Mono>.</>}>
      <Section title="Kill switches">
        <Table head={['Switch', 'What it does', 'State', '']} rows={kills.map((f) => [<Mono key="k">{f.key as string}</Mono>, f.description as string, f.enabled ? <span key="s" className="ak-chip ak-chip--risk">ON</span> : 'off',
          <ActButton key="t" small danger={!f.enabled} action="flag.set" payload={{ key: f.key, enabled: !f.enabled }} reason confirm={f.enabled ? 'Turn off?' : 'Turn ON this kill switch? It takes effect immediately.'}>{f.enabled ? '🔐 Turn off' : '🔐 Turn on'}</ActButton>])} />
      </Section>
      <Section title="Flags">
        <Table head={['Key', 'Description', 'Owner', 'Kind', 'Default', `In ${envName}`, 'Rules', 'Expires', '']} rows={flags.map((f) => {
          const expired = f.expires_at && new Date(f.expires_at as string) < new Date();
          const eff = effectiveFlag(f.enabled as boolean, f.rules as never, envName);
          return [<Mono key="k">{f.key as string}</Mono>, f.description as string, f.owner as string, f.kind as string, f.enabled ? 'on' : 'off', expired ? 'off (expired)' : eff.enabled ? 'on' : 'off', <Mono key="r">{JSON.stringify(f.rules)}</Mono>,
            <span key="e" style={{ color: expired ? 'var(--risk)' : undefined }}>{f.expires_at ? dt(f.expires_at) : '—'}{expired ? ' · owner alerted daily' : ''}</span>,
            <ActForm key="f" inline action="flag.set" extra={{ key: f.key }} submit="Save" fields={[{ name: 'enabled', label: 'On (default)', type: 'checkbox', defaultValue: f.enabled as boolean }, { name: 'rules', label: 'Rules JSON', type: 'json', defaultValue: JSON.stringify(f.rules), placeholder: RULE_HINTS[f.kind as string] }, { name: 'reason', label: 'Reason', required: true }]} />];
        })} />
        <div className="ak-panel" style={{ maxWidth: 560, marginTop: 12 }}>
          <ActForm action="flag.create" submit="Create flag" fields={[{ name: 'key', label: 'Key', required: true }, { name: 'description', label: 'Description', required: true }, { name: 'owner', label: 'Owner (email, staff name or role)', required: true }, { name: 'kind', label: 'Kind', type: 'select', options: ['boolean', 'percentage', 'workspace_allowlist', 'plan'] }, { name: 'expiresAt', label: 'Expiry', type: 'date' }]} />
        </div>
      </Section>
      <Section title="Platform settings">
        <p className="ak-small ak-muted">Wired into the app (code default used when unset): {Object.keys(SETTING_DEFAULTS).map((k, i) => <span key={k}>{i ? ', ' : ''}<Mono>{k}</Mono>{stored.has(k) ? '' : ' (default)'}</span>)}. Changes apply within 30 seconds.</p>
        <Table head={['Key', 'Value', 'Updated', '']} rows={d0.settings.map((x) => [<Mono key="k">{x.key as string}</Mono>, <Mono key="v">{JSON.stringify(x.value)}</Mono>, dt(x.updated_at),
          <ActForm key="f" inline action="setting.set" extra={{ key: x.key }} submit="Save" fields={[{ name: 'value', label: 'Value (JSON)', type: 'json', defaultValue: JSON.stringify(x.value) }, { name: 'reason', label: 'Reason', required: true }]} />])} />
        {Object.keys(SETTING_DEFAULTS).some((k) => !stored.has(k)) ? (
          <div className="ak-panel" style={{ maxWidth: 560, marginTop: 12 }}>
            <ActForm action="setting.set" submit="Add setting" fields={[
              { name: 'key', label: 'Key', type: 'select', options: Object.keys(SETTING_DEFAULTS).filter((k) => !stored.has(k)) },
              { name: 'value', label: 'Value (JSON)', type: 'json', required: true },
              { name: 'reason', label: 'Reason', required: true },
            ]} />
          </div>
        ) : null}
      </Section>
    </Page>
  );
}
