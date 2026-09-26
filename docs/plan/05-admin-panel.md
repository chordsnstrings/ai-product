# 05 · Platform Admin Console

This is the internal console where **we** run the platform: every tenant, every
dollar, every job, every model, every page. It is a separate app
(`apps/admin`, served at `admin.<domain>`) with its own staff login. Customer
accounts can never reach it, and it can never be reached from the customer app.

Customer-facing workspace settings (members, billing, integrations) are a
different surface. They are specified in 03-product-surfaces §Workspace settings.

Design: same arkiv design system (01-design-system) in its **dense** variant
(13px base, compact tables, keyboard-first). Conversion levers do not apply
here; speed, correctness and auditability do.

---

## 0. Access model

### 0.1 Staff identity
- `staff_users` table, separate from `users`. A staff member who is also a customer has two separate identities.
- Login: email + password (Argon2id) **plus mandatory** passkey (WebAuthn) or TOTP. No SMS.
- Session: 8h absolute, 30 min idle. Re-authentication (passkey tap) required for actions marked 🔐 below.
- Optional IP allowlist per staff role (on by default for FINANCE and SUPER_ADMIN).
- Staff accounts are deprovisioned by SUPER_ADMIN; deprovisioning kills all sessions immediately.

### 0.2 Staff roles

| Role | For | Can |
| --- | --- | --- |
| SUPER_ADMIN | Founders (≤2 people) | Everything, including staff management. Every action still audited. |
| OPS | Running the platform | Tenants (read + state changes), jobs, queues, providers, QA, integrations health |
| SUPPORT | Customer help | Tenant read (masked PII), support actions, **break-glass** view access, resend emails, re-run failed jobs with no spend |
| FINANCE | Money | Billing, refunds, ledger adjustments, COGS, rate tables (propose), Stripe reconciliation |
| COMPLIANCE | Claims and content risk | Claims review queues, implied-claim flags, blocked content, rights disputes, data requests |
| GROWTH | Acquisition | Landing pages, offers and experiments, funnel analytics, email templates |
| ENGINEERING | Models and system | Prompt/model registry, evals, golden datasets, feature flags, taxonomy, system health |
| ANALYST | Read-only | Aggregated dashboards; no tenant-level content |

A person can hold several roles. Permissions are the union.

### 0.3 Tenant data access: break-glass
Staff can see tenant **metadata** (plan, counts, states, job statuses, costs)
by role. Tenant **content** (product images, claims text, reviews, creatives,
performance numbers) needs **break-glass**:
1. Choose a reason (support ticket #, incident #, compliance review) and write free text.
2. Access lasts 60 min, **read-only** by default. Write access ("act on behalf") needs SUPER_ADMIN or OPS plus a second reason, and every write carries `actor=staff:<id>, on_behalf_of=workspace:<id>`.
3. The customer sees it in **Workspace settings → Access log**: "Our support team viewed this workspace on 23 Sep, 14:02 for ticket #812". This is a trust feature (standard §40: administrative access logged and least-privilege).
4. There is no impersonation-as-login. Staff never hold a customer session and never see the customer's password or tokens.

### 0.4 Audit
Every admin page view of tenant data and every mutation writes to
`admin_audit_log`: staff_id, role, action, target, before/after (diffable
JSON), reason, IP, user agent and timestamp. The log is append-only (DB role
has INSERT only). Only SUPER_ADMIN can read it. Exportable as CSV.

### 0.5 Dual control (four-eyes)
These actions need a second staff member to approve before they take effect:
- Ledger adjustment > $50 or > 5 Creative Tests
- Refund > $200
- Provider rate table publish
- Prompt/model route promotion to 100%
- Workspace purge before its scheduled date
- Changing staff roles
- Unblocking a claim that COMPLIANCE blocked

Edge case: if only one person holds the needed role, SUPER_ADMIN can approve, and a lone SUPER_ADMIN cannot approve their own request.

---

## 1. Home: Platform Pulse

One screen that answers "is the business healthy right now?".

| Tile | Definition (Appendix C) | Alert threshold (default) |
| --- | --- | --- |
| Visitors → Upload → Concepts → Storyboard → Taste → Subscribed | Today / 7d / 30d funnel with stage conversion | Stage conversion −25% vs 7d baseline |
| Taste revenue, subscription MRR, net new MRR | From Stripe mirror | – |
| Active jobs by state; oldest queued job age | pg-boss | Oldest queued > 10 min |
| Job failure rate by provider (1h) | PROVIDER_JOB_FAILED / created | > 5% |
| QA first-pass rate, hard fidelity fails | QA_PASSED / total, fidelity hard-fails | First-pass < 70%, hard-fail > 3% (§10 targets) |
| Cost per usable export (7d) | Appendix C | > $8.50 per standard test (§5 ceiling) |
| Provider spend today vs forecast | PROVIDER_COST_RECORDED | > 130% forecast |
| Connector health | % connections fresh | < 90% fresh |
| Churn-risk tenants (new today) | §10 leading indicators | – |
| Open queues: claims review, QA review, unmatched Stripe, data requests, abuse | Counts + oldest age | SLA breach |

Every tile links to its detail module, pre-filtered. Global date and timezone
selector (default America/New_York; stored UTC).

---

## 2. Tenants

### 2.1 Tenant list
- Columns: workspace name, slug, state (2-multi-tenancy §2), plan, MRR, created, last active, SKUs, Creative Tests used/available, 30d COGS, 30d margin, connections (icons with freshness colour), churn-risk score, flags (suspended, locked, VIP, test).
- Filters: state, plan, risk band, integration status, created range, "no export after paid", "over COGS cap", "past due", test accounts hidden by default.
- Search: workspace name/slug/ID, member email (exact), Stripe customer ID, Shopify domain, Meta ad account ID.
- Saved views per staff member. Bulk actions: tag, export CSV (metadata only).

### 2.2 Tenant detail (tabs)

| Tab | Shows | Actions |
| --- | --- | --- |
| Overview | State timeline, plan, entitlements, quotas and usage, health score, notes, tags | Add note, add tag, mark VIP, mark test account |
| Members | Users, roles, last login, 2FA status, pending invites | Resend invite, revoke invite, force logout user, 🔐 transfer ownership (with written reason + customer email confirmation) |
| Brands & SKUs | Tree with counts: facts, claims by status, assets, experiments | Break-glass → open read-only SKU view |
| Experiments & jobs | All projects with state machine position; stuck items highlighted | Retry step with no new spend; cancel before dispatch (releases reservation); view job timeline |
| Ledger | Every CREDIT_* and PROVIDER_COST_RECORDED row; derived balance; reconciliation status | 🔐 Ledger adjustment (FINANCE: grant/revoke Creative Tests with reason, four-eyes over limit) |
| Billing | Stripe customer, subscription, invoices, payments, refunds, disputes (mirrored) | Open in Stripe, 🔐 refund (four-eyes > $200), apply coupon, change plan (customer consent recorded) |
| Integrations | Shopify/Meta/TikTok connections: scopes, last sync, cursor, errors, rate-limit history | Force re-sync, pause sync, mark connection degraded, view last raw error |
| Emails | Everything sent to members via Resend: status (delivered/bounced/complained/opened) | Resend, view rendered email, unsuppress address (with reason) |
| Risk | Churn indicators (§10), abuse signals, dispute history | Start intervention playbook, suppress risk flag with reason |
| Access log | Break-glass sessions on this tenant | – |
| Danger zone | – | 🔐 Suspend / unsuspend, lock / unlock, schedule purge / cancel purge, 🔐 export workspace data on legal request |

### 2.3 Tenant edge cases
- Suspending a tenant with jobs in flight: in-flight provider jobs finish and are stored, but not delivered until unsuspended. Reservations aren't released until the job resolves.
- A test account must be excluded from every business metric. `is_test` is filterable everywhere and defaults to excluded.
- Merging two workspaces is **not** supported in V1. Staff move SKUs individually with the owner's written consent (tool: "Transfer SKU to workspace", which copies assets and rewrites IDs in one job, with an audit record).

---

## 3. Users
- Search by email, name or ID. Detail: workspaces and roles, sessions (device, IP city, last seen), login history, failed logins, password reset requests, email status.
- Actions: force logout everywhere, 🔐 lock account (ATO suspicion), resend verification, trigger password reset email. Staff can never set a password.
- Edge cases: a user with the same email as a staff member is still a separate identity. Deleting a user follows 2-multi-tenancy §7.

---

## 4. Acquisition & funnel analytics
- **Funnel by stage** (standard §7 table) sliced by: landing page, campaign/UTM, ad creative ID, device, country/state, new vs returning, offer variant.
- **Stage drop-off drilldown**: e.g. "Upload started but not completed", segmented by failure reason (URL parse failed, unsupported page, file too big, gave up during analysis).
- **Cohorts**: Taste → subscription conversion by week, by landing page, by concept type chosen.
- **CAC**: joins ad spend (manually imported CSV in V1, or our own Meta account read-only) → media CAC per Taste buyer, effective subscriber CAC (Appendix C).
- **Session replays** are **not** built. Use PostHog (self-serve, privacy mode) with inputs masked and replay limited to marketing and funnel pages, never inside tenant workspaces. (**Tooling decision to confirm**.)
- Edge cases: ad blockers under-report the client-side funnel, so stage events are recorded **server-side** as the source of truth. Client analytics are used only for scroll and hover.

---

## 5. Landing pages (GROWTH)

Campaign-specific pages that match each ad's promise (standard §5 "Taste conversion architecture").

- List: slug, headline, archetype (texture demo / serum launch / UGC / creative fatigue / founder…), status (draft, live, paused), traffic 7d, upload-start %, Taste CVR.
- **Editor** with structured blocks only, no free HTML: hero (headline, sub, product-archetype visual), proof strip, how-it-works, example gallery (skincare only; validation rejects non-skincare assets), FAQ, CTA. Live preview on phone and desktop frames.
- Variants: A/B/n with traffic split, sticky assignment per visitor, pre-registered primary metric (upload-start % or Taste CVR) and minimum sample before any "winner" badge. This is the same statistical discipline as the product (§21): shrinkage, no winners from tiny samples.
- UTM → page routing rules (e.g. `utm_content=texture*` → texture page).
- Publish is versioned with a diff; one-click rollback.
- Compliance lint on publish: blocks claims about customer results we can't substantiate ("brands see 3× ROAS") and fake social proof. Testimonials must link to a stored consent record (FTC fake reviews rule, see 04-conversion §Limits).
- Edge cases: deleting a live page is not allowed (pause first); paused pages 302 to the default page, preserving UTMs; an example asset whose rights expire auto-unpublishes from the gallery.

---

## 6. Offers & pricing experiments (GROWTH + FINANCE)

The Offer Engine (standard §7): deterministic and experimentable, never LLM-priced.

- **Offer definitions**: offer_id, type (TASTE, STANDALONE, PLAN_UPGRADE, WIN_BACK), price, currency, duration window (e.g. 60 min), bonus entitlements (e.g. +1 hook variant), eligibility rule (JSON logic: new workspace, never purchased, source page in list…), next-eligible-offer policy, Stripe Price ID.
- **Assignments**: per-workspace view of which offers were issued, when they expire, and whether they were used, expired or superseded.
- **Experiments**: variants (price $19 vs $24; timer 30/60/120 per §55), allocation, guardrail metrics (refund rate, support tickets, trust survey). Auto-stop if a guardrail degrades beyond a threshold.
- Rules enforced by the engine and shown in the UI:
  - An expired offer can't be reissued to the same workspace (§5).
  - A price can't be edited on a live offer; you create a new version.
  - The "regular price" shown as an anchor must be a price we actually charge (Standalone $29 must be live and purchasable). The editor blocks saving if the reference price doesn't match an active price. This is honest anchoring (04-conversion §Limits).
- Edge cases: Stripe Price archived while an offer references it → offer auto-pauses and alerts. Currency: USD only in V1.

---

## 7. Billing & revenue (FINANCE)
- Stripe mirror: customers, subscriptions, invoices, payments, refunds, disputes, synced by webhook and a nightly full reconciliation.
- **Reconciliation report**: Stripe payments ↔ ledger grants ↔ workspace entitlements. Any mismatch goes to an exception list (e.g. paid but no entitlement, entitlement without payment).
- **Unmatched Stripe events** queue (2-multi-tenancy B3/B11): assign to a workspace (🔐, four-eyes) or ignore with a reason.
- Refund tool: choose payment → amount → reason code → customer note. Writes `CREDIT_REFUNDED` plus a Stripe refund in one idempotent operation.
- Dunning view: PAST_DUE workspaces, retry schedule, emails sent.
- Revenue: MRR, ARR, net new, expansion, contraction, churned MRR, by plan and cohort. Logo churn and revenue churn tracked separately; pause/downgrade kept distinct from cancel (Appendix C).
- Disputes: evidence pack auto-assembled (delivery timestamps, export logs, ToS acceptance, IP), submitted via Stripe.

---

## 8. Usage ledger & COGS (FINANCE + OPS)
- **Ledger explorer**: filter by workspace, event type, experiment and job; shows the balance derivation step by step. Never editable. Corrections are new rows.
- **COGS**: by provider, model, modality, resolution and duration; by workspace; by plan; by experiment. Cost per usable export (Appendix C) trend. Share of spend on QA retries. Fallback technique rate.
- **Margin**: per workspace (revenue − variable COGS), flagging tenants below 0% margin for 2 consecutive periods.
- **Stranded reservations**: reservations older than their expiry that haven't settled. The auto-sweeper handles these; the view shows what it did and anything it couldn't resolve.
- **Provider invoice reconciliation**: upload the monthly BytePlus/Anthropic/MiniMax invoice CSV → match to PROVIDER_COST_RECORDED → variance report.

---

## 9. Provider rate tables (FINANCE proposes, four-eyes publishes)
- Versioned table per provider/model: unit (per M tokens, per image, per second, per character), input/output price, resolution multipliers, currency, effective_from, source URL, notes (e.g. resource-package discount recorded as **savings**, not as the rate, §6).
- Publish flow: draft → diff against current → impact preview ("Standard 15s test estimate changes $5.49 → $6.10; 3 plans' margins affected") → approve → effective at a time.
- Every Cost Governor authorization stores the `rate_table_version` (§48 "rate changes after estimate").
- Edge cases: a provider changes price with no notice → OPS can publish an emergency version (four-eyes still required, SUPER_ADMIN can be the second). If price rises above plan viability, an alert suggests pausing affected production modes.

---

## 10. Providers & model routing (ENGINEERING + OPS)
- Provider registry: Anthropic (Opus 5.5), BytePlus (Seedream 5.0 Pro, Seedance 2.5), MiniMax (TTS), BytePlus/ByteDance TTS (fallback). Per provider: status, API key reference (**name only; secrets live in DigitalOcean**, never shown), region, concurrency limit, timeout, retry policy, health (p50/p95 latency, error rate, moderation-reject rate).
- **Circuit breaker** control: auto-open at error-rate threshold; manual open/close with reason. When open, the Production Planner uses the approved fallback or queues (§44 provider outage).
- **Model routes**: task (e.g. `creative_director.propose`, `extract.product_facts`, `qa.label_ocr`, `tts.voiceover`) → provider/model/version + prompt template version + rollout %. Changing a route requires an eval run that passed on the golden set (§41).
- Version drift detector: alerts when a provider returns a model/version string different from the pinned one (§48).

---

## 11. Prompt registry & evaluations (ENGINEERING)
- Prompt templates are versioned (semver), with variables schema, output Zod schema reference, changelog and author. Git is the source; the admin view is read-only and shows which version is live on which route and rollout %.
- **Eval runs**: pick template version × model × golden dataset → run → per-case diff against gold labels, aggregate scores, cost and latency. Compare two runs side by side.
- **Rollout**: canary 5% → 25% → 100% with automatic rollback if live QA first-pass rate or the claim-block rate regresses.
- **Golden datasets** (§51): browse cases (packaging types, claims allowed/ambiguous/blocked, deceptive review language, confounded performance), add cases from production failures (break-glass + explicit tenant consent or synthetic reproduction only; production tenant data is never copied into golden sets without consent).

---

## 12. Jobs & queues (OPS)
- Live view per queue: waiting, active, completed (1h), failed, dead-lettered; throughput; oldest waiting; per-workspace concurrency usage.
- Job detail: payload (secrets and PII masked), state history, attempts, linked ledger rows, provider request IDs, logs and traces (link out), related project state.
- Actions: retry (only if the handler is idempotent and **no new spend**, or with a fresh Cost Governor authorization shown to the operator), cancel (semantics depend on dispatch state, §39), move from dead letter to queue, bulk retry by error class.
- **Stuck detector**: projects in a non-terminal state beyond the expected duration (e.g. RENDERING > 20 min) → list with a suggested action.
- Edge cases: manual retry of a job whose workspace is SUSPENDED is blocked; a retry after a rate-table change re-estimates cost first.

---

## 13. QA review (OPS + COMPLIANCE)
- **Queue**: outputs that failed QA twice (technique switched), hard fidelity fails, and a random 2% sample of passed outputs for calibration.
- Review screen: output video/frames next to the Visual Fingerprint reference views, label-OCR diff highlighted, per-check scores, claim mapping (each spoken or overlay line → Claim ID or ⚠ unmapped).
- Reviewer verdicts: agree/disagree with each automated check, plus a failure taxonomy label. Disagreements feed the golden set (with consent rules as in §11) and QA threshold tuning.
- Metrics: QA precision/recall vs human verdicts, by check and provider.
- Break-glass is required to view content (it's tenant content).

---

## 14. Claims & compliance (COMPLIANCE)
- **RESTRICTED claims queue** (§17: specialist/manual path): claim, evidence attached, SKU, requested markets/platforms. Actions: approve with exact wording + qualifier, keep restricted, block, request more evidence (emails the tenant).
- **Implied-claim flags**: creatives where the whole-creative scanner found possible medical/drug implications (§43). Review and resolve.
- **Blocked-claim attempts**: tenants repeatedly trying blocked claims. This is education, not punishment; a repeated pattern escalates.
- **Drug/OTC detector hits**: SKUs classified as possibly SPF/acne/drug (§1 exclusions) → confirm exclusion → tenant informed that the SKU is out of V1 scope.
- **Before/after and minors**: any merchant-supplied before/after or footage possibly including minors → review (§48).
- Global rules: banned phrase list (e.g. "cures", "heals", "treats acne", "clinically proven" without evidence), versioned, with regression tests (§51).

---

## 15. Rights, abuse & trust-safety (COMPLIANCE + OPS)
- Rights attestations: per uploaded creator/UGC asset; expiring rights calendar (§48 creator rights expiry) → auto-mark unavailable for new production.
- Takedown/rights complaints intake: form + email → case → freeze asset → resolve.
- Abuse signals: provisional-workspace farms (IP /24, ASN, device), card testing, free-preview COGS outliers, upload of non-skincare/prohibited content, prompt-injection attempts detected in imported text.
- Actions: challenge (Turnstile), rate-limit tighten, suspend (🔐), block IP range (time-boxed).
- Edge case: legitimate agencies or photographers evaluating many SKUs trip the multi-SKU heuristic. The "Allowlist for 30 days" action requires a reason.

---

## 16. Integrations health (OPS)
- Per connector type: total connections, % fresh (inside freshness policy §31), error classes, rate-limit hits, API version in use and deprecation dates.
- Per connection (metadata only): last success, last complete date, cursor, scopes granted vs requested, token expiry, degraded flag.
- Platform app status: Meta app review status, TikTok app status, Shopify app listing status, webhook subscription health (Shopify webhook registrations verified nightly).
- Edge cases: Meta API version sunset → banner N days before; contract tests (§51) must pass on the new version before the switch flag is enabled.

---

## 17. Retention & customer success (OPS/SUPPORT)
- **Churn-risk board**: tenants with §10 indicators (7 days idle, paid-no-export, repeated QA rejects, 3 ignored recommendation cycles, disconnected ad account, stockout, utilisation < 25% ×2 or > 95% with friction, no performance-linked test in 30 days, negative support sentiment). Each indicator shows evidence and date.
- **Playbooks**: each indicator maps to a value intervention (e.g. "paid-no-export" → email + in-app "Your ad is ready, here's how to upload it to Meta in 2 minutes"). Automatic discounting is not allowed (§10).
- Cohort retention (W1/W4/M2/M3) by plan, acquisition page and whether an ad account is connected.
- Day-30 SKU Review delivery tracking.
- Cancellation reasons (from the cancel flow) with free-text themes clustered.

---

## 18. Email & lifecycle (GROWTH + ENGINEERING)
- Resend integration: domains (SPF/DKIM/DMARC status), sending stats, bounces, complaints, suppression list.
- Templates (React Email) are versioned in git; the admin shows preview with sample data and test-send to staff.
- Lifecycle sequences: triggers (e.g. storyboard ready but no purchase within the offer window, Taste delivered, week-1 no connection), audience rules, frequency caps (max 1 marketing email/day, 3/week), quiet hours by workspace timezone.
- Transactional vs marketing separation: separate Resend sending streams/subdomains (`mail.` vs `news.`); unsubscribe honoured instantly for marketing, never for transactional (receipts, security).
- Edge cases: complaint rate > 0.1% → auto-pause marketing sends; bounce on an Owner email → tenant banner (2-multi-tenancy M13).

---

## 19. Taxonomy & Creative Genome schema (ENGINEERING + COMPLIANCE)
- Appendix A families and values, versioned. Proposals to add, rename or deprecate values → review → migration plan (how existing genomes are remapped). Free-text tags never become canonical silently.
- Coverage view: how often each value appears across the platform (aggregate counts only; no tenant content).

---

## 20. Feature flags & config (ENGINEERING)
- Flags: key, description, owner, type (boolean, percentage, workspace allowlist, plan-based), default, per-environment values, expiry date (flags past expiry alert their owner).
- Kill switches (pre-created): disable new renders globally, disable free preview, disable a specific provider, disable checkout (maintenance), read-only mode.
- Platform settings: support email, legal URLs, retention periods, quota defaults per plan (2-multi-tenancy §4), free-preview COGS cap.

---

## 21. Data requests & privacy (COMPLIANCE)
- Queue: access/export requests, deletion requests (tenant, user, or reviewer-data removal request from an end customer whose review was imported), with statutory due dates (CCPA 45 days).
- Tools: run workspace export, schedule purge, find and delete a specific person's review text across a tenant (break-glass + tenant notice).
- Purge certificates viewer (2-multi-tenancy §7).

---

## 22. System health (ENGINEERING)
- Service status: web, worker, DB (connections, replication lag, slow queries), Spaces errors, pg-boss health.
- Links to logs/traces/metrics (DigitalOcean Monitoring + OpenTelemetry exporter; **observability vendor to confirm**, default Grafana Cloud free tier).
- Backups: last successful backup, last **restore drill** date and result (§39: must be tested before paid launch).
- Status banner manager: publish an incident banner to all tenants or a subset (e.g. "TikTok sync delayed").

---

## 23. Staff management (SUPER_ADMIN)
- Invite staff, assign roles (four-eyes), require passkey, deprovision, view each staff member's audit trail.
- Quarterly access review checklist: every staff member's roles must be re-confirmed or they're removed automatically after 14 days.

---

## 24. Admin console build order

| Phase (see 06-phases) | Admin modules |
| --- | --- |
| 0 | Staff auth, audit log, Tenants (list + overview + members), Users, Feature flags + kill switches, System health basics |
| 1–2 | Jobs & queues, Providers (read), Prompt registry (read), Abuse signals (free preview) |
| 3 | Billing mirror, Refunds, Unmatched Stripe, Ledger explorer, COGS, Rate tables, QA review, Offers, Landing pages v1, Funnel analytics v1, Email (Resend) |
| 4 | Claims & compliance queues, Retention board, Taxonomy, Evals & rollout |
| 5 | Integrations health, Data freshness, Connector app status |
| 6 | Four-eyes everywhere listed, Data requests, Access reviews, Restore drill tracking |
