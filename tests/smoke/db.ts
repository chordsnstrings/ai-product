import { withSystem, withTenant } from '@arkiv/db';

/** Smoke-test helpers that read state directly (RLS-scoped through the tenant resolved by slug). */
async function ws(slug: string) {
  const [w] = await withSystem((tx) => tx`select id from workspaces where slug = ${slug}`);
  return w!.id as string;
}
export async function openRecommendations(slug: string) {
  const id = await ws(slug);
  return { rows: await withTenant(id, (tx) => tx`select id from recommendations where status = 'open' order by score desc`) };
}
export async function experimentState(slug: string, experimentId: string) {
  const id = await ws(slug);
  return withTenant(id, async (tx) => {
    const [e] = await tx`select state from experiments where id = ${experimentId}`;
    const v = await tx`select code from variants where experiment_id = ${experimentId} order by code`;
    return { state: e!.state as string, codes: v.map((x) => x.code as string) };
  });
}
