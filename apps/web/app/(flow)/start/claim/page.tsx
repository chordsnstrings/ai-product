import type { Metadata } from 'next';
import { readClaimToken, safeRedirect } from '@arkiv/auth';
import { globalTx, withTenant } from '@arkiv/db';
import { LinkButton } from '@arkiv/ui';
import { requireUser } from '@/lib/session';
import { ClaimChoice } from './choice';

export const metadata: Metadata = { title: 'Save your product', robots: { index: false } };

const WRITABLE = ['OWNER', 'ADMIN', 'MEMBER'];

/**
 * After signing in to an existing account with a free preview in hand (plan 02 §2.1): "Add this product to
 * Workspace X" or "Create a new workspace". Also the honest answer when the preview was already saved elsewhere.
 */
export default async function Page({ searchParams }: { searchParams: Promise<{ c?: string; next?: string; state?: string }> }) {
  const sp = await searchParams;
  const u = await requireUser(`/start/claim?${new URLSearchParams(Object.entries(sp).filter((e): e is [string, string] => typeof e[1] === 'string'))}`);
  const claim = sp.c ? readClaimToken(sp.c, u.userId) : null;
  const state = claim
    ? ((await withTenant(claim.provisionalWorkspaceId, (tx) => tx`select state from workspaces where id = ${claim.provisionalWorkspaceId}`))[0]?.state as string | undefined)
    : undefined;
  if (!claim || state !== 'PROVISIONAL') {
    const taken = sp.state === 'taken' || (claim && state);
    return (
      <div className="ak-wrap ak-section" style={{ maxWidth: 520 }}>
        <h1 className="ak-h1">{taken ? 'This preview was already saved' : 'This choice has expired'}</h1>
        <p className="ak-muted">
          {taken
            ? 'The free preview you were working on has been saved to another Arkiv account, so it can’t be added to this one. If that was you, sign in with that account instead.'
            : 'The preview is still saved on the device you started on. Open it there to keep going, or start a new one.'}
        </p>
        <div className="ak-row" style={{ marginTop: 24 }}>
          <LinkButton href="/app">Go to my workspace</LinkButton>
          <LinkButton href="/start" variant="secondary">Start a new preview</LinkButton>
        </div>
      </div>
    );
  }
  const [sku] = await withTenant(claim.provisionalWorkspaceId, (tx) => tx`select name from skus order by created_at desc limit 1`);
  const productName = (sku?.name as string) ?? 'your product';
  const workspaces = (await globalTx((tx) => tx`select * from list_user_workspaces(${u.userId})`)).filter((w) => WRITABLE.includes(w.role as string));
  const options = workspaces
    .map((w) => ({ id: w.workspace_id as string, name: w.name as string }))
    .sort((a, b) => (a.id === u.lastWorkspaceId ? -1 : b.id === u.lastWorkspaceId ? 1 : 0));
  return (
    <div className="ak-wrap ak-section" style={{ maxWidth: 520 }}>
      <h1 className="ak-h1">Where should {productName} go?</h1>
      <p className="ak-muted">You already have an Arkiv account. Add the product and its ideas to one of your workspaces, or keep it in a new workspace of its own.</p>
      <ClaimChoice token={sp.c!} next={safeRedirect(sp.next)} productName={productName} options={options} />
    </div>
  );
}
