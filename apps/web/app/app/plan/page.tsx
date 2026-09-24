import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { withTenant } from '@arkiv/db';
import { autoRenewText } from '@arkiv/billing';
import { PLANS, formatUsd, type PlanCode } from '@arkiv/shared';
import { requireUser } from '@/lib/session';
import { userWorkspaces } from '@/lib/tenant';
import { Banner } from '@arkiv/ui';
import { ThemeScope } from '@arkiv/ui/client';
import { PlanPicker } from '@/components/plan-picker';

export const metadata: Metadata = { title: 'Choose a plan · Arkiv', robots: { index: false } };

/** P11 in-app: plan choice + the auto-renewal consent box (ROSCA / CA ARL) before any subscription checkout. */
export default async function Page({ searchParams }: { searchParams: Promise<{ plan?: string }> }) {
  const sp = await searchParams;
  const user = await requireUser('/app/plan');
  const ws = await userWorkspaces(user.userId);
  const w = ws.find((x) => x.workspace_id === user.lastWorkspaceId) ?? ws[0];
  if (!w) redirect('/app');
  const [sub] = await withTenant(w.workspace_id as string, (tx) => tx`select plan_code from subscriptions where status in ('active','trialing','past_due') limit 1`);
  if (sub) redirect(`/w/${w.slug}/settings/billing`);
  const initial = (['LAUNCH', 'GROWTH', 'SCALE'].includes(sp.plan ?? '') ? sp.plan : 'GROWTH') as PlanCode;
  const plans = (['LAUNCH', 'GROWTH', 'SCALE'] as const).map((c) => ({ code: c, name: PLANS[c].name, price: formatUsd(PLANS[c].priceMicros, 0), tests: PLANS[c].creativeTestsPerMonth, perTest: formatUsd(PLANS[c].priceMicros / PLANS[c].creativeTestsPerMonth, 0), consent: autoRenewText(c) }));
  return (
    <ThemeScope theme="light">
      <div className="ak-wrap ak-section" style={{ maxWidth: 720 }}>
        <p className="ak-label">{w.name as string}</p>
        <h1 className="ak-h1">Choose your plan</h1>
        <p className="ak-muted">Creative Tests reset monthly. Upgrade, downgrade or cancel online anytime.</p>
        {w.state === 'PURGE_SCHEDULED' ? (
          <Banner tone="warn">This workspace is scheduled for deletion. Cancel the deletion first (Settings → Data), then choose a plan.</Banner>
        ) : w.state === 'SUSPENDED' || w.state === 'LOCKED' ? (
          <Banner tone="warn">This workspace is on hold, so a plan can’t be started right now. Contact support to resolve the hold first.</Banner>
        ) : (
          <PlanPicker slug={w.slug as string} plans={plans} initial={initial} canBuy={['OWNER', 'ADMIN'].includes(w.role as string)} />
        )}
      </div>
    </ThemeScope>
  );
}
