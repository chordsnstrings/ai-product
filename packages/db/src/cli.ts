import { env } from '@arkiv/shared';
import { dryRunMigrations, migrate, resetDatabase, setDevRolePasswords, setRolePasswords } from './migrate';

const cmd = process.argv[2];
const url = env().DATABASE_URL;

async function main() {
  if (cmd === 'migrate' && process.argv.includes('--dry-run')) {
    // Plan 06 Phase 0 D2: apply every pending migration in one transaction, report timings and lock-heavy DDL,
    // roll back. Exits non-zero when a migration fails.
    const r = await dryRunMigrations(url, console.log);
    const heavy = r.files.reduce((n, f) => n + f.lockHeavy.length, 0);
    console.log(`dry run: ${r.files.length} pending migration(s) applied and rolled back; ${heavy} lock-heavy statement(s) to review`);
    if (r.failed) throw new Error(`migration ${r.failed.name} failed: ${r.failed.error}`);
    return;
  }
  if (cmd === 'reset') {
    if (env().NODE_ENV === 'production') throw new Error('refusing to reset in production');
    await resetDatabase(url);
    console.log('database reset');
  }
  if (cmd === 'migrate' || cmd === 'reset') {
    if (env().NODE_ENV !== 'production') await setDevRolePasswords(url);
    else {
      const set = await setRolePasswords(url, { app_rw: process.env.APP_DB_PASSWORD, admin_rw: process.env.ADMIN_DB_PASSWORD, system_rw: process.env.SYSTEM_DB_PASSWORD });
      if (set.length) console.log(`role passwords set: ${set.join(', ')}`);
    }
    const ran = await migrate(url, console.log);
    console.log(ran.length ? `${ran.length} migration(s) applied` : 'up to date');
  }
  if (cmd === 'seed') {
    const { seedDev } = await import('./seed');
    await seedDev();
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
