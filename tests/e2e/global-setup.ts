import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';

export default function globalSetup() {
  const root = new URL('../../', import.meta.url).pathname;
  rmSync(process.env.EMAIL_DEV_FILE || `${root}.storage/e2e-mail.jsonl`, { force: true });
  execFileSync('npx', ['tsx', 'tests/e2e/setup.ts'], { cwd: root, stdio: 'inherit' });
}
