# 06 · Build Phases

Each phase has **deliverables**, **admin work**, **tests** and **exit criteria**.
Nothing moves to the next phase until the exit criteria pass on staging.
Tenant isolation (02) and the design system (01) are built in from Phase 0,
not added later.

---

## Phase 0: Foundations
**Deliverables**
1. Monorepo: pnpm + Turborepo; `apps/{web,admin,worker}`, `packages/{shared,db,core,auth,billing,providers,media,integrations,ui,email}`; ESLint (incl. custom rules: no raw DB client in apps, cache calls need a TenantContext), Prettier, strict TS.
2. CI (GitHub Actions): lint, typecheck, unit, migration dry-run, **RLS coverage test**, bundle-size check, Lighthouse CI on marketing pages.
3. DB v0 (Drizzle + SQL migrations), all with RLS per 02 §3:
   - global: `users`, `user_identities` (google/apple/email), `sessions`, `magic_links`, `passkeys`, `staff_users`, `staff_sessions`, `admin_audit_log`, `feature_flags`, `platform_settings`
   - tenant: `workspaces`, `workspace_slug_history`, `memberships`, `invites`, `events`, `idempotency_keys`, `workspace_semaphores`, `assets`, `uploads`
   - DB roles: `app_rw` (no BYPASSRLS), `migrator`, `admin_ro`, `admin_rw`.
4. `TenantContext` + `withTenantTx()` (SET LOCAL) + tenant-scoped repository base; cross-tenant 404 middleware.
5. Auth (in-house): email magic link (Resend), Google OAuth, Apple Sign In, sessions, rate limits, confirm-page magic links (scanner-safe), session list and revoke. Passkeys come in Phase 3.
6. Email: `packages/email` with React Email arkiv templates; Resend domain `mail.<domain>` (SPF/DKIM/DMARC `p=none` → `quarantine` after 30 days); Resend `Idempotency-Key` on every send; webhook receiver (delivered/bounced/complained → suppression).
7. Storage: Spaces buckets per environment, versioning on, quarantine → validate → tenant prefix pipeline; signed URLs.
8. Worker: pg-boss setup, the tenant-tx job wrapper, leases, dead-letter queue, heartbeat, per-workspace semaphores.
9. Design system v0: tokens, fonts (`next/font`), Button/Input/IndexRow/SpecimenCard/MetadataTable/Chip/Sheet, motion presets, reduced-motion handling, the `/internal/catalogue` page.
10. Observability: structured logs with redaction, OpenTelemetry traces, error tracking.
11. DigitalOcean: App Platform app spec for `web`, `admin`, `worker` (Dockerfile with FFmpeg); Managed Postgres (+ PgBouncer transaction mode); Spaces + CDN; staging and production; secrets in App Platform encrypted env vars.

**Admin:** staff login (password + passkey/TOTP), roles, audit log, tenant list/overview/members, users, feature flags + kill switches, system health basics.

**Tests:** tenant fuzz harness (02 §8 items 1, 2, 4, 5, 8); auth e2e (magic link across devices, OAuth, rate limit); upload magic-byte and decompression-bomb tests.

**Exit:** on staging a user signs up (magic link + Google), is in a workspace, uploads an image that gets validated and moved, and a worker job runs under RLS; the cross-tenant suite passes; staff can see the tenant in admin, and that access is audited.

---

## Phase 1: Product Brain ingest (the free, pre-payment part)
**Deliverables**
1. Provisional workspaces (02 §2.1): cookie token, limits, 7-day purge job, claim-on-signup, merge into an existing account.
2. Landing pages P1 (static render, CDN) with 1 default page + 2 archetypes; `utm_content` routing; server-side funnel events.
3. Upload P2: URL + photos, HEIC conversion, resumable uploads, non-skincare and drug/SPF detection.
4. URL import: fetch (with timeout, size cap, SSRF protection: public IPs only, no redirects to private ranges) → JSON-LD / Shopify `products/<handle>.json` / OpenGraph → fallback to photos.
5. `ProductFact` store with OBSERVED/INFERRED/DECIDED, source precedence, DISPUTED handling; `PRODUCT_*` events.
6. Background removal for the product cut-out (M3). A provider decision is needed: BytePlus/Seedream edit or an open model in the worker; evaluated on the golden set.
7. Visual Fingerprint v0: reference views, label OCR (Opus vision), dominant colours, closure type.
8. Claims extraction → Claims Vault v0 (statuses per §17; nothing auto-VERIFIED); banned-phrase list v1.
9. The P3 cataloguing stream (SSE from real events) + the P4 confirmation screen.
10. Model Gateway v0 with Anthropic adapter; untrusted-data delimiting; Zod-validated outputs; prompt templates versioned in git.
11. Cost Governor v0 + Usage Ledger (CREDIT_* + PROVIDER_COST_RECORDED) even for free work; free-preview cap $0.20 enforced.

**Admin:** jobs & queues, providers (read), abuse signals for provisional farms, funnel analytics v0 (S1–S4).

**Tests:** golden set v0 (30 real/licensed skincare products across packaging types); URL parser fixtures (Shopify, WooCommerce, custom, blocked); SSRF tests; prompt-injection fixtures in product pages.

**Exit:** a stranger on a phone goes from landing → upload → catalogued product with facts and claims in ≤ 45s p75, and costs ≤ $0.20.

---

## Phase 2: Concepts, account gate, storyboard
**Deliverables**
1. ContextBuilder + CreativeDirector: 3 concepts per Appendix A taxonomy with hard gates first (claims, feasibility, duplicates).
2. P5 concepts UI with "Why this?" + "Our pick".
3. P6 save gate (bottom sheet; Apple/Google/magic link) + provisional claim.
4. Storyboard + scene model (versioned, lockable scenes); Seedream adapter via Cost Governor; exact-product composite for any frame failing fidelity.
5. Offer Engine v1: TASTE offer issued at `STORYBOARD_READY`, 60-min expiry, never reissued; STANDALONE $29 always available.
6. P7 storyboard + offer card + free text edits + limited frame regenerations.
7. Resend recovery sequence (L20) with frequency caps.

**Admin:** offers (definitions + assignments), prompt registry (read), landing pages editor v1 (blocks, variants, publish lint).

**Tests:** claims regression (express + implied, including "cured my acne" reviews); concept schema validation; offer timer tests (refresh, second device, clock skew, never reissued).

**Exit:** concepts are distinct (automated diversity check + human review of 50 SKUs); storyboard ≤ 90s p75; the offer behaves exactly as §5 states.

---

## Phase 3: $19 Taste → production → delivery (**Launch Gate 1**)
**Deliverables**
1. Stripe: products and prices (Taste $19, Standalone $29), Embedded Checkout, Apple Pay domain verification per environment, Link, Stripe Tax; webhook ingestion (raw event store, dedupe, async processing); the unmatched queue.
2. Production Planner (strict composite / generative / hybrid / real-asset remix).
3. Seedance 2.5 adapter; immediate copy of outputs to Spaces; provider callback + polling with idempotent state machine.
4. **Voice:** a TTS adapter interface with **MiniMax speech-2.8** (primary candidate, ~$100/M chars HD ≈ $0.025 per 15s VO) and **BytePlus Seed Speech** (fallback, $30/M chars). Final primary choice by a blind listening test on 20 scripts during this phase. **No voice cloning in V1** (it needs a consent-record flow; revisit in V1.5).
5. QA Gateway v1: fidelity (label OCR diff + vision compare + hard-fail rules), visual checks, claims mapping on transcript and overlays, platform checks (duration, aspect, safe zones, codec), experiment integrity, asset integrity; one free retry → technique switch.
6. Composer (FFmpeg): assembly, captions (burned-in + SRT), VO mix, loudness normalization (−14 LUFS), 9:16 / 4:5 / 1:1 exports.
7. P8 checkout, P9 progress ledger (real events), P10 delivery + export.
8. Passkeys (offered after first purchase).

**Admin:** billing mirror, refunds, ledger explorer, COGS, rate tables (four-eyes publish), QA review queue, email dashboard.

**Tests:** billing chaos (double click, duplicate webhook, webhook-before-session, worker crash mid-render, provider timeout, partial provider billing) with zero double charges; fidelity regression with known mutations; e2e happy path with provider mocks plus a nightly real-provider canary.

**Exit:** Launch Gates 1, 3 and 4 (standard §50) pass on staging with real providers; cost per usable Taste ≤ $6.50.

---

## Phase 4: Subscriptions and the weekly loop
**Deliverables**
1. Plans (Stripe Billing) with ROSCA/ARL consent capture (unchecked checkbox, consent record ≥ 3 years), proration rules, the price-change notice flow, the A9 cancel flow (≤ 2 screens), dunning.
2. Entitlements from the ledger; the Creative Test cost ceiling ($8.50) in Cost Governor; standalone purchase for subscribers.
3. Experiment Engine (CONTROLLED/EXPLORATORY, variants, held-constant checks).
4. RecommendationService: hard gates → Opportunity Score (§20 weights) → portfolio (Exploit/Expand/Explore by maturity) → dedupe; cold-start mode.
5. A1 This Week, A2 Creative Map v0, A3 Studio, A4 Product Brain, A5 Claims Vault (evidence upload, approve with scope).
6. Creator Packs (A7).
7. Members & invites (roles per 02 §1.1), workspace settings (A8), access log.
8. Weekly emails: Monday brief, Friday summary.

**Admin:** claims & compliance queues, retention board + playbooks, taxonomy management, evals and rollouts.

**Tests:** role matrix tests for every action; entitlement math property tests; subscription lifecycle e2e (upgrade, downgrade, cancel, un-cancel, past due).

**Exit:** a Growth customer can run 3+ Creative Tests in 30 days entirely self-serve; cancel works in ≤ 2 screens.

---

## Phase 5: Performance learning
**Deliverables**
1. Shopify app (read_products, webhooks, nightly reconciliation; one shop per workspace with a transfer flow).
2. Meta read-only (ads_read / insights), TikTok read-only (reporting + creative insights). **Apply for platform app review at the start of Phase 3**; approvals take weeks.
3. PerformanceObservation with measurement_context, currency, timezone, backfills; freshness state (§31).
4. Historical creative import → Creative Genome extraction.
5. StatisticsService: Bayesian shrinkage, evidence floors scaled to account volume, state transitions, confounder windows.
6. Learning objects with scope and do-not-generalize; A6 Results; Day-30 SKU Creative Review.
7. Customer Language Engine (reviews via page/CSV import + approved comments) → CustomerTheme.

**Admin:** integrations health, connector app status, data freshness.

**Tests:** connector contract tests with recorded fixtures; statistics unit tests (tiny sample high ROAS, late conversions, mixed attribution windows, GMV Max context separation).

**Exit:** Launch Gates 6 and 7 pass.

---

## Phase 6: Paid-launch hardening
1. All 10 standard Launch Gates, plus: **consumer-protection lawyer review of checkout, plans and cancel flows** (04 §3); accessibility audit (WCAG 2.2 AA); a security review (auth, tenant isolation, SSRF, upload parsing, secrets).
2. Four-eyes on every listed admin action; data requests queue; quarterly access review.
3. Backup **restore drill** (timed, documented); object-storage version restore test.
4. Load test: 200 concurrent previews + 50 concurrent renders; fairness verified (paid never waits on free).
5. Chaos suite in CI nightly.

**Exit:** go/no-go review against Launch Gates; first paid traffic at a small budget with live funnel monitoring.

---

## Cross-phase decision log

| Decision | Choice | Status |
| --- | --- | --- |
| Payments | Stripe (Embedded Checkout, Billing, Tax, Radar) | Decided |
| Auth | In-house: magic link, Google, Apple, passkeys; password optional | Decided |
| Email | Resend + React Email | Decided |
| Voice | MiniMax (primary candidate) + BytePlus Seed Speech (fallback); final pick by listening test in Phase 3 | Decided (pending test) |
| Queue | pg-boss on Postgres | Decided |
| Hosting | DigitalOcean App Platform + Managed Postgres + Spaces | Decided |
| Product analytics | PostHog (privacy mode, marketing/funnel pages only) | **Default: confirm** |
| Observability | OpenTelemetry → Grafana Cloud | **Default: confirm** |
| Background removal | Evaluate provider vs open model in Phase 1 | Open |
| Brands/members per plan | 1/1/3 brands; 2/5/10 members | **Default: confirm** |
| Cancelled-workspace retention | 90 days | **Default: confirm (§55 legal review)** |
