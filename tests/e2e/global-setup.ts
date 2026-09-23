import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';

export default function globalSetup() {
  const root = new URL('../../', import.meta.url).pathname;
  rmSync(`${root}.storage/e2e-mail.jsonl`, { force: true });
  execFileSync('npx', ['tsx', 'tests/e2e/setup.ts'], { cwd: root, stdio: 'inherit' });
}
