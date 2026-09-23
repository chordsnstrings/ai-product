import { json, route } from '@/lib/http';
import { projectAccess } from '@/lib/tenant';
import { projectView } from '@/lib/views';

/** Single polling endpoint for the funnel (P3–P10). Real server state only. */
export const GET = route(async (_req, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const a = await projectAccess(id);
  const v = await projectView(a.ctx.workspaceId, id);
  return json({ ...v, access: { provisional: a.provisional, signedIn: !!a.user, role: a.ctx.role, workspaceSlug: a.slug || null } });
});
