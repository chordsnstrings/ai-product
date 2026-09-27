import { migrate } from '../packages/db/src/migrate';
import { resetDatabase, setDevRolePasswords } from '../packages/db/src/migrate';

/** Fresh schema once per test run. Individual suites truncate between tests. */
export default async function setup() {
  const url = process.env.TEST_DATABASE_URL ?? 'postgres://dev:dev@localhost:5432/arkiv_test';
  await resetDatabase(url);
  await setDevRolePasswords(url);
  await migrate(url);
}
