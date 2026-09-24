/**
 * Connector contract suite runner (standard §51, plan 05 §16). Runs the connector contract tests and records one
 * result per platform in contract_test_runs, against the API version this build calls — or the version being
 * evaluated, e.g. `CONTRACT_VERSIONS="meta=v24.0"` when the adapter was pointed at a new version. The console only
 * lets staff enable an `api.<platform>_version.<version>` switch flag once a passing run for that version exists.
 *
 *   DATABASE_URL=… pnpm test:contract
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { closeAll, withSystem } from '@arkiv/db';
import { API_VERSIONS, contractResultsByProvider, recordContractRun, type ConnectorProvider } from '@arkiv/core';

const SUITE = 'packages/integrations/src/connectors.test.ts';

async function main() {
  const out = path.join(mkdtempSync(path.join(tmpdir(), 'contract-')), 'report.json');
  let failedRun = false;
  try {
    execFileSync('pnpm', ['vitest', 'run', '--config', 'tests/contract/vitest.config.ts', '--reporter=json', `--outputFile=${out}`], { stdio: 'inherit' });
  } catch {
    failedRun = true; // failures are recorded below from the report
  }
  const report = JSON.parse(readFileSync(out, 'utf8')) as Parameters<typeof contractResultsByProvider>[0];
  const override = Object.fromEntries((process.env.CONTRACT_VERSIONS ?? '').split(',').map((kv) => kv.trim().split('=')).filter((kv) => kv.length === 2 && kv[1]));
  const results = contractResultsByProvider(report);
  const commit = process.env.GIT_COMMIT ?? process.env.GITHUB_SHA ?? null;
  for (const provider of Object.keys(API_VERSIONS) as ConnectorProvider[]) {
    const r = results.get(provider);
    if (!r) continue;
    const apiVersion = override[provider] ?? API_VERSIONS[provider];
    await withSystem((tx) => recordContractRun(tx, { provider, apiVersion, suite: SUITE, passed: r.failed === 0 && r.total > 0, total: r.total, failed: r.failed, commitSha: commit, detail: { failures: r.failures } }));
    console.info(`${provider} ${apiVersion}: ${r.total - r.failed}/${r.total} passed`);
  }
  await closeAll();
  if (failedRun) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
