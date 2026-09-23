# 02 · Multi-tenancy

The platform serves many brands from one deployment. One brand must never see,
influence, pay for or slow down another brand's work. This document defines the
tenant model, the isolation layers and the edge cases. Every other plan document
assumes it.

Standard references: §15 (data doctrine), §39 (reliability), §40 (security),
§46–48 (edge cases), rule 54.9.

---

## 1. Tenant model

```
Platform (us)
└── Workspace            ← THE TENANT. Billing, isolation and quota boundary.
    ├── Memberships      ← users ↔ workspace, with a role
    ├── Brand (1..n)     ← Brand Brain
    │   └── SKU (1..n)   ← Product Brain, Visual Fingerprint, Claims Vault
    │       └── Hypothesis → Experiment → Variant → Performance → Learning
    ├── Connections      ← Shopify store, Meta ad accounts, TikTok advertisers
    ├── Subscription     ← one Stripe customer + at most one active subscription
    └── Usage Ledger     ← entitlements and cost, per workspace
```

| Decision | Rule |
| --- | --- |
| Tenant unit | **Workspace**. Every tenant-owned row carries `workspace_id`. |
| Billing | One workspace = one Stripe Customer = at most one active subscription. Entitlements belong to the workspace, not the user. |
| Users | A user is a global identity (one email = one user). A user can belong to several workspaces. |
| Brands per workspace | Launch: 1, Growth: 1, Scale: 3 (**default, commercial decision to confirm**). Stops one $199 plan being shared as a hidden agency account, which the standard excludes from V1. |
| URL shape | `app.<domain>/w/<workspace-slug>/...`. The slug is display only; authorization always resolves to `workspace_id` server-side. |
| IDs | UUIDv7 everywhere. They are hard to guess, but **we never rely on that** (§48 "Cross-tenant object ID guessed"). |

### 1.1 Roles (kept deliberately small; the standard excludes complex enterprise roles)

| Capability | Owner | Admin | Member | Viewer |
| --- | :-: | :-: | :-: | :-: |
| View everything in workspace | ✓ | ✓ | ✓ | ✓ |
| Create SKUs, experiments, storyboards | ✓ | ✓ | ✓ | – |
| Approve storyboard → spend a Creative Test | ✓ | ✓ | ✓ | – |
| Approve / block claims (§17: needs explicit actor + scope) | ✓ | ✓ | – | – |
| Connect / disconnect integrations | ✓ | ✓ | – | – |
| Invite / remove members, change roles | ✓ | ✓ (not Owners) | – | – |
| Billing: plan, payment method, invoices, cancel | ✓ | – | – | – |
| Delete workspace, transfer ownership, export all data | ✓ | – | – | – |

Permissions are checked by `core/authz.can(ctx, action, resource)`. That
function is the only place role logic lives. UI hiding is cosmetic; the server
always re-checks.

### 1.2 Global (non-tenant) data

These tables have **no** `workspace_id` and are readable by app code. Only staff
roles can write to them:

`users`, `user_emails`, `staff_users`, `provider_rate_tables` (versioned),
`taxonomy_versions` (Appendix A), `prompt_templates` / `model_routes`,
`offer_definitions`, `landing_pages`, `feature_flag_definitions`,
`golden_datasets`, `platform_settings`, `email_templates`.

Anything derived from customer content (reviews, claims, genomes, performance,
assets) is **always** tenant-owned. No exceptions in V1 (§40: no cross-customer
learning without explicit authorization and an aggregation policy).

---

## 2. Tenant lifecycle

```
PROVISIONAL ──signup/claim──▶ ACTIVE_FREE ──first payment──▶ ACTIVE_PAID
     │                           │                               │
     └─ expires 7d ─▶ PURGED     │                    payment fails
                                 │                               ▼
                                 │                          PAST_DUE ── dunning ends ─▶ CANCELLED
                                 │                               │                           │
                                 └────────── user cancels ───────┴──────────────▶ CANCELLED ──┘
                                                                                    │ retention window (default 90d, §55)
                                                                                    ▼
                                                                             PURGE_SCHEDULED ─▶ PURGED
Any state ─▶ SUSPENDED (abuse/fraud, staff only, reversible)
Any state ─▶ LOCKED (chargeback/dispute open, read-only, staff only)
```

| State | What the tenant can do | Jobs | Billing |
| --- | --- | --- | --- |
| PROVISIONAL | Anonymous: upload 1 SKU, see analysis + 3 concepts. Nothing else. | Free-preview jobs only, strict COGS cap | none |
| ACTIVE_FREE | Everything free; can buy Taste/Standalone | Paid jobs need a paid entitlement | Stripe customer created lazily at first checkout |
| ACTIVE_PAID | Full plan | Normal | Subscription or one-off credit |
| PAST_DUE | Read + export; new paid renders blocked; in-flight jobs finish (§46: never throttle an in-flight paid job) | Existing only | Stripe Smart Retries; banner |
| CANCELLED | Read + export + reactivate. Integrations sync paused. | None | none |
| PURGE_SCHEDULED | Owner can still cancel the purge until T-0; email at T-14d and T-1d | None | none |
| PURGED | Nothing. Financial ledger rows kept with PII removed (§40 financial retention). | – | – |
| SUSPENDED | Login shows a notice; no jobs; data untouched | All paused | Paused |
| LOCKED | Read-only | Paused | Dispute handling |

Every transition emits `WORKSPACE_STATE_CHANGED` with actor, reason and previous state.

### 2.1 Provisional (anonymous) tenants: the free preview before signup

The standard (§8) lets a visitor start with a SKU before creating an account.
We give each anonymous visitor a real but **provisional** workspace so the same
isolation code covers them. No special "anonymous mode" code paths.

- Created on first upload. The browser gets an HttpOnly cookie holding `provisional_token` (random 256-bit; hashed in DB).
- Limits: 1 SKU, 1 analysis, 3 concepts, **no storyboard** (the standard requires an account first), COGS cap $0.20.
- **Claim on signup:** the provisional workspace becomes the user's workspace (state → ACTIVE_FREE). The work carries over, so the endowed-progress effect is preserved (see 04-conversion).
- Edge cases:
  - Visitor signs up with an email that **already has an account**: after login, offer "Add this product to *Workspace X*" or "Create a new workspace". SKU rows move with a single `workspace_id` rewrite inside one transaction; assets are copied to the new prefix, then the originals are deleted.
  - Visitor already logged in lands on a campaign page and uploads: skip provisional and create the SKU in their current workspace, but only if the role allows it (Viewer → ask which workspace).
  - Cookie lost (different device): the provisional workspace is orphaned and purged at 7 days. The upload page offers "Continue on another device" by emailing a magic resume link **after** they give an email. That email capture is itself a conversion lever.
  - Same device, several provisional uploads: reuse the same provisional workspace up to 3 SKUs, then require signup (abuse cap).
  - Bot farms: provisional creation is rate-limited per IP /24, device fingerprint and ASN (datacenter ASNs get a Turnstile challenge before analysis).

---

## 3. Isolation layers (defense in depth)

Any single layer failing must not leak data. We implement **all** of them.

### Layer 1: Request context
- Middleware resolves `session → user`, then `slug → workspace_id`, then `membership` (with role), on **every** request. No trusting a workspace ID from the body or query.
- Result: an immutable `TenantContext { workspaceId, userId, role, requestId }` passed explicitly to every `core` function. Core functions **require** it as their first argument. There is no ambient global.
- Not a member → **404**, not 403, so workspace existence can't be discovered.
- Membership lookup is cached for at most 30s, keyed by `(userId, workspaceId, membershipVersion)`. Removing a member bumps `membershipVersion`, so revocation takes effect on the next request.

### Layer 2: Postgres Row-Level Security
- Every tenant table has `workspace_id uuid not null` and RLS **enabled and forced**:
  ```sql
  alter table skus enable row level security;
  alter table skus force row level security;
  create policy tenant_isolation on skus
    using (workspace_id = current_setting('app.workspace_id')::uuid)
    with check (workspace_id = current_setting('app.workspace_id')::uuid);
  ```
- The app connects as role `app_rw`, **without** `BYPASSRLS`. Each unit of work runs in a transaction that begins `SET LOCAL app.workspace_id = $1`. If it's unset, `current_setting` throws, so a query with no tenant fails closed.
- The table owner runs migrations. `admin_rw` (staff console) and `system_rw` (worker: dispatcher, sweeps, purge) do **not** have `BYPASSRLS`; every tenant table carries explicit `staff_access` / `system_access` policies instead, so access stays visible in the schema and revocable per table. `admin_rw` is used **only** by the admin app, where every query of tenant data is audited and tenant *content* additionally requires break-glass (see 05-admin-panel). As implemented.
- **CI guard:** a test lists every table with a `workspace_id` column and fails if RLS isn't enabled+forced with a policy. A second list declares the global tables; a table in neither list fails CI.
- Connection pooling: DigitalOcean's PgBouncer in **transaction** mode is compatible because we only use `SET LOCAL` inside transactions, never session-level `SET`.

### Layer 3: Referential integrity across tenants
- Child tables reference parents by **composite** foreign keys `(workspace_id, parent_id) → parent(workspace_id, id)`, with `unique (workspace_id, id)` on parents. The database physically can't link an experiment in workspace A to a SKU in workspace B, even through a bug.

### Layer 4: Object storage (DigitalOcean Spaces)
- Key layout: `t/{workspace_id}/{sku_id}/{asset_kind}/{asset_id}/{version}.{ext}`. Staff-owned global assets live under `g/`.
- There's no public bucket listing. Downloads use signed URLs (TTL 10 min for UI, 24h for export links) generated only after an authz check on the asset row. The key is never built from client input.
- Uploads use a presigned PUT to a **quarantine** prefix `q/{workspace_id}/{upload_id}`. A worker validates magic bytes, size, dimensions and duration, re-encodes images/video (strips EXIF/GPS) and moves the result to the tenant prefix. Nothing from quarantine is ever served.
- CDN: tenant assets are **not** cached at the CDN edge under shareable URLs. Only `g/` (marketing, landing examples) goes through the CDN.

### Layer 5: Jobs (pg-boss)
- Every job payload is `{ workspaceId, actor, idempotencyKey, ...args }`. A worker wrapper opens the tenant transaction (`SET LOCAL`) before running the handler. Handlers can't reach the DB any other way.
- A job created in workspace A can never touch B's rows: RLS enforces it even if the payload is tampered with.
- **Fairness / noisy neighbour:**
  - Per-workspace concurrency caps (renders: Launch 2, Growth 3, Scale 5 in flight; analysis: 3) held in a `workspace_semaphores` table with `SELECT … FOR UPDATE SKIP LOCKED`. Excess jobs wait in `queued` with a truthful "queued" state (§48).
  - Global provider concurrency is capped separately per provider to respect rate limits.
  - Free/provisional jobs run on a separate lower-priority queue so paying tenants are never delayed by preview traffic.

### Layer 6: AI context
- `ContextBuilder` loads data only through tenant-scoped repositories, so a Context Packet can't contain another tenant's rows.
- Prompt structure: `[static system prompt: global, cacheable] + [tenant packet: delimited, untrusted]`. Tenant data is never put in a shared cached prefix.
- Imported text (product pages, reviews, comments) is wrapped as data (`<untrusted_source id=…>`) and can never change tools, claim status or spend (§48).
- Provider-side: we send no `workspace_id` or PII to model providers beyond content necessary for the task. Provider job IDs are mapped back to tenants only in our DB.

### Layer 7: Caches, search and logs
- Every cache key starts `w:{workspaceId}:`. A lint rule rejects cache calls without a TenantContext.
- Any search index (Postgres full-text in V1) lives in tenant tables under RLS. There's no separate search service in V1.
- Structured logs carry `workspace_id`, `request_id` and `job_id`. Emails, names, review text and prompts are **redacted** in logs. Prompts and outputs are stored in the DB (tenant-scoped) for §41 reproducibility, never in log lines.

### Layer 8: External identities
| External ID | Uniqueness | Why / edge cases |
| --- | --- | --- |
| Shopify shop domain | **One active workspace per shop** | Webhooks route by shop domain, so it must be unambiguous. A second connect attempt shows "This store is connected to another workspace (owner a•••@brand.com). Request transfer?". Transfer needs the current owner's approval, or staff approval after 14 days with proof (Shopify OAuth by the store owner). |
| Meta ad account ID | May be connected in several workspaces | Legitimate (founder + contractor). Each workspace syncs and stores its **own** copy of observations; there's no shared ingestion or cross-tenant dedupe. |
| TikTok advertiser ID / Shop ID | Same as Meta | Same. |
| Stripe customer ID | 1:1 with workspace | Stored on the workspace and in Stripe metadata `workspace_id`. A webhook with an unknown customer goes to the **Unmatched Stripe events** admin queue and is never guessed. |
| Email address | 1 user | Case-insensitive, normalized. Plus-addressing is allowed but counted per base mailbox for free-preview abuse limits. |

---

## 4. Per-tenant quotas and guards

| Guard | Default | Behaviour when hit |
| --- | --- | --- |
| Creative Tests / month | Plan: 3 / 7 / 16 | Upgrade or buy standalone ($29). Shows before any spend. |
| Render concurrency | 2 / 3 / 5 | Queued with truthful ETA |
| Daily provider-spend anomaly cap | 3× plan's expected daily COGS | Pause new dispatches for that workspace, alert staff, show "We're reviewing unusual activity" (no auto-ban) |
| Free-preview COGS per provisional workspace | $0.20 | Stop generating; ask for signup |
| Storage | 5 / 20 / 50 GB | Warn at 80%; block new uploads at 100% (no deletion) |
| API rate limit (per workspace, per user) | 120 req/min per user; 600/min per workspace | 429 with `Retry-After`; UI retries with backoff |
| Uploads per hour | 100 per workspace | 429 + message |
| Members | Launch 2, Growth 5, Scale 10 (**default to confirm**) | Invite blocked with upgrade prompt |

Quotas are stored as entitlement rows derived from the plan, never hard-coded
in handlers. Plan changes regenerate them (effective at period boundary for
downgrades, immediately for upgrades; §46).

---

## 5. Membership and identity edge cases

| # | Case | Behaviour |
| --- | --- | --- |
| M1 | Last Owner tries to leave or demote themself | Blocked: "Transfer ownership first". |
| M2 | Owner deletes their user account while owning a paid workspace | Blocked until ownership is transferred or the workspace is cancelled. |
| M3 | Invite sent to an email that already has an account | The invite links to the existing user on accept; no duplicate user. |
| M4 | Invite opened while logged in as a **different** email | Mismatch screen: "This invite is for b@x.com. Switch account?". Never auto-accept to the wrong user. |
| M5 | Invite expired (7 days) or revoked | Clear message plus a "request new invite" button that notifies admins. |
| M6 | Member removed while they have an open tab | The next request returns 404 for that workspace; realtime channel closes; any in-flight job **they** started continues (it belongs to the workspace). |
| M7 | Member removed mid-storyboard edit | Draft kept, attributed to them; other members can continue it. |
| M8 | Email change | Verify the new address first; sessions on other devices stay; pending invites to the old address remain valid only if accepted by the same user. |
| M9 | Two users approve the same storyboard at the same moment | Idempotency key `(workspace, storyboard_version, 'approve')`: the first approval wins, the second sees "Already approved by Anna 2s ago". There's exactly one reservation. |
| M10 | Role downgraded while a claim-approval dialog is open | The server re-checks on submit → 403 with explanation. |
| M11 | User belongs to 2+ workspaces | Workspace switcher. The last used workspace is remembered per device. Notifications and emails always name the workspace. |
| M12 | Workspace slug renamed | Old slug kept in `workspace_slug_history`; 301 redirect for 90 days; a slug can't be reused by another tenant during that time (prevents link hijack). |
| M13 | Workspace owner's email bounces (Resend hard bounce) | Banner to all Admins; billing emails fall back to the Stripe billing email. |
| M14 | Account takeover suspicion (new device + password reset + integration change) | Step-up email confirmation for: disconnecting integrations, exporting all data, changing Owner, changing payout/billing email. |

---

## 6. Billing ↔ tenant edge cases (Stripe)

| # | Case | Behaviour |
| --- | --- | --- |
| B1 | Stripe webhook arrives before our checkout-session row commits | Store the raw event (`stripe_events` unique on `event.id`), return 200, process asynchronously; the processor retries until the session row exists (max 10 min, then admin queue). |
| B2 | Duplicate webhook | Unique `event.id` → no-op. |
| B3 | Webhook for an unknown customer | Unmatched queue in admin; never auto-assigned. |
| B4 | Taste purchased twice (two tabs) | Checkout Session created with idempotency key `(workspace, offer_id)`. The second tab reuses the same session. If both somehow get paid, auto-refund the second and log it. |
| B5 | Taste paid after the 60-min offer expired (checkout was opened before expiry) | Honour it. The price is locked when the Checkout Session is created. Session `expires_at = max(offer_expires_at, now + 30 min)`, because Stripe's minimum is 30 min. So someone who opens checkout at minute 55 still gets a working checkout; the offer itself is not extended or reissued. |
| B6 | Upgrade mid-cycle | Immediate proration; new Creative Test entitlement = new plan's remaining pro-rata tests (rounded up); reserved jobs untouched. |
| B7 | Downgrade mid-cycle | Effective at period end; queued/reserved jobs honoured (§46). |
| B8 | Chargeback | Workspace → LOCKED; in-flight jobs finish; exports still allowed; staff reviews. |
| B9 | Refund of a Taste after delivery | Ledger `CREDIT_REFUNDED` references the original; the asset stays accessible (we don't claw back delivered files) unless fraud-flagged. |
| B10 | Payment method belongs to a different country / card testing | Stripe Radar rules; 3 failed attempts in 10 min per workspace → Turnstile + cooldown. |
| B11 | Subscription created in the Stripe dashboard by staff | Must carry `workspace_id` metadata or it lands in the unmatched queue. |
| B12 | Tax | Stripe Tax enabled for US sales tax on SaaS where applicable (**confirm with accountant**). |

---

## 7. Deletion, export and portability

- **Export (Owner):** async job builds a ZIP containing all SKUs, facts with provenance, claims with evidence, experiments, learnings (JSON + CSV) and all owned assets. Emailed as a 24h signed link via Resend. Step-up confirmation required (M14).
- **Delete workspace (Owner):** type-to-confirm → PURGE_SCHEDULED after a 7-day grace (cancellable), then a purge job:
  1. Revoke integration tokens at Shopify/Meta/TikTok.
  2. Delete Spaces prefix `t/{workspace_id}/` (versioned bucket: delete all versions).
  3. Delete tenant rows (cascade via composite FKs).
  4. Keep `usage_ledger`, `stripe_events` and invoices with PII removed (financial/audit retention).
  5. Request deletion of provider-side artifacts where the provider API supports it; record what couldn't be deleted.
  6. Emit `WORKSPACE_PURGED` and write a **purge certificate** row (counts per table, object counts, timestamp).
- **Delete user:** removes the user from all workspaces (subject to M1/M2), anonymizes `actor` references in events (`user:deleted:<hash>`), and deletes sessions.
- Backups: purged data disappears from backups by expiry (backup retention 14 days, disclosed in the privacy policy).

---

## 8. Tenant-isolation test plan (runs in CI)

1. **RLS coverage test**: every tenant table is RLS-forced with a policy (described above).
2. **Cross-tenant API fuzz**: for every API route (generated from the route manifest), create tenants A and B, create resources in B, call the route as A with B's IDs in path, query and body → expect 404/422 and zero rows changed.
3. **Worker tamper test**: enqueue a job with workspace A context but B's object IDs → handler fails; no writes.
4. **Storage test**: A can't get a signed URL for B's asset key, even with a crafted asset ID.
5. **Cache test**: identical logical keys in A and B never collide.
6. **Context Builder test**: packets built for A contain only A's IDs (asserted by scanning all IDs in the packet).
7. **Stripe/Shopify webhook routing test**: webhooks route only to the mapped workspace; unknown → unmatched queue.
8. **Admin audit test**: every admin read of tenant data writes an audit row.
