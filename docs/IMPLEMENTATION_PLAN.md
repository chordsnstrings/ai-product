# Skincare Creative OS: Implementation Plan

This plan implements the product standard in
[`docs/standard/`](standard/) (V1.1). The standard is the source of truth. If
this plan conflicts with it, the standard wins until it is revised.

## 1. Stack decisions

| Area | Decision | Why |
| --- | --- | --- |
| Language | TypeScript everywhere | One language across web, API and workers, with shared types for schemas and events |
| Web + API | Next.js (App Router). API route handlers are thin and call domain services in `packages/core` | Standard §34: no business logic in UI |
| Database | Postgres (DigitalOcean Managed) with Drizzle ORM and SQL migrations | Typed schema, plain SQL migrations, append-only tables are easy to model |
| Job queue | **pg-boss** (Postgres-backed) | See the explanation below |
| Object storage | DigitalOcean Spaces (S3 API) + CDN, short-lived signed URLs | Standard §34, §39 |
| Payments | Stripe: Checkout for the $19 Taste / $29 standalone, Billing for $49/$99/$199 plans | Decided |
| Auth | In-house: email + password (Argon2id), email verification, server-side sessions in Postgres, rate-limited login, password reset | Decided. Built in `packages/auth` |
| Hosting | DigitalOcean App Platform: `web` service + `worker` service (with FFmpeg), staging + production | Decided |
| AI | Anthropic API (Opus 5.5) for Creative Director and vision/extraction; BytePlus ModelArk for Seedream (images) and Seedance 2.5 (video). All behind `ModelGateway` | Standard §22, §33 |
| Media | FFmpeg in the worker image | Standard §23–24 |
| Validation | Zod at every API and model-output boundary | Model output is untrusted until validated |
| Tests | Vitest (unit/contract), Playwright (end-to-end), recorded fixtures for Shopify/Meta/TikTok/providers | Standard §51 |
| CI | GitHub Actions: lint, typecheck, unit, migration check | |

### What "job queue" means, and why pg-boss

Some work takes seconds to minutes: analysing a product page, generating a
storyboard, rendering video, running QA, syncing Meta data. A web request can't
wait that long, and the user may close the tab. So the web app writes a small
"job" record ("render scene 3 of project X") and returns immediately. Separate
**worker** processes pick jobs up, do the work, retry safely if something
crashes, and record the result. The user's browser just polls or receives
progress updates.

pg-boss stores those jobs **inside the same Postgres database**. That means:
- There's no extra service to run or pay for on DigitalOcean.
- A job can be created in the **same transaction** as the state change that
  needs it. A project never ends up in `RENDER_RESERVED` without a render job,
  or the reverse. This is what the standard's idempotency and "browser is never
  the job authority" rules (§39) need.
- It supports retries, timeouts, dead-letter queues and scheduled jobs (for
  example nightly Meta sync or reservation-expiry sweeps).

We can move heavy queues to something else later without changing domain code,
because workers only depend on a small `enqueue`/`handle` interface.

## 2. Repository layout

```
ai-product/
├── apps/
│   ├── web/                 Next.js: screens + thin API route handlers + webhooks
│   └── worker/              pg-boss workers: ai, render, qa, compose, sync, sweeps
├── packages/
│   ├── shared/              enums, event catalogue, Zod schemas, ID + money types
│   ├── db/                  Drizzle schema, migrations, tenant-scoped query helpers
│   ├── core/                domain services, one folder per standard §33 module:
│   │                        product-truth, claims, customer-signal, creative-genome,
│   │                        experiments, recommendations, statistics, context-builder,
│   │                        creative-director, production-planner, cost-governor,
│   │                        usage-ledger, qa, offers, events
│   ├── auth/                passwords, sessions, verification, rate limits
│   ├── billing/             Stripe checkout, subscriptions, webhook handling
│   ├── providers/           ModelGateway + adapters (anthropic, byteplus, tts) + mocks
│   ├── media/               FFmpeg composition, captions, aspect ratios, probes
│   └── integrations/        shopify, meta, tiktok connectors (read-only)
├── infra/
│   └── do/                  App Platform specs (staging, production), Dockerfiles
├── tests/
│   ├── e2e/                 Playwright
│   └── golden/              golden datasets (packaging, claims, performance) - §51
└── docs/
    ├── standard/            product standard (.docx + searchable .md)
    └── IMPLEMENTATION_PLAN.md
```

Rules baked into the layout:
- `apps/*` never talk to Postgres, Stripe or model providers directly. They call `packages/core`.
- Only `packages/providers` can reach a billable model API, and every call needs a
  `CostAuthorization` token issued by `core/cost-governor` (standard §37, rule 3).
- Every DB query goes through tenant-scoped helpers that require a `workspaceId` (§40).

## 3. What we build first, and why

The first target is **Launch Gate 1**: a new merchant imports one skincare SKU,
confirms facts and claims, gets 3 concepts, approves a storyboard, pays $19,
gets a rendered ad that passed QA, and exports it, with no human operator
involved.

This goes first because it is the revenue funnel (free preview → $19 Taste).
It also forces the hardest trust foundations to exist from day one: product
truth with provenance, the Claims Vault gate, the Cost Governor/ledger,
idempotent jobs and QA. Retrofitting those later is expensive. Subscriptions,
recommendations and performance learning are built on top of it.

## 4. Phases

Each phase ends with something demoable on staging.

### Phase 0: Foundations
- Monorepo (pnpm + Turborepo), lint/format/typecheck, GitHub Actions CI.
- Postgres schema v0: `workspaces`, `users`, `memberships`, `sessions`,
  `events` (append-only, standard §36 envelope), `idempotency_keys`, `jobs` (pg-boss).
- In-house auth: sign-up, email verification, login, logout, password reset,
  rate limiting, session cookies.
- Tenant-scoped data access helper and a test proving cross-tenant reads fail.
- Spaces upload with signed URLs; MIME/magic-byte checks and size caps (§48 abuse rows).
- Worker skeleton with pg-boss, leases, dead-letter queue, heartbeat/progress.
- Structured logging with workspace/SKU/job IDs on every line.
- DigitalOcean staging deploy (web + worker + managed Postgres + Spaces).

**Done when:** a user can sign up on staging, upload an image, and a worker job
processes it end to end with events recorded.

### Phase 1: Product Brain ingest (free, pre-payment)
- Import from product URL: fetch → parse JSON-LD / Shopify public product JSON → fall back to images/manual input (§42).
- Photo upload (mobile-first) and a "which product is this?" choice for multi-product photos.
- `ProductFact` with OBSERVED / INFERRED / DECIDED and provenance (§15–16). Merchant corrections become DECIDED records, never edits of raw observations.
- Visual Fingerprint v0: reference views, label OCR, dominant colors, closure type.
- Claims Vault v0: extracted claims start as `MERCHANT_REVIEW_REQUIRED` or `INFERRED_ONLY`, never `VERIFIED` automatically. Evidence attachments.
- Imported page/review text is always passed to models as delimited untrusted data (§48 prompt injection).
- Screens: Landing/upload → Product confirmation (observed vs needs confirmation).

### Phase 2: Concepts and storyboard (free preview)
- `ContextBuilder` → `CreativeDirector` (Opus) returning a Zod-validated `CreativeDirectorProposal` ×3 using the Appendix A taxonomy.
- Deterministic claim gate on every proposal: blocked or unapproved claims are stripped or flagged before the user sees them.
- Storyboard + scene model (§24): independently versioned, lockable scenes.
- Cost Governor v0 + Usage Ledger (CREDIT_* events, derived balances, reservations with expiry) used for Seedream storyboard frames. Free-preview budget ≤ $0.20 per SKU enforced.
- Free-preview abuse limits: account required before storyboard, per-account/device rate limits.
- Screens: Concept selection (3 concepts, "Why this?") → Storyboard.

### Phase 3: $19 Taste, production, QA, delivery → Launch Gate 1
- Offer Engine: server-side 60-minute Taste offer bound to account + storyboard; expired offers never reissued (§5, §7).
- Stripe Checkout; entitlement granted only from the verified, deduplicated webhook.
- Production Planner: per-scene mode (strict composite / generative / hybrid).
- Seedance 2.5 render via ModelGateway with authorization token; outputs copied to Spaces immediately.
- QA Gateway v0: product fidelity (OCR label match + vision comparison against fingerprint, hard fails), claims mapping of every statement, platform checks (duration, 9:16, safe zone, codec), asset integrity. One free retry, then fall back to strict composite (§25).
- Composer: FFmpeg scene assembly, captions, voice-over, TikTok/Reels/Facebook exports.
- Semantic progress UI, resumable after browser close; watch → export → next-hypothesis upsell.
- Tests: duplicate click, duplicate webhook, worker crash mid-render, provider timeout, all with no double charge.

**Done when:** Launch Gate 1 passes on staging with real providers, plus gates 3 (claims) and 4 (billing) under automated tests.

### Phase 4: Subscriptions and the weekly loop
- Stripe Billing for Launch/Growth/Scale; monthly Creative Test entitlements through the ledger; downgrade/cancel rules (§46).
- Creative Test cost ceiling ($8.50 variable COGS, standard §5 V1.1) enforced in Cost Governor.
- Experiment Engine (CONTROLLED/EXPLORATORY, variants, held-constant checks).
- Recommendations: hard gates → Opportunity Score → Exploit/Expand/Explore portfolio; cold-start mode when there's no history.
- Creator Packs from the same experiment.
- Screens: **This Week**, **Creative Map** v0, **Claims Vault**, **Product Brain**.

### Phase 5: Performance learning
- Shopify OAuth (read_products) with webhooks and reconciliation.
- Meta and TikTok read-only connectors → `PerformanceObservation` with `measurement_context`, currency/timezone handling, freshness state.
- Historical creative import → Creative Genome extraction.
- StatisticsService: Bayesian shrinkage, evidence floors, GATHERING_SIGNAL → DIRECTIONAL → ACTIONABLE; confounder windows.
- Learning objects with scope; **Results** screen; Friday summary; Day-30 SKU Creative Review.

### Phase 6: Paid-launch hardening
- All 10 launch gates (§50), golden datasets and regression suites (§51), chaos tests.
- Security review, backup/restore drill, admin access audit logging, data deletion flow.
- Prompt/model version registry and regression gating (§41).

## 5. Things I still need from you

These don't block Phase 0. Each has a default so work can continue.

| Item | Needed by | My default |
| --- | --- | --- |
| Transactional email provider (verification + password reset emails) | Phase 0 | Postmark |
| Voice-over / text-to-speech provider (standard budgets $0.05/output but names none) | Phase 3 | Pick after a short quality test; mocked until then |
| Accounts + API keys: DigitalOcean, Stripe, Anthropic, BytePlus ModelArk | Phase 0 (DO), Phase 2–3 (others) | Mocks until provided |
| Domain name | Phase 0 staging | DigitalOcean default app URL |
| Meta / TikTok developer app approval (takes time, start early) | Phase 5 | Recorded fixtures until approved |
