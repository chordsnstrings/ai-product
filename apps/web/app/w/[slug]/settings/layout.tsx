import type { ReactNode } from 'react';
import { SettingsTabs } from '@/components/settings-tabs';

export default async function SettingsLayout({ children, params }: { children: ReactNode; params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return (
    <>
      <h1 className="ak-h1">Settings</h1>
      <SettingsTabs slug={slug} />
      <div style={{ marginTop: 24 }}>{children}</div>
    </>
  );
}
