import { defineConfig, devices } from '@playwright/test';

/**
 * Browser e2e (plan 06 Phase 6). Runs against web (3000), admin (3001) and the worker with mock providers and
 * mock Stripe. Locally, reuse running servers; in CI web/admin are started here and the worker by the workflow.
 * PW_EXECUTABLE_PATH points at a preinstalled Chromium when the bundled revision isn't downloaded.
 */
const root = new URL('.', import.meta.url).pathname;
const mail = `${root}.storage/e2e-mail.jsonl`;
const env = { EMAIL_DEV_FILE: mail, NEXT_TELEMETRY_DISABLED: '1' };

export default defineConfig({
  testDir: './tests/e2e',
  globalSetup: './tests/e2e/global-setup.ts',
  timeout: 12 * 60_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    launchOptions: process.env.PW_EXECUTABLE_PATH ? { executablePath: process.env.PW_EXECUTABLE_PATH } : {},
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] }, testIgnore: /mobile\.spec\.ts/ },
    { name: 'mobile', use: { ...devices['Pixel 7'] }, testMatch: /mobile\.spec\.ts/ },
  ],
  // The worker has no HTTP port; CI starts it as a separate background step (see .github/workflows/ci.yml).
  webServer: [
    { command: 'pnpm --filter @arkiv/web dev', url: 'http://localhost:3000/api/health', reuseExistingServer: true, timeout: 180_000, env },
    { command: 'pnpm --filter @arkiv/admin dev', url: 'http://localhost:3001/login', reuseExistingServer: true, timeout: 180_000, env },
  ],
});
