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

export interface DryRunFile {
  name: string;
  ms: number;
  /** Statements that take heavy locks on existing tables (review before a production deploy). */
  lockHeavy: string[];
}

export interface DryRunReport {
  /** Pending migrations, in the order they would run; all applied inside one transaction, then rolled back. */
  files: DryRunFile[];
  /** The first migration that failed (the rest were not tried), with Postgres' error. */
  failed: { name: string; error: string } | null;
}

/**
 * DDL that rewrites or long-locks an existing table (ACCESS EXCLUSIVE, or a full scan under lock). Heuristics over
 * statement text, reported for review — a migration can still be safe (a small table, a table created in the same
 * file); the dry run itself never fails on them.
 */
const LOCK_HEAVY: { re: RegExp; why: string }[] = [
  { re: /\balter\s+column\s+\S+\s+(?:set\s+data\s+)?type\b/i, why: 'column type change (table rewrite)' },
  { re: /\balter\s+column\s+\S+\s+set\s+not\s+null\b/i, why: 'SET NOT NULL (full scan under lock)' },
  { re: /\badd\s+constraint\b(?![^;]*\bnot\s+valid\b)[^;]*\b(?:check|foreign\s+key)\b/i, why: 'constraint validated under lock (add NOT VALID, then VALIDATE)' },
  { re: /\bcreate\s+(?:unique\s+)?index\b(?!\s+concurrently)/i, why: 'index built without CONCURRENTLY (blocks writes)' },
  { re: /\badd\s+column\b[^;]*\bnot\s+null\b(?![^;]*\bdefault\b)/i, why: 'NOT NULL column without a default' },
  { re: /\b(?:drop\s+table|drop\s+column|rename\s+(?:column|to))\b/i, why: 'destructive or renaming DDL (old code may still use it during the deploy)' },
];

/** Split a migration into statements for the lock scan (dollar-quoted bodies are kept whole). */
export function lockHeavyStatements(body: string): string[] {
  const text = body.replace(/--[^\n]*$/gm, '');
  const out: string[] = [];
  const parts = text.split(/(\$\w*\$[\s\S]*?\$\w*\$)/);
  let current = '';
  for (const part of parts) {
    if (/^\$\w*\$/.test(part)) {
      current += part;
      continue;
    }
    const pieces = part.split(';');
    for (let i = 0; i < pieces.length; i++) {
      current += pieces[i];
      if (i < pieces.length - 1) {
        out.push(current.trim());
        current = '';
      }
    }
  }
  if (current.trim()) out.push(current.trim());
  // A table created earlier in the same file is new: nothing else holds it, so its DDL is not lock-heavy.
  const created = new Set(out.map((s) => /^create\s+table\s+(?:if\s+not\s+exists\s+)?(\w+)/i.exec(s)?.[1]?.toLowerCase()).filter(Boolean) as string[]);
  const target = (s: string) => /^(?:alter\s+table\s+(?:only\s+)?(?:if\s+exists\s+)?|create\s+(?:unique\s+)?index\s+\w*\s*on\s+)(\w+)/i.exec(s)?.[1]?.toLowerCase() ?? /\bon\s+(\w+)\s*\(/i.exec(s)?.[1]?.toLowerCase();
  const flagged: string[] = [];
  for (const s of out) {
    const hit = LOCK_HEAVY.find((l) => l.re.test(s));
    if (!hit) continue;
    const t = target(s);
    if (t && created.has(t)) continue;
    flagged.push(`${hit.why}: ${s.replace(/\s+/g, ' ').slice(0, 160)}`);
  }
  return flagged;
}

class DryRunRollback extends Error {}

/**
 * Migration dry run (plan 06 Phase 0 D2 "migration dry-run"): every pending migration is applied, in order, inside
 * ONE transaction against the given database — typically the previous release's schema with data — with statement
 * timings and lock-heavy DDL recorded; then the transaction is rolled back. Nothing is changed. A failing migration
 * is reported (and stops the run) instead of thrown.
 */
export async function dryRunMigrations(url: string, log: (m: string) => void = () => {}): Promise<DryRunReport> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  const report: DryRunReport = { files: [], failed: null };
  try {
    const [exists] = await sql`select to_regclass('public.schema_migrations') is not null as ok`;
    const applied = new Set(exists?.ok ? (await sql`select name from schema_migrations`).map((r) => r.name as string) : []);
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql') && !applied.has(f)).sort();
    await sql
      .begin(async (tx) => {
        for (const f of files) {
          const body = await readFile(path.join(MIGRATIONS_DIR, f), 'utf8');
          const t0 = Date.now();
          try {
            await tx.savepoint((sp) => sp.unsafe(body));
          } catch (e) {
            report.failed = { name: f, error: (e as Error).message };
            log(`FAILED ${f}: ${(e as Error).message}`);
            break;
          }
          const file = { name: f, ms: Date.now() - t0, lockHeavy: lockHeavyStatements(body) };
          report.files.push(file);
          log(`ok ${f} (${file.ms} ms)${file.lockHeavy.map((l) => `\n  lock-heavy: ${l}`).join('')}`);
        }
        throw new DryRunRollback();
      })
      .catch((e) => {
        if (!(e instanceof DryRunRollback)) throw e;
      });
    return report;
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
