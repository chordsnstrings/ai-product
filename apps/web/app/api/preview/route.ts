import { withTenant, globalTx } from '@arkiv/db';
import { allowKey, createProvisionalWorkspace, hit, ingestBytes, recordFunnel, recordFunnelOnce, resolveProvisional, startPreview, uploadFailureCategory, type TenantContext } from '@arkiv/core';
import { DomainError, env } from '@arkiv/shared';
import { clientIp, json, route } from '@/lib/http';
import { currentUser, provisionalToken, setProvisionalCookie, visitorId } from '@/lib/session';
import { verifyTurnstile } from '@/lib/turnstile';

/**
 * P2 → start the free preview (plan 04 L2/L5). No account needed: anonymous visitors get a provisional
 * workspace (plan 02 §2.1); signed-in users preview straight into their current workspace.
 */
export const POST = route(async (req) => {
  const form = await req.formData();
  const url = (form.get('url') as string | null)?.trim() || null;
  const photos = form.getAll('photos').filter((f): f is File => f instanceof File && f.size > 0).slice(0, 6);
  if (!url && !photos.length) throw new DomainError('INVALID', 'Paste your product link or add a photo.');
  const vid = await visitorId();
  const page = (form.get('page') as string) ?? null;
  const variant = (form.get('variant') as string) ?? null;
  const method = url ? 'url' : 'photos';
  // Usually already recorded by the upload intent beacon (/api/funnel/upload-start); one start per attempt.
  await recordFunnelOnce('UPLOAD_STARTED', { visitorId: vid, page, variant, props: { method, via: 'submit' } });
  try {
    return await startUpload(req, form, { url, photos, vid });
  } catch (e) {
    // Drop-off drilldown (plan 05 §4): why this attempt never became a preview (file too big, unsupported page…).
    await recordFunnel('UPLOAD_FAILED', { visitorId: vid, page, variant, props: { method, category: uploadFailureCategory(e), reason: e instanceof DomainError ? e.message.slice(0, 120) : 'error' } }).catch(() => {});
    throw e;
  }
});

async function startUpload(req: Request, form: FormData, input: { url: string | null; photos: File[]; vid: string }) {
  const { url, photos, vid } = input;
  const ip = clientIp(req);

  if (env().TURNSTILE_SECRET) {
    // Bots: invisible challenge on submit only (plan 03 P1 edge cases). The form sends the token (UploadModule).
    const ok = await verifyTurnstile(form.get('cf-turnstile-response') as string | null, env().TURNSTILE_SECRET!, ip);
    if (!ok) throw new DomainError('FORBIDDEN', 'Please confirm you’re human and try again.', { challenge: true });
  }

  const user = await currentUser();
  let ctx: TenantContext;
  if (user) {
    const ws = await globalTx((tx) => tx`select * from list_user_workspaces(${user.userId})`);
    const target = ws.find((w) => w.workspace_id === user.lastWorkspaceId && w.role !== 'VIEWER') ?? ws.find((w) => w.role !== 'VIEWER');
    if (!target) throw new DomainError('FORBIDDEN', 'Your role can’t add products. Ask an admin.');
    ctx = { workspaceId: target.workspace_id, workspaceState: target.state, role: target.role, actor: { kind: 'user', id: user.userId }, requestId: crypto.randomUUID(), planCode: target.plan_code };
  } else {
    let wsId = await resolveProvisional(await provisionalToken());
    if (!wsId) {
      if (ip) await hit(`provisional:ip:${ip.split('.').slice(0, 3).join('.')}`, 15, 3600, undefined, { allow: [allowKey.ip(ip)] });
      const p = await createProvisionalWorkspace();
      await setProvisionalCookie(p.token);
      wsId = p.workspaceId;
    }
    ctx = { workspaceId: wsId, workspaceState: 'PROVISIONAL', role: 'OWNER', actor: { kind: 'provisional', id: wsId }, requestId: crypto.randomUUID() };
  }

  const assetIds: string[] = [];
  for (const f of photos) {
    const a = await withTenant(ctx.workspaceId, async (tx) => ingestBytes(tx, ctx, Buffer.from(await f.arrayBuffer()), 'product_photo', null, { filename: f.name }));
    assetIds.push(a.id);
  }
  const r = await withTenant(ctx.workspaceId, (tx) => startPreview(tx, ctx, { url, photoAssetIds: assetIds, visitorId: vid, ip }));
  return json({ projectId: r.projectId, skuId: r.skuId, catalogueNo: r.catalogueNo });
}
