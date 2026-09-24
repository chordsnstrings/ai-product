import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAll, ownerPool } from '@arkiv/db';
import { makeSku, makeTenant, truncateAll } from '@arkiv/db/testing';
import { readClaimToken } from '@arkiv/auth';
import { claimProvisional, createProvisionalWorkspace } from '@arkiv/core';
import { afterLogin, settleClaim } from './after-login';

beforeEach(truncateAll);
afterAll(closeAll);

const newUser = async (email: string) => ((await ownerPool()`insert into users (email) values (${email}) returning id`)[0]!.id as string);
const claimed = () => ownerPool()`select props from funnel_events where type = 'ACCOUNT_CLAIMED' order by id`;

describe('after sign-in: the preview joins the account (plan 02 §2.1, plan 03 P6)', () => {
  it('a new user claims the preview; ACCOUNT_CLAIMED carries the sign-in method', async () => {
    const prov = await createProvisionalWorkspace();
    const userId = await newUser('new@glowlab.com');
    expect(await afterLogin({ userId }, prov.workspaceId, '/concepts/abc', 'google')).toBe('/concepts/abc');
    const [m] = await ownerPool()`select role from memberships where user_id = ${userId} and workspace_id = ${prov.workspaceId}`;
    expect(m?.role).toBe('OWNER');
    expect((await claimed()).map((r) => r.props)).toEqual([{ method: 'google', existingAccount: false, target: 'claimed' }]);
  });

  it('an existing user is offered the choice instead of an automatic move, then settles it either way', async () => {
    const home = await makeTenant();
    const prov = await createProvisionalWorkspace();
    const sku = await makeSku(prov.workspaceId, 'Dew Serum');
    const next = await afterLogin({ userId: home.userId }, prov.workspaceId, '/concepts/abc', 'magic_link');
    expect(next).toMatch(/^\/start\/claim\?c=[^&]+&next=%2Fconcepts%2Fabc$/);
    const token = decodeURIComponent(/c=([^&]+)/.exec(next)![1]!);
    expect(readClaimToken(token, home.userId)).toEqual({ provisionalWorkspaceId: prov.workspaceId, method: 'magic_link' });
    // Nothing moved yet.
    expect((await ownerPool()`select workspace_id from skus where id = ${sku}`)[0]!.workspace_id).toBe(prov.workspaceId);

    // Only into a workspace this user can write to.
    const stranger = await makeTenant();
    await expect(settleClaim(home.userId, prov.workspaceId, stranger.workspaceId, 'magic_link')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await settleClaim(home.userId, prov.workspaceId, home.workspaceId, 'magic_link');
    expect((await ownerPool()`select workspace_id from skus where id = ${sku}`)[0]!.workspace_id).toBe(home.workspaceId);
    await expect(settleClaim(home.userId, prov.workspaceId, home.workspaceId, 'magic_link')).rejects.toMatchObject({ code: 'CONFLICT' });

    const prov2 = await createProvisionalWorkspace();
    await settleClaim(home.userId, prov2.workspaceId, 'new', 'passkey');
    const [m] = await ownerPool()`select role from memberships where user_id = ${home.userId} and workspace_id = ${prov2.workspaceId}`;
    expect(m?.role).toBe('OWNER');
    expect((await claimed()).map((r) => r.props)).toEqual([
      { method: 'magic_link', existingAccount: true, target: 'existing_workspace' },
      { method: 'passkey', existingAccount: true, target: 'new_workspace' },
    ]);
  });

  it('a preview already saved to someone else leads to an explicit page, not a silent 404', async () => {
    const prov = await createProvisionalWorkspace();
    const first = await newUser('first@glowlab.com');
    await claimProvisional(prov.workspaceId, first);
    const second = await newUser('second@glowlab.com');
    expect(await afterLogin({ userId: second }, prov.workspaceId, '/concepts/abc', 'magic_link')).toBe('/start/claim?state=taken');
    // The owner signing in again with the same context just continues.
    expect(await afterLogin({ userId: first }, prov.workspaceId, '/concepts/abc', 'magic_link')).toBe('/concepts/abc');
  });

  it('never returns an off-site redirect, and a user with no workspace gets one', async () => {
    const userId = await newUser('solo@glowlab.com');
    const next = await afterLogin({ userId }, null, '/\\evil.com', 'password');
    expect(next).toMatch(/^\/w\/[a-z0-9-]+\/this-week$/);
    expect(await afterLogin({ userId }, null, '//evil.com', 'password')).toBe('/app');
  });
});
