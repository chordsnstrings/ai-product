import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import postgres from 'postgres';

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');

export async function migrate(url: string, log: (m: string) => void = () => {}): Promise<string[]> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await sql`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`;
    const applied = new Set((await sql`select name from schema_migrations`).map((r) => r.name as string));
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    const ran: string[] = [];
    for (const f of files) {
      if (applied.has(f)) continue;
      const body = await readFile(path.join(MIGRATIONS_DIR, f), 'utf8');
      await sql.begin(async (tx) => {
        await tx.unsafe(body);
        await tx`insert into schema_migrations (name) values (${f})`;
      });
      log(`applied ${f}`);
      ran.push(f);
    }
    return ran;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** Dev/test only: drop everything in public (roles are cluster-level and survive). */
export async function resetDatabase(url: string): Promise<void> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await sql.unsafe(`
      drop schema if exists public cascade;
      drop schema if exists pgboss cascade;
      create schema public;
      grant all on schema public to public;
    `);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** Dev/test only: give the three runtime roles passwords equal to their names. */
export async function setDevRolePasswords(url: string): Promise<void> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    for (const r of ['app_rw', 'admin_rw', 'system_rw']) {
      await sql.unsafe(`do $$ begin
        if not exists (select 1 from pg_roles where rolname = '${r}') then create role ${r} login; end if;
      end $$; alter role ${r} with login password '${r}';`);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * Production bootstrap: set runtime role passwords from secrets (APP_DB_PASSWORD, ADMIN_DB_PASSWORD,
 * SYSTEM_DB_PASSWORD). Idempotent; run by the pre-deploy migrate job. Passwords never appear in migrations.
 */
export async function setRolePasswords(url: string, passwords: Partial<Record<'app_rw' | 'admin_rw' | 'system_rw', string>>): Promise<string[]> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  const done: string[] = [];
  try {
    for (const [role, pw] of Object.entries(passwords)) {
      if (!pw) continue;
      if (pw.length < 24) throw new Error(`${role} password must be at least 24 characters`);
      await sql.unsafe(`do $$ begin if not exists (select 1 from pg_roles where rolname = '${role}') then create role ${role} login; end if; end $$;`);
      // Role names are fixed identifiers; the password literal is built by Postgres' format('%L') (no injection).
      const [q] = await sql`select format('alter role %I with login password %L', ${role}::text, ${pw}::text) as stmt`;
      await sql.unsafe(q!.stmt as string);
      done.push(role);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
  return done;
}
