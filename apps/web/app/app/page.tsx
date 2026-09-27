import { redirect } from 'next/navigation';
import { createWorkspace } from '@arkiv/core';
import { requireUser } from '@/lib/session';
import { userWorkspaces } from '@/lib/tenant';

/** `/app` → the workspace used last (or the first). A signed-in user with no workspace gets one. */
export default async function AppIndex({ searchParams }: { searchParams: Promise<{ subscribed?: string }> }) {
  const sp = await searchParams;
  const user = await requireUser('/app');
  const ws = await userWorkspaces(user.userId);
  const pick = ws.find((w) => w.workspace_id === user.lastWorkspaceId) ?? ws[0];
  const suffix = sp.subscribed ? '?subscribed=1' : '';
  if (pick) redirect(`/w/${pick.slug}/this-week${suffix}`);
  const { slug } = await createWorkspace(user.userId, 'My brand');
  redirect(`/w/${slug}/this-week`);
}
