import { z } from 'zod';

/**
 * Environment contract. Secrets live in DigitalOcean App Platform encrypted env vars (never in git).
 * Provider keys are optional: when absent, PROVIDERS_MODE=mock makes adapters deterministic fakes.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  /** Deployment environment for per-environment feature flag values (e.g. staging vs production); defaults from NODE_ENV. */
  APP_ENV: z.string().regex(/^[a-z][a-z0-9-]{1,30}$/).optional(),
  APP_URL: z.string().default('http://localhost:3000'),
  ADMIN_URL: z.string().default('http://localhost:3001'),
  APP_SECRET: z.string().min(32).default('dev-secret-dev-secret-dev-secret-0000'),

  DATABASE_URL: z.string().default('postgres://dev:dev@localhost:5432/arkiv'), // migrator (owner)
  APP_DATABASE_URL: z.string().default('postgres://app_rw:app_rw@localhost:5432/arkiv'), // RLS-bound
  ADMIN_DATABASE_URL: z.string().default('postgres://admin_rw:admin_rw@localhost:5432/arkiv'), // explicit staff policies, audited in app
  // Cross-tenant system role (dispatcher, sweeps, purge). Must be a DIRECT connection: it uses LISTEN.
  SYSTEM_DATABASE_URL: z.string().optional(),
  /**
   * Database roles this process may open, comma-separated (owner, app, admin, system). Each deployed component sets
   * its own (web: app; admin: app,admin,system; worker: app,admin,system,owner) so a compromised customer app has no
   * RLS-exempt credentials (plan 02 §3 layer 2). Unset (dev, tests): every role.
   */
  DB_ROLES: z.string().regex(/^(owner|app|admin|system)(,(owner|app|admin|system))*$/).optional(),
  // Set when APP/ADMIN URLs go through PgBouncer in transaction mode (DO connection pools): disables prepared statements.
  DB_PGBOUNCER: z.enum(['0', '1']).default('0'),

  PROVIDERS_MODE: z.enum(['mock', 'live']).default('mock'),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default('claude-opus-5-5'),
  ARK_API_KEY: z.string().optional(),
  ARK_BASE_URL: z.string().default('https://ark.ap-southeast.bytepluses.com/api/v3'),
  SEEDREAM_MODEL: z.string().default('dola-seedream-5-0-pro-260628'),
  SEEDANCE_MODEL: z.string().default('dreamina-seedance-2-5-260628'),
  MINIMAX_API_KEY: z.string().optional(),
  MINIMAX_BASE_URL: z.string().default('https://api.minimax.io'),
  MINIMAX_TTS_MODEL: z.string().default('speech-2.8-hd'),
  BYTEPLUS_SPEECH_APP_ID: z.string().optional(),
  BYTEPLUS_SPEECH_TOKEN: z.string().optional(),
  /** Provider voice ids per logical voice, JSON: {"warm_female":{"byteplus-speech":"<speaker id>"}} (see voices.ts). */
  TTS_VOICE_MAP: z.string().optional(),

  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_PUBLISHABLE_KEY: z.string().optional(),
  STRIPE_PRICE_TASTE: z.string().optional(),
  STRIPE_PRICE_STANDALONE: z.string().optional(),
  STRIPE_PRICE_LAUNCH: z.string().optional(),
  STRIPE_PRICE_GROWTH: z.string().optional(),
  STRIPE_PRICE_SCALE: z.string().optional(),

  RESEND_API_KEY: z.string().optional(),
  RESEND_WEBHOOK_SECRET: z.string().optional(),
  EMAIL_FROM: z.string().default('Arkiv <hello@mail.localhost>'),

  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  APPLE_CLIENT_ID: z.string().optional(),
  APPLE_TEAM_ID: z.string().optional(),
  APPLE_KEY_ID: z.string().optional(),
  APPLE_PRIVATE_KEY: z.string().optional(),
  TURNSTILE_SECRET: z.string().optional(),
  /** Public Turnstile site key rendered by the upload form; required whenever TURNSTILE_SECRET is set. */
  TURNSTILE_SITE_KEY: z.string().optional(),

  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_DIR: z.string().default('.storage/dev'),
  SPACES_ENDPOINT: z.string().optional(),
  SPACES_REGION: z.string().default('nyc3'),
  SPACES_BUCKET: z.string().optional(),
  SPACES_KEY: z.string().optional(),
  SPACES_SECRET: z.string().optional(),

  SHOPIFY_API_KEY: z.string().optional(),
  SHOPIFY_API_SECRET: z.string().optional(),
  META_APP_ID: z.string().optional(),
  META_APP_SECRET: z.string().optional(),
  TIKTOK_APP_ID: z.string().optional(),
  TIKTOK_APP_SECRET: z.string().optional(),

  /** 32-byte base64 key for encrypting OAuth tokens at rest (AES-256-GCM). */
  TOKEN_ENCRYPTION_KEY: z.string().default('ZGV2LWtleS1kZXYta2V5LWRldi1rZXktZGV2LWtleSE='),

  /** Bearer token for GET /api/health/metrics (Prometheus text). Unset: the endpoint does not exist (404). */
  METRICS_TOKEN: z.string().min(24).optional(),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | undefined;
export function env(): Env {
  if (!cached) {
    const parsed = EnvSchema.parse(process.env);
    // A secret without a site key would reject every preview (the form could never send a token), and a site
    // key without a secret would show a challenge nobody verifies.
    if (!!parsed.TURNSTILE_SECRET !== !!parsed.TURNSTILE_SITE_KEY) throw new Error('TURNSTILE_SITE_KEY and TURNSTILE_SECRET must be set together');
    if (parsed.NODE_ENV === 'production') {
      const required: (keyof Env)[] = ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'RESEND_API_KEY'];
      for (const k of required) if (!parsed[k]) throw new Error(`Missing required env ${k} in production`);
      if (parsed.APP_SECRET.startsWith('dev-secret')) throw new Error('APP_SECRET must be set in production');
      if (parsed.TOKEN_ENCRYPTION_KEY === EnvSchema.shape.TOKEN_ENCRYPTION_KEY.parse(undefined)) throw new Error('TOKEN_ENCRYPTION_KEY must be set in production');
      if (parsed.STORAGE_DRIVER !== 's3') throw new Error('STORAGE_DRIVER must be s3 (DigitalOcean Spaces) in production');
      if (parsed.PROVIDERS_MODE === 'mock' && process.env.ALLOW_MOCK_PROVIDERS !== '1') throw new Error('PROVIDERS_MODE=mock is not allowed in production');
    }
    cached = parsed;
  }
  return cached;
}
/** Test hook: re-read process.env. */
export function resetEnvCache() {
  cached = undefined;
}
