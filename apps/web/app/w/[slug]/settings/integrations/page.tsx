import type { Metadata } from 'next';
import { withTenant } from '@arkiv/db';
import { freshness } from '@arkiv/core';
import { env } from '@arkiv/shared';
import { Banner } from '@arkiv/ui';
import { ActionButton } from '@/components/actions';
import { workspacePage } from '@/lib/tenant';

export const metadata: Metadata = { title: 'Integrations · Arkiv' };

const INFO = {
  shopify: { name: 'Shopify', what: 'Imports product titles, prices, images and variants. Read-only (read_products).', configured: () => !!env().SHOPIFY_API_KEY },
  meta: { name: 'Meta Ads', what: 'Reads ad-level daily insights so results link to your variants. Read-only (ads_read); we never change campaigns.', configured: () => !!env().META_APP_ID },
  tiktok: { name: 'TikTok Ads', what: 'Reads ad reports, keeping GMV Max results separate from paid-only results. Read-only.', configured: () => !!env().TIKTOK_APP_ID },
} as const;

export default async function Integrations({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ result?: string }> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const w = await workspacePage(slug);
  const d = await withTenant(w.ctx.workspaceId, async (tx) => ({
    rows: await tx`select id, provider, display_name, external_account_id, status, scopes, last_success_at, error from integrations where status <> 'disconnected' order by provider, created_at`,
    fresh: await freshness(tx),
  }));
  const canManage = ['OWNER', 'ADMIN'].includes(w.ctx.role);
  const mock = env().PROVIDERS_MODE === 'mock';
  return (
    <div className="ak-stack" style={{ ['--stack' as string]: '24px' }}>
      {sp.result ? <Banner>{sp.result}</Banner> : null}
      {(Object.keys(INFO) as (keyof typeof INFO)[]).map((p) => {
        const conns = d.rows.filter((r) => r.provider === p);
        const info = INFO[p];
        return (
          <section key={p} className="ak-panel">
            <div className="ak-between" style={{ flexWrap: 'wrap', gap: 12 }}>
              <div>
                <h2 className="ak-h2" style={{ margin: 0 }}>{info.name}</h2>
                <p className="ak-small ak-muted" style={{ maxWidth: 520 }}>{info.what}</p>
              </div>
              {canManage ? (
                p === 'shopify' ? (
                  <form action={`/api/w/${slug}/connect/shopify`} method="get" className="ak-row" style={{ alignItems: 'end' }}>
                    <label className="ak-field">
                      <span className="ak-label">Shopify store domain</span>
                      <input className="ak-input" name="shop" placeholder="your-store.myshopify.com" required />
                    </label>
                    <button className="ak-btn" type="submit" disabled={!info.configured()}>Connect</button>
                  </form>
                ) : info.configured() ? (
                  <a className="ak-btn" href={`/api/w/${slug}/connect/${p}`}>{conns.length ? 'Add account' : 'Connect'}</a>
                ) : mock ? (
                  <ActionButton slug={slug} action="integration-demo" body={{ provider: p }}>Connect demo account</ActionButton>
                ) : (
                  <span className="ak-small ak-muted">Coming soon</span>
                )
              ) : null}
            </div>
            {conns.map((c) => {
              const f = d.fresh.find((x) => x.provider === p);
              return (
                <div key={c.id as string} className="ak-index-row">
                  <span>
                    {(c.display_name as string) ?? c.external_account_id}
                    <span className="ak-small ak-muted" style={{ display: 'block' }}>{c.status === 'active' ? f?.label : `${c.status}${(c.error as { message?: string } | null)?.message ? ` — ${(c.error as { message: string }).message}` : ''}`} · {(c.scopes as string[]).join(', ')}</span>
                  </span>
                  {canManage ? (
                    <span className="ak-row">
                      <ActionButton slug={slug} action="integration-sync" body={{ id: c.id }} variant="text">Sync now</ActionButton>
                      <ActionButton slug={slug} action="integration-disconnect" body={{ id: c.id }} variant="text" confirm={`Disconnect ${info.name}? We'll delete the access token. Past data stays in your archive.`}>Disconnect</ActionButton>
                    </span>
                  ) : null}
                </div>
              );
            })}
          </section>
        );
      })}
      <p className="ak-small ak-muted">No ad account access? Upload a CSV from Results instead.</p>
    </div>
  );
}
