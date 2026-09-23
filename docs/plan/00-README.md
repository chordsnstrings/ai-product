# Build Plan: Index

The product standard ([`../standard/`](../standard/), V1.2) defines *what* and
*why*. These documents define *how* we build it.

| # | Document | Covers |
| --- | --- | --- |
| 01 | [Design System: "Arkiv"](01-design-system.md) | Visual language, tokens, components, motion (micro-animations), performance and accessibility budgets |
| 02 | [Multi-tenancy](02-multi-tenancy.md) | Tenant model, roles, lifecycle, 8 isolation layers, quotas, membership/billing edge cases, deletion, isolation tests |
| 03 | [Product Surfaces](03-product-surfaces.md) | Every page: job, layout, conversion levers, states, edge cases, events |
| 04 | [Conversion Playbook](04-conversion-playbook.md) | 22 evidence-backed conversion levers, the US legal line, enforcement in code |
| 05 | [Platform Admin Console](05-admin-panel.md) | Staff access model, break-glass, four-eyes, and 23 admin modules + build order |
| 06 | [Build Phases](06-phases.md) | Phase 0–6 deliverables, tests, exit criteria, decision log |

## Stack at a glance

| Layer | Choice |
| --- | --- |
| Apps | Next.js (`apps/web` customer + marketing, `apps/admin` staff), Node worker (`apps/worker`, FFmpeg) |
| Data | Postgres (DigitalOcean Managed) with Row-Level Security, Drizzle, pg-boss queue |
| Storage | DigitalOcean Spaces + CDN (marketing only) |
| Payments | Stripe Embedded Checkout + Billing + Tax |
| Auth | In-house: magic link, Google, Apple, passkeys |
| Email | Resend + React Email |
| AI | Anthropic Opus 5.5; BytePlus Seedream 5.0 Pro + Seedance 2.5; MiniMax / BytePlus Seed Speech voice |
| UI | Radix primitives, Tailwind v4 tokens, Motion, React `<ViewTransition>` |

## Repository layout

```
apps/
  web/            marketing (static) + funnel + customer app + API routes + webhooks
  admin/          staff console (admin.<domain>), separate auth
  worker/         pg-boss workers: analysis, render, qa, compose, sync, sweeps, purge
packages/
  shared/         enums, event catalogue, Zod schemas, money/ID types
  db/             Drizzle schema, SQL migrations, RLS policies, tenant repositories
  core/           domain modules (standard §33): product-truth, claims, customer-signal,
                  creative-genome, experiments, recommendations, statistics,
                  context-builder, creative-director, production-planner,
                  cost-governor, usage-ledger, qa, offers, authz, events
  auth/           magic links, OAuth (Google/Apple), passkeys, sessions, rate limits
  billing/        Stripe checkout, subscriptions, consent records, webhooks
  providers/      ModelGateway + adapters: anthropic, byteplus, minimax (+ mocks)
  media/          FFmpeg composition, captions, loudness, probes
  integrations/   shopify, meta, tiktok (read-only)
  ui/             design tokens, components, motion presets
  email/          React Email templates + Resend client
infra/do/         App Platform specs, Dockerfiles
tests/            e2e (Playwright), golden datasets, chaos
docs/             standard + this plan
```
