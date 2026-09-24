import type { Metadata } from 'next';
import { withTenant } from '@arkiv/db';
import { freshness, listShopTransfers, pendingConnection, readShopTransferProof, type SyncError } from '@arkiv/core';
import { unavailableFeatures } from '@arkiv/integrations';
import { env } from '@arkiv/shared';
import { Banner } from '@arkiv/ui';
import { ActionButton, ActionForm } from '@/components/actions';
import { workspacePage } from '@/lib/tenant';

export const metadata: Metadata = { title: 'Integrations · Arkiv' };

const INFO = {
  shopify: { name: 'Shopify', what: 'Imports product titles, prices, images and variants. Read-only (read_products).', configured: () => !!env().SHOPIFY_API_KEY },
  meta: { name: 'Meta Ads', what: 'Reads ad-level daily insights so results link to your variants. Read-only (ads_read); we never change campaigns.', configured: () => !!env().META_APP_ID },
  tiktok: { name: 'TikTok Ads', what: 'Reads ad reports, keeping GMV Max results separate from paid-only results. Read-only.', configured: () => !!env().TIKTOK_APP_ID },
} as const;

export default async function Integrations({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ result?: string; pick?: string; transfer?: string }> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const w = await workspacePage(slug);
  const d = await withTenant(w.ctx.workspaceId, async (tx) => ({
    rows: await tx`select id, provider, display_name, external_account_id, status, scopes, last_success_at, error, token_expires_at from integrations where status <> 'disconnected' order by provider, created_at`,
    transfers: await listShopTransfers(tx, w.ctx.workspaceId),
    fresh: await freshness(tx),
    // An OAuth login that can read several ad accounts waits here for the merchant's choice (§47).
    pick: sp.pick && /^[0-9a-f-]{36}$/i.test(sp.pick) ? await pendingConnection(tx, sp.pick) : null,
  }));
  const canManage = ['OWNER', 'ADMIN'].includes(w.ctx.role);
  const mock = env().PROVIDERS_MODE === 'mock';
  // A store connected to another workspace: this user's OAuth for it is the proof a transfer request needs.
  const proof = sp.transfer ? readShopTransferProof(sp.transfer) : null;
  const transferable = proof && proof.workspaceId === w.ctx.workspaceId && proof.userId === w.user?.id ? proof : null;
  const when = (x: string | Date) => new Date(x).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  /** What the merchant sees about a connection's state: the reason in plain words, never a raw platform error. */
  const statusLine = (c: Record<string, unknown>, freshLabel: string | undefined) => {
    const e = c.error as (Partial<SyncError> & { reason?: string }) | null;
    if (c.status === 'revoked') return 'Access revoked or expired — reconnect to keep results syncing';
    if (c.status === 'paused') return 'Sync paused by Arkiv support';
    if (e?.kind === 'partial_scopes') return 'A permission is missing — some features are unavailable (below)';
    if (e?.kind === 'schema_changed') return 'The platform changed its report format. Imports are paused while we update; your past results are safe.';
    if (e?.kind === 'network' || e?.kind === 'invalid' || e?.kind === 'rate_limited') {
      return `${c.status === 'degraded' ? 'Sync is failing' : 'The platform had a temporary problem'} — retrying automatically${e.nextRetryAt ? ` after ${new Date(e.nextRetryAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}` : ''}. ${freshLabel ?? ''}`.trim();
    }
    return c.status === 'active' ? freshLabel : String(c.status);
  };
  return (
    <div className="ak-stack" style={{ ['--stack' as string]: '24px' }}>
      {sp.result ? <Banner>{sp.result}</Banner> : null}
      {sp.pick && !d.pick ? <Banner tone="risk">That connection expired. Connect again to choose your ad accounts.</Banner> : null}
      {transferable && canManage ? (
        <section className="ak-panel" aria-labelledby="shop-transfer">
          <h2 id="shop-transfer" className="ak-h2" style={{ marginTop: 0 }}>Move {transferable.shop} to this workspace?</h2>
          <p className="ak-small ak-muted" style={{ maxWidth: 560 }}>
            The store is connected to another Arkiv workspace. We’ll ask that workspace’s owner to approve. If nobody answers within 14 days, Arkiv support can approve it, because you just signed in to the store through Shopify.
          </p>
          <ActionButton slug={slug} action="shop-transfer-request" body={{ proof: sp.transfer }}>Request transfer</ActionButton>
        </section>
      ) : null}
      {d.transfers.length ? (
        <section className="ak-panel" aria-labelledby="transfers">
          <h2 id="transfers" className="ak-h2" style={{ marginTop: 0 }}>Store transfers</h2>
          {d.transfers.map((t) => (
            <div key={t.id} className="ak-index-row">
              <span>
                {t.shop}
                <span className="ak-small ak-muted" style={{ display: 'block' }}>
                  {t.direction === 'incoming'
                    ? `${t.requester} asked to move this store to their workspace · ${when(t.createdAt)} · ${t.status}`
                    : `You asked to move this store here · ${when(t.createdAt)} · ${t.status === 'approved' ? 'approved — connect the store below to finish' : t.status}`}
                </span>
              </span>
              {t.direction === 'incoming' && t.status === 'pending' && w.ctx.role === 'OWNER' ? (
                <span className="ak-row">
                  <ActionButton slug={slug} action="shop-transfer-decide" body={{ id: t.id, decision: 'approve' }} variant="text" confirm={`Move ${t.shop} to the other workspace? Its Shopify connection here is disconnected; past data stays with you.`}>Approve</ActionButton>
                  <ActionButton slug={slug} action="shop-transfer-decide" body={{ id: t.id, decision: 'reject' }} variant="text">Reject</ActionButton>
                </span>
              ) : null}
            </div>
          ))}
        </section>
      ) : null}
      {d.pick && canManage ? (
        <section className="ak-panel" aria-labelledby="pick-accounts">
          <h2 id="pick-accounts" className="ak-h2" style={{ marginTop: 0 }}>Which {d.pick.provider === 'meta' ? 'Meta' : 'TikTok'} ad accounts are this brand’s?</h2>
          <p className="ak-small ak-muted" style={{ maxWidth: 560 }}>
            Your login can read {d.pick.accounts.length} ad accounts. Connect only the ones that advertise this brand — results from other brands’ accounts would mix into your tests.
          </p>
          <ActionForm
            slug={slug}
            action="integration-select"
            extra={{ pendingId: d.pick.id }}
            submit="Connect selected accounts"
            fields={[
              { name: 'accountIds', label: 'Ad accounts', type: 'checkboxes', options: d.pick.accounts.map((a) => ({ value: a.id, label: `${a.name}${a.currency ? ` · ${a.currency}` : ''}${a.timezone ? ` · ${a.timezone}` : ''}` })), checked: d.pick.connected },
              { name: 'mode', label: 'Accounts already connected', type: 'select', defaultValue: 'add', options: [{ value: 'add', label: 'Keep them connected too' }, { value: 'replace', label: 'Switch: disconnect the ones not selected (their past results stay)' }] },
            ]}
          />
        </section>
      ) : null}
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
                    <span className="ak-small ak-muted" style={{ display: 'block' }}>{statusLine(c, f?.label)} · {(c.scopes as string[]).join(', ') || 'no permissions recorded'}</span>
                    {c.token_expires_at && c.status !== 'revoked' ? <span className="ak-small ak-muted" style={{ display: 'block' }}>Access expires {when(c.token_expires_at as string)} — reconnect before then</span> : null}
                    {/* §47 "Partial scopes": exactly which features are unavailable, and a re-ask for only that permission. */}
                    {unavailableFeatures(p, c.scopes as string[]).map((u) => (
                      <span key={u.scope} className="ak-small" style={{ display: 'block' }}>
                        Unavailable because “{u.scope}” wasn’t granted: {u.features.join('; ') || 'reading from this account'}.{' '}
                        {canManage && p === 'meta' && info.configured() ? <a className="ak-textbtn" href={`/api/w/${slug}/connect/meta?scopes=${encodeURIComponent(u.scope)}`}>Grant {u.scope}</a> : null}
                      </span>
                    ))}
                  </span>
                  {canManage ? (
                    <span className="ak-row">
                      <ActionButton slug={slug} action="integration-sync" body={{ id: c.id }} variant="text">Sync now</ActionButton>
                      {p !== 'shopify' && info.configured() ? <a className="ak-textbtn" href={`/api/w/${slug}/connect/${p}`}>Switch account</a> : null}
                      <ActionButton slug={slug} action="integration-disconnect" body={{ id: c.id }} variant="text" danger confirm={`Disconnect ${info.name}? We'll delete the access token. Past data stays in your archive.`}>Disconnect</ActionButton>
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
