import type { Tx } from '@arkiv/db';
import { CONNECTOR_POLICY } from '@arkiv/core';

/**
 * `and <col> is not a test workspace`, unless the console preference includes test accounts (plan 05 §2.3:
 * "A test account must be excluded from every business metric. is_test is filterable everywhere and defaults to
 * excluded"). Rows without a workspace (anonymous visitors) always count.
 */
export function notTest(tx: Tx, prefs: { includeTest: boolean }, col = 'workspace_id') {
  if (prefs.includeTest) return tx``;
  return tx`and (${tx(col)} is null or ${tx(col)} not in (select id from workspaces where is_test))`;
}

/**
 * Is an integration row fresh: active and synced inside its connector's freshness policy (plan 05 §16, standard §31)?
 * A boolean SQL expression over the columns of `alias` (e.g. `i`), never null.
 */
export function integrationFresh(tx: Tx, alias?: string) {
  const c = (col: string) => (alias ? tx`${tx(alias)}.${tx(col)}` : tx`${tx(col)}`);
  const h = (p: keyof typeof CONNECTOR_POLICY) => CONNECTOR_POLICY[p].freshnessHours;
  return tx`coalesce(${c('status')} = 'active' and ${c('last_success_at')} > now() - make_interval(hours => case ${c('provider')}
              when 'shopify' then ${h('shopify')}::int when 'meta' then ${h('meta')}::int else ${h('tiktok')}::int end), false)`;
}
