import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { LinkButton } from '@arkiv/ui';
import { requireUser } from '@/lib/session';
import { connectShopifyPath, launchedShop, SHOPIFY_INSTALL_COOKIE } from '@/lib/shopify-install';
import { userWorkspaces } from '@/lib/tenant';

export const metadata: Metadata = { title: 'Connect your Shopify store', robots: { index: false } };

const CAN_CONNECT = new Set(['OWNER', 'ADMIN']);
const LIVE = new Set(['ACTIVE_FREE', 'ACTIVE_PAID', 'PAST_DUE', 'CANCELLED']);

/**
 * Plan 06 Phase 5 #1: the merchant came from Shopify (App Store install, or the app opened from their admin). They
 * sign in (or sign up), then choose which of their workspaces the store belongs to; the store's OAuth then starts
 * from that workspace, exactly as when connecting from Arkiv.
 */
export default async function ConnectShopify({ searchParams }: { searchParams: Promise<{ shop?: string; error?: string }> }) {
  const sp = await searchParams;
  const shop = launchedShop((await cookies()).get(SHOPIFY_INSTALL_COOKIE)?.value, sp.shop);
  if (sp.error || !shop) {
    return (
      <div className="ak-wrap ak-section" style={{ maxWidth: 520 }}>
        <p className="ak-label">Shopify</p>
        <h1 className="ak-h1">Open Arkiv from Shopify again</h1>
        <p className="ak-muted">This link has expired or didn’t come from your Shopify admin. In Shopify, go to Apps → Arkiv to start again, or connect your store from Arkiv’s Settings → Integrations.</p>
      </div>
    );
  }
  const user = await requireUser(connectShopifyPath(shop));
  const workspaces = (await userWorkspaces(user.userId)).filter((w) => CAN_CONNECT.has(w.role as string) && LIVE.has(w.state as string));
  return (
    <div className="ak-wrap ak-section" style={{ maxWidth: 520 }}>
      <p className="ak-label">Shopify</p>
      <h1 className="ak-h1">Connect {shop}</h1>
      {workspaces.length ? (
        <>
          <p className="ak-muted">Choose the brand this store belongs to. Shopify will ask you to approve read-only access to your products.</p>
          <ul className="ak-stack" style={{ listStyle: 'none', padding: 0 }}>
            {workspaces.map((w) => (
              <li key={w.workspace_id as string} className="ak-between">
                <span>{w.name as string}</span>
                <LinkButton href={`/api/w/${w.slug as string}/connect/shopify?${new URLSearchParams({ shop })}`}>Connect here</LinkButton>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="ak-muted">You’re signed in as {user.email}, but you aren’t an owner or admin of an Arkiv workspace. Ask your workspace owner to connect the store, or sign in with another account.</p>
      )}
    </div>
  );
}
