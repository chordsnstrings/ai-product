import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

/**
 * The worker runs under tsx, not vitest/Next, so JSX in @arkiv/email must compile there too. Regression for
 * queued emails (receipts, "your ad is ready") failing with "React is not defined".
 */
describe('email templates under the worker runtime', () => {
  it('render through tsx from the worker package', () => {
    const cwd = new URL('..', import.meta.url).pathname;
    const code = `import { build } from '@arkiv/email'; console.log(build('receipt', { productName: 'Dew Serum', amount: '$19.00', description: 'd', url: 'http://x' }).subject);`;
    const out = execFileSync('npx', ['tsx', '--eval', code], { cwd, encoding: 'utf8' });
    expect(out).toMatch(/Receipt/);
  }, 60_000);
});
