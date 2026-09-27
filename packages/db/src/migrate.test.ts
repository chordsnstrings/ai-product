import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { dryRunMigrations, lockHeavyStatements, migrate } from './migrate';

/** Plan 06 Phase 0 D2 "migration dry-run": pending migrations applied in one transaction, reported, rolled back. */
describe('lock-heavy DDL scan', () => {
  it('flags table rewrites and long locks on existing tables, not DDL on a table created in the same file', () => {
    const flagged = lockHeavyStatements(`
      -- a comment; with a semicolon
      create table fresh (id int);
      alter table fresh alter column id set not null;
      create index on fresh (id);
      alter table skus alter column name set not null;
      alter table skus alter column catalogue_no type bigint;
      alter table skus add constraint skus_x check (catalogue_no > 0);
      alter table skus add constraint skus_y check (catalogue_no > 0) not valid;
      create index skus_name on skus (name);
      create index concurrently skus_name2 on skus (name);
      alter table skus add column z int not null;
      alter table skus add column w int not null default 0;
      create function f() returns int language sql as $$ select 1; $$;
    `);
    expect(flagged.map((f) => f.split(':')[0])).toEqual([
      'SET NOT NULL (full scan under lock)',
      'column type change (table rewrite)',
      'constraint validated under lock (add NOT VALID, then VALIDATE)',
      'index built without CONCURRENTLY (blocks writes)',
      'NOT NULL column without a default',
    ]);
  });
});

describe('dry run against a migrated database', () => {
  const base = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL!;
  const u = new URL(base);
  const name = `${u.pathname.slice(1)}_dry`;
  const url = Object.assign(new URL(base), { pathname: `/${name}` }).toString();
  const admin = postgres(base, { max: 1, onnotice: () => {} });

  beforeAll(async () => {
    await admin.unsafe(`drop database if exists ${name}`);
    await admin.unsafe(`create database ${name}`);
    await migrate(url);
  }, 120_000);
  afterAll(async () => {
    await admin.unsafe(`drop database if exists ${name} with (force)`);
    await admin.end({ timeout: 5 });
  });

  it('reports an up-to-date schema as nothing pending', async () => {
    expect(await dryRunMigrations(url)).toEqual({ files: [], failed: null });
  });

  it('applies pending migrations and rolls everything back; a failing one is reported, not thrown', async () => {
    const db = postgres(url, { max: 1, onnotice: () => {} });
    try {
      // An idempotent data migration pending again: it applies cleanly, and nothing it did survives.
      await db`delete from schema_migrations where name = '0122_landing_archetypes.sql'`;
      await db`delete from landing_pages where slug = 'founder'`;
      const ok = await dryRunMigrations(url);
      expect(ok.failed).toBeNull();
      expect(ok.files.map((f) => f.name)).toEqual(['0122_landing_archetypes.sql']);
      expect(await db`select 1 from landing_pages where slug = 'founder'`).toHaveLength(0);
      expect(await db`select 1 from schema_migrations where name = '0122_landing_archetypes.sql'`).toHaveLength(0);
      // A schema migration that is already applied fails when replayed: reported with the error, nothing changed.
      await db`delete from schema_migrations where name = '0123_platform_edges.sql'`;
      const bad = await dryRunMigrations(url);
      expect(bad.failed).toMatchObject({ name: '0123_platform_edges.sql', error: expect.stringMatching(/already exists/) });
    } finally {
      await db.end({ timeout: 5 });
    }
  }, 60_000);
});
