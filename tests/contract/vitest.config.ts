import { defineConfig } from 'vitest/config';

/** The connector contract suite needs no database: no global setup (which would reset the test database). */
export default defineConfig({
  test: {
    include: ['packages/integrations/src/connectors.test.ts'],
    exclude: ['**/node_modules/**'],
    env: { PROVIDERS_MODE: 'mock', APP_SECRET: 'contract-secret-contract-secret-0000', NODE_ENV: 'test' },
  },
});
