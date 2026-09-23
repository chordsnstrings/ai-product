import { env } from '@arkiv/shared';
import { migrate, resetDatabase, setDevRolePasswords } from './migrate';

const cmd = process.argv[2];
const url = env().DATABASE_URL;

async function main() {
  if (cmd === 'reset') {
    if (env().NODE_ENV === 'production') throw new Error('refusing to reset in production');
    await resetDatabase(url);
    console.log('database reset');
  }
  if (cmd === 'migrate' || cmd === 'reset') {
    if (env().NODE_ENV !== 'production') await setDevRolePasswords(url);
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
