import postgres from 'postgres';
import { newId } from '@arkiv/shared';
import { ownerPool, withTenant } from './client';

/** Truncate all data tables between tests but keep reference data from migrations. */
const REFERENCE_TABLES = new Set([
  'schema_migrations',
  'table_registry',
  'provider_rate_tables',
  'model_routes',
  'offer_definitions',
  'taxonomy_versions',
  'feature_flags',
  'platform_settings',
  'landing_pages',
  'providers',
]);

export async function truncateAll(): Promise<void> {
  const sql = ownerPool();
  const rows = await sql<{ relname: string }[]>`
    select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'`;
  const names = rows.map((r) => r.relname).filter((n) => !REFERENCE_TABLES.has(n));
  if (names.length) await sql.unsafe(`truncate ${names.map((n) => `"${n}"`).join(', ')} restart identity cascade`);
  await sql`update feature_flags set enabled = false`;
}

/** Create a user + workspace directly (bypassing auth flows) for tests. */
export async function makeTenant(opts: { email?: string; role?: string; state?: string; plan?: string } = {}) {
  const sql = ownerPool();
  const userId = newId();
  const workspaceId = newId();
  const email = opts.email ?? `u-${userId.slice(-8)}@example.com`;
  await sql`insert into users (id, email, email_verified_at) values (${userId}, ${email}, now())`;
  await sql`insert into workspaces (id, slug, name, state, plan_code)
            values (${workspaceId}, ${'ws-' + workspaceId.slice(-8)}, ${'Brand ' + workspaceId.slice(-4)},
                    ${opts.state ?? 'ACTIVE_FREE'}, ${opts.plan ?? null})`;
  await sql`insert into memberships (workspace_id, user_id, role) values (${workspaceId}, ${userId}, ${opts.role ?? 'OWNER'})`;
  const brandId = newId();
  await sql`insert into brands (id, workspace_id, name) values (${brandId}, ${workspaceId}, 'Test Brand')`;
  return { userId, workspaceId, email, brandId, slug: 'ws-' + workspaceId.slice(-8) };
}

export async function makeSku(workspaceId: string, name = 'Serum No. 3') {
  const id = newId();
  await withTenant(workspaceId, async (tx) => {
    const [w] = await tx`update workspaces set next_catalogue_no = next_catalogue_no + 1 returning next_catalogue_no - 1 as no`;
    await tx`insert into skus (id, workspace_id, catalogue_no, name, status, category)
             values (${id}, ${workspaceId}, ${w!.no}, ${name}, 'active', 'serum')`;
  });
  return id;
}

export { postgres };
