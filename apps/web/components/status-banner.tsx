import { globalTx } from '@arkiv/db';

/** Incident banner published from the admin console (plan 05 §22). Read-only, never blocks rendering. */
export async function StatusBanner() {
  const [row] = await globalTx((tx) => tx`select value from platform_settings where key = 'status.banner'`).catch(() => []);
  const b = row?.value as { text?: string; tone?: 'info' | 'warn' | 'risk' } | null | undefined;
  if (!b?.text) return null;
  return (
    <div role="status" className={`ak-banner${b.tone === 'risk' ? ' ak-banner--risk' : b.tone === 'warn' ? ' ak-banner--warn' : ''}`} style={{ borderRadius: 0, borderLeft: 0, borderRight: 0, textAlign: 'center' }}>
      {b.text}
    </div>
  );
}
