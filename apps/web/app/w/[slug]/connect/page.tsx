import type { Metadata } from 'next';
import Link from 'next/link';
import { withTenant } from '@arkiv/db';
import { can, freshness } from '@arkiv/core';
import { env } from '@arkiv/shared';
import { Banner } from '@arkiv/ui';
import { ActionButton } from '@/components/actions';
import { currentWizardStep, WIZARD_STEPS, wizardStepAfter, type WizardStep } from '@/lib/connect-wizard';
import { workspacePage } from '@/lib/tenant';

export const metadata: Metadata = { title: 'Connect your accounts' };

const STEP: Record<(typeof WIZARD_STEPS)[number], { name: string; why: string; access: string; configured: () => boolean }> = {
  shopify: {
    name: 'Shopify',
    why: 'Your product titles, prices, variants and images stay in sync, so ads never show an old price or a sold-out shade.',
    access: 'Read-only: products only (read_products).',
    configured: () => !!env().SHOPIFY_API_KEY,
  },
  meta: {
    name: 'Meta Ads',
    why: 'Results link to each variant by the AK code in the ad name, so tests turn into learnings for next week’s plan.',
    access: 'Read-only (ads_read). We never change your campaigns. If your login reads several ad accounts, you choose which are this brand’s.',
    configured: () => !!env().META_APP_ID,
  },
  tiktok: {
    name: 'TikTok Ads',
    why: 'TikTok results are read the same way, with GMV Max kept separate from paid-only results.',
    access: 'Read-only reporting. We never change your campaigns.',
    configured: () => !!env().TIKTOK_APP_ID,
  },
};

/**
 * Day 0–1 connection wizard (plan 03 A8, standard §9): Shopify → Meta → TikTok, one step at a time, each
 * skippable. The OAuth callback returns here, on the next step once a connection succeeds.
 */
export default async function ConnectWizard({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ step?: string; result?: string }> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const w = await workspacePage(slug);
  const fresh = await withTenant(w.ctx.workspaceId, (tx) => freshness(tx));
  const connected = new Set(fresh.map((f) => f.provider as string));
  const step: WizardStep = currentWizardStep(sp.step, connected);
  const canManage = can(w.ctx, 'integration.manage');
  const mock = env().PROVIDERS_MODE === 'mock';
  const next = (s: (typeof WIZARD_STEPS)[number]) => `/w/${slug}/connect?step=${wizardStepAfter(s)}`;
  return (
    <div style={{ maxWidth: 640 }}>
      <p className="ak-index">Set up · {step === 'done' ? 'done' : `step ${WIZARD_STEPS.indexOf(step) + 1} of ${WIZARD_STEPS.length}`}</p>
      <h1 className="ak-h1">Connect your accounts</h1>
      <ol className="ak-row ak-small" style={{ listStyle: 'none', padding: 0, gap: 16 }} aria-label="Steps">
        {WIZARD_STEPS.map((s) => (
          <li key={s} aria-current={s === step ? 'step' : undefined} style={{ fontWeight: s === step ? 600 : 400 }}>
            {connected.has(s) ? '✓ ' : ''}{STEP[s].name}
          </li>
        ))}
      </ol>
      {sp.result ? <Banner>{sp.result}</Banner> : null}
      {!canManage ? <Banner tone="warn">Only the workspace owner or an admin can connect accounts. Ask them to finish this step.</Banner> : null}
      {step === 'done' ? (
        <section className="ak-panel">
          <h2 className="ak-h2" style={{ marginTop: 0 }}>You’re set up</h2>
          <p className="ak-small ak-muted">{connected.size ? `Connected: ${[...connected].map((p) => STEP[p as keyof typeof STEP]?.name ?? p).join(', ')}.` : 'Nothing connected yet — that’s fine. Recommendations work from your product and reviews, and you can connect later.'}</p>
          <div className="ak-row">
            <Link className="ak-btn" href={`/w/${slug}/this-week`}>Go to This Week</Link>
            <Link className="ak-textbtn" href={`/w/${slug}/settings/integrations`}>Manage connections</Link>
          </div>
        </section>
      ) : (
        <section className="ak-panel" aria-labelledby="step-title">
          <h2 id="step-title" className="ak-h2" style={{ marginTop: 0 }}>{STEP[step].name}</h2>
          <p>{STEP[step].why}</p>
          <p className="ak-small ak-muted">{STEP[step].access}</p>
          {connected.has(step) ? (
            <p className="ak-small">Connected · {fresh.find((f) => f.provider === step)?.label}</p>
          ) : canManage ? (
            step === 'shopify' ? (
              <form action={`/api/w/${slug}/connect/shopify`} method="get" className="ak-row" style={{ alignItems: 'end' }}>
                <input type="hidden" name="wizard" value="1" />
                <label className="ak-field">
                  <span className="ak-label">Shopify store domain</span>
                  <input className="ak-input" name="shop" placeholder="your-store.myshopify.com" required autoComplete="url" />
                </label>
                <button className="ak-btn" type="submit" disabled={!STEP.shopify.configured()}>Connect Shopify</button>
              </form>
            ) : STEP[step].configured() ? (
              <a className="ak-btn" href={`/api/w/${slug}/connect/${step}?wizard=1`}>Connect {STEP[step].name}</a>
            ) : mock ? (
              <ActionButton slug={slug} action="integration-demo" body={{ provider: step }} next={next(step)}>Connect demo account</ActionButton>
            ) : (
              <p className="ak-small ak-muted">Coming soon. You can upload a CSV of your ad results from Results meanwhile.</p>
            )
          ) : null}
          <div className="ak-row" style={{ marginTop: 16 }}>
            <Link className={connected.has(step) ? 'ak-btn' : 'ak-textbtn'} href={next(step)}>{connected.has(step) ? 'Continue' : 'Skip for now'}</Link>
          </div>
        </section>
      )}
    </div>
  );
}
