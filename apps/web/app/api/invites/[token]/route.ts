import { acceptInvite } from '@arkiv/core';
import { globalTx } from '@arkiv/db';
import { rememberWorkspace } from '@arkiv/auth';
import { DomainError } from '@arkiv/shared';
import { json, route } from '@/lib/http';
import { currentUser } from '@/lib/session';

export const POST = route(async (_req, { params }: { params: Promise<{ token: string }> }) => {
  const u = await currentUser();
  if (!u) throw new DomainError('UNAUTHENTICATED', 'Please log in.');
  const ws = await acceptInvite((await params).token, { id: u.userId, email: u.email });
  await rememberWorkspace(u.sessionId, ws);
  const [w] = await globalTx((tx) => tx`select slug from list_user_workspaces(${u.userId}) where workspace_id = ${ws}`);
  return json({ next: `/w/${w?.slug}/this-week` });
});
