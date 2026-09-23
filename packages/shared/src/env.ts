import { z } from 'zod';

/**
 * Environment contract. Secrets live in DigitalOcean App Platform encrypted env vars (never in git).
 * Provider keys are optional: when absent, PROVIDERS_MODE=mock makes adapters deterministic fakes.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_URL: z.string().default('http://localhost:3000'),
  ADMIN_URL: z.string().default('http://localhost:3001'),
  APP_SECRET: z.string().min(32).default('dev-secret-dev-secret-dev-secret-0000'),

  DATABASE_URL: z.string().default('postgres://dev:dev@localhost:5432/arkiv'), // migrator (owner)
  APP_DATABASE_URL: z.string().default('postgres://app_rw:app_rw@localhost:5432/arkiv'), // RLS-bound
  ADMIN_DATABASE_URL: z.string().default('postgres://admin_rw:admin_rw@localhost:5432/arkiv'), // BYPASSRLS, audited

  PROVIDERS_MODE: z.enum(['mock', 'live']).default('mock'),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default('claude-opus-5-5'),
  ARK_API_KEY: z.string().optional(),
  ARK_BASE_URL: z.string().default('https://ark.ap-southeast.bytepluses.com/api/v3'),
  SEEDREAM_MODEL: z.string().default('dola-seedream-5-0-pro-260628'),
  SEEDANCE_MODEL: z.string().default('dreamina-seedance-2-0-260128'),
  MINIMAX_API_KEY: z.string().optional(),
  MINIMAX_BASE_URL: z.string().default('https://api.minimax.io'),
  MINIMAX_TTS_MODEL: z.string().default('speech-2.8-hd'),
  BYTEPLUS_SPEECH_APP_ID: z.string().optional(),
  BYTEPLUS_SPEECH_TOKEN: z.string().optional(),

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
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | undefined;
export function env(): Env {
  if (!cached) {
    const parsed = EnvSchema.parse(process.env);
    if (parsed.NODE_ENV === 'production') {
      const required: (keyof Env)[] = ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'RESEND_API_KEY'];
      for (const k of required) if (!parsed[k]) throw new Error(`Missing required env ${k} in production`);
      if (parsed.APP_SECRET.startsWith('dev-secret')) throw new Error('APP_SECRET must be set in production');
    }
    cached = parsed;
  }
  return cached;
}
/** Test hook: re-read process.env. */
export function resetEnvCache() {
  cached = undefined;
}
