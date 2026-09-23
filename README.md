# Arkiv — Skincare Creative OS

AI performance-creative operating system for small US DTC skincare brands: **know what skincare ad to
make next, then make it.** The loop is Product Brain → Recommendation → Experiment → Production →
Performance → Learning.

- Product standard (source of truth): [`docs/standard/`](docs/standard/)
- Build plan (design system, multi-tenancy, surfaces, conversion, admin, phases): [`docs/plan/`](docs/plan/00-README.md)

## Layout

```
apps/
  web/       Next.js 16 — marketing, conversion funnel (P1–P11), workspace app (This Week, Map, Studio, …)
  admin/     Next.js 16 — staff console (23 modules, break-glass, four-eyes, audit)
  worker/    pg-boss worker — outbox dispatcher, production jobs, sweeps, staff ops commands
packages/
  shared/    enums, events, env contract, plans & prices, money helpers
  db/        SQL migrations, RLS, role-scoped pools (withTenant / globalTx / withAdmin / withSystem)
  core/      domain: product truth, claims & compliance, creative director, storyboard, production,
             QA, experiments, statistics, recommendations, ledger & cost governor, admin, evals
  providers/ model gateway adapters (Anthropic, BytePlus Seedream/Seedance, MiniMax/BytePlus TTS) + mocks
  media/     FFmpeg composition, loudness, captions, platform exports
  auth/      magic links, Google/Apple OIDC, passkeys, sessions, staff auth (Argon2id + TOTP)
  billing/   Stripe gateway (live + mock), checkout, consent, webhooks
  email/     Resend + React Email templates, suppression, caps
  integrations/ Shopify, Meta, TikTok connectors; token encryption
  ui/        design tokens + components (plain CSS, Radix)
infra/do/    DigitalOcean App Platform spec
tests/       vitest global setup, HTTP smoke tests, Playwright e2e
```

## Local development

Requirements: Node ≥ 22.12, pnpm 10, Postgres 16, FFmpeg.

```bash
pnpm install
createdb arkiv && createdb arkiv_test          # owner role dev:dev by default (see .env.example)
pnpm db:migrate                                # creates app_rw / admin_rw / system_rw and applies migrations
pnpm dev:worker &                              # outbox dispatcher + jobs
pnpm dev:web                                   # http://localhost:3000
pnpm dev:admin                                 # http://localhost:3001
pnpm --filter @arkiv/admin create-staff you@arkiv.app "Your Name" 'a-long-password-here' SUPER_ADMIN
```

Without provider keys everything runs in **mock mode**: deterministic LLM/vision fakes, real media
rendered by FFmpeg, MockStripe checkout at `/checkout/mock/…`, and emails logged (set `EMAIL_DEV_FILE`
for a JSONL outbox you can read magic links from). Add keys from [`.env.example`](.env.example) to go live.

## Tests

```bash
pnpm test                 # vitest: unit + integration against arkiv_test (reset + migrated per run)
pnpm -r typecheck
pnpm smoke                # HTTP: whole funnel + retention loop against running web + worker
pnpm smoke:admin          # HTTP: staff console (login, gating, break-glass, four-eyes, evals, audit)
pnpm e2e                  # Playwright: browser funnel, phone landing, admin console
```

The RLS suite fails CI if any table is unregistered or a tenant table lacks forced RLS.

## Security model (short)

- **Tenancy:** every tenant table has forced RLS keyed on `app.workspace_id`, set per transaction;
  queries without a tenant context fail closed. Staff and system roles use explicit per-table policies
  (no `BYPASSRLS`). See [`docs/plan/02-multi-tenancy.md`](docs/plan/02-multi-tenancy.md).
- **Money:** entitlements live in an append-only ledger; balances are derived. Every billable provider
  call needs a Cost Governor authorization (ceilings per purpose; kill switches).
- **Staff:** separate identities, TOTP, 8 h/30 min sessions, 🔐 fresh-2FA actions, break-glass for tenant
  content (customer-visible), four-eyes approvals, append-only audit log.
- **Honest conversion:** real server-issued expiries, reference prices that are actually charged,
  testimonials only with stored consent, explicit auto-renew consent, two-click cancel.

## Deploy

DigitalOcean App Platform: [`infra/do/app.yaml`](infra/do/app.yaml) (web, admin, worker + pre-deploy
migrate job) built from the multi-target [`Dockerfile`](Dockerfile). Managed Postgres 16 with transaction
pools for `app_rw`/`admin_rw` (`DB_PGBOUNCER=1`) and a direct connection for the owner and `system_rw`.
Spaces for storage. Secrets are App Platform encrypted env vars; production refuses to start with dev
secrets, mock providers or local storage.
