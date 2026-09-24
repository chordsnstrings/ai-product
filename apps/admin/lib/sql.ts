import type { Tx } from '@arkiv/db';

/**
 * `and <col> is not a test workspace`, unless the console preference includes test accounts (plan 05 §2.3:
 * "A test account must be excluded from every business metric. is_test is filterable everywhere and defaults to
 * excluded"). Rows without a workspace (anonymous visitors) always count.
 */
export function notTest(tx: Tx, prefs: { includeTest: boolean }, col = 'workspace_id') {
  if (prefs.includeTest) return tx``;
  return tx`and (${tx(col)} is null or ${tx(col)} not in (select id from workspaces where is_test))`;
}
