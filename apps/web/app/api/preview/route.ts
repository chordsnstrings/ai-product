import { globalTx, withTenant } from '@arkiv/db';
import { abuseGate, allowKey, ingestBytes, isMarketplaceUrl, MARKETPLACE_MESSAGE, recordAbuseSignalSafe, recordFunnel, recordFunnelOnce, startPreview, uploadFailureCategory } from '@arkiv/core';
import { DomainError, env } from '@arkiv/shared';
import { clientFingerprint, fileIdentity, idempotencyKeyOf, json, route, withIdempotency } from '@/lib/http';
import { previewContext } from '@/lib/preview-context';
import { visitorId } from '@/lib/session';
import { verifyTurnstile } from '@arkiv/auth';

const uploadedIds = (form: FormData) => [...new Set(form.getAll('assetIds').map(String).filter((x) => /^[0-9a-f-]{36}$/i.test(x)))].slice(0, 6);

/**
 * P2 → start the free preview (plan 04 L2/L5). No account needed: anonymous visitors get a provisional
 * workspace (plan 02 §2.1); signed-in users preview straight into their current workspace. Photos normally
 * arrive already uploaded (`assetIds`, from /api/uploads as they were chosen); `photos` files are the fallback.
 */
export const POST = route(async (req) => {
  const form = await req.formData();
  const url = (form.get('url') as string | null)?.trim() || null;
  const photos = form.getAll('photos').filter((f): f is File => f instanceof File && f.size > 0).slice(0, 6);
  if (!url && !photos.length && !uploadedIds(form).length) throw new DomainError('INVALID', 'Paste your product link or add a photo.');
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
  const client = clientFingerprint(req);
  const ip = client.ip;
  const uploaded = uploadedIds(form);
  // A marketplace link alone is refused now, with what to do instead, rather than dead-ending after the preview starts.
  if (url && isMarketplaceUrl(url) && !photos.length && !uploaded.length) throw new DomainError('INVALID', MARKETPLACE_MESSAGE);

  // Staff enforcement (plan 05 §15): a blocked IP range is refused; a key staff flagged must pass the challenge.
  const gate = await globalTx((tx) => abuseGate(tx, ip, [allowKey.ip(ip)]));
  if (gate.blocked) throw new DomainError('FORBIDDEN', 'Requests from your network are temporarily blocked. Contact support if you think this is a mistake.', { blocked: true });
  const secret = env().TURNSTILE_SECRET;
  if (secret || gate.forceChallenge) {
    // Bots: invisible challenge on submit only (plan 03 P1 edge cases). The form sends the token (UploadModule).
    // A forced challenge with no Turnstile configured can't be passed, so it fails closed.
    const ok = secret ? await verifyTurnstile(form.get('cf-turnstile-response') as string | null, secret, ip) : false;
    if (!ok) throw new DomainError('FORBIDDEN', 'Please confirm you’re human and try again.', { challenge: true });
  }

  const ctx = await previewContext(client, { create: true });
  // Photos uploaded as they were chosen (presigned into quarantine, then validated): they must be this workspace's
  // own product photos, not yet attached to a product.
  if (uploaded.length) {
    const found = await withTenant(ctx.workspaceId, (tx) => tx`select id from assets where id = any(${uploaded}::uuid[]) and kind = 'product_photo' and sku_id is null and deleted_at is null`);
    if (found.length !== uploaded.length) throw new DomainError('CONFLICT', 'One of your photos is no longer available. Please add it again.');
  }
  const assetIds = [...uploaded];
  for (const f of photos) {
    const a = await withTenant(ctx.workspaceId, async (tx) => ingestBytes(tx, ctx, Buffer.from(await f.arrayBuffer()), 'product_photo', null, { filename: f.name }));
    assetIds.push(a.id);
  }
  // §39/§35: one preview per submission. The key is scoped to this (provisional or signed-in) workspace; a double
  // submit or a retried request returns the first product instead of creating a second SKU and project.
  const key = idempotencyKeyOf(req);
  // Multi-brand workspaces can say which brand the product is (§16); the workspace's first brand otherwise.
  const brandId = /^[0-9a-f-]{36}$/i.test(String(form.get('brandId') ?? '')) ? String(form.get('brandId')) : null;
  const request = { url, uploaded, photos: photos.map(fileIdentity), brandId };
  const r = await withTenant(ctx.workspaceId, (tx) => withIdempotency(tx, ctx.workspaceId, 'preview', key, request, () => startPreview(tx, ctx, { url, photoAssetIds: assetIds, visitorId: vid, ip, brandId }))).catch(async (e) => {
    // The free-preview multi-SKU heuristic (plan 05 §15): recorded for trust & safety (the refusal itself rolled back).
    if (e instanceof DomainError && e.code === 'PAYMENT_REQUIRED' && (e.details as { needsAccount?: boolean } | undefined)?.needsAccount) {
      await recordAbuseSignalSafe({ kind: 'multi_sku_limit', key: allowKey.ip(ip) ?? allowKey.ws(ctx.workspaceId)!, workspaceId: ctx.workspaceId, detail: { workspace: ctx.workspaceId } });
    }
    throw e;
  });
  return json({ projectId: r.projectId, skuId: r.skuId, catalogueNo: r.catalogueNo });
}
