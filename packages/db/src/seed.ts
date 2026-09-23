import { ownerPool } from './client';

/** Dev seed: a demo founder with one workspace. Staff accounts are created with `pnpm --filter @arkiv/admin staff:create`. */
export async function seedDev() {
  const sql = ownerPool();
  const [u] = await sql`insert into users (email, name, email_verified_at) values ('founder@glowlab.test', 'Demo Founder', now())
                        on conflict (email) do update set name = excluded.name returning id`;
  const [w] = await sql`insert into workspaces (slug, name, state) values ('glowlab', 'Glow Lab', 'ACTIVE_FREE')
                        on conflict (slug) do update set name = excluded.name returning id`;
  await sql`insert into memberships (workspace_id, user_id, role) values (${w!.id}, ${u!.id}, 'OWNER') on conflict do nothing`;
  await sql`insert into brands (workspace_id, name) select ${w!.id}, 'Glow Lab' where not exists (select 1 from brands where workspace_id = ${w!.id})`;
  console.log('seeded founder@glowlab.test → workspace /w/glowlab');
  await sql.end();
}
