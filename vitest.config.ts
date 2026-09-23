import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts', 'tests/unit/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/.next/**'],
    globalSetup: ['./tests/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    env: {
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://dev:dev@localhost:5432/arkiv_test',
      APP_DATABASE_URL: process.env.TEST_APP_DATABASE_URL ?? 'postgres://app_rw:app_rw@localhost:5432/arkiv_test',
      ADMIN_DATABASE_URL: process.env.TEST_ADMIN_DATABASE_URL ?? 'postgres://admin_rw:admin_rw@localhost:5432/arkiv_test',
      PROVIDERS_MODE: 'mock',
      STORAGE_DRIVER: 'local',
      STORAGE_LOCAL_DIR: '.storage/test',
      APP_SECRET: 'test-secret-test-secret-test-secret-00',
      NODE_ENV: 'test',
    },
  },
});
