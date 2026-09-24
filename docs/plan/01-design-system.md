# 01 · Design System: "Arkiv"

*Arkiv* is Swedish for archive. The direction crosses Scandinavian brand
minimalism (Acne Studios, Byredo, Aesop's editorial restraint) with the
museum-catalogue page: index numbers, metadata rows, hairline rules and
objects photographed flat on paper.

For this product the metaphor is **literal**. Each SKU becomes a catalogued
object. Every test is an entry in its archive. The Creative Map is the index.
The product's retention promise ("memory compounds", standard §10) is expressed
visually: the archive visibly grows.

> Research note: "Swedish minimal arkiv" isn't a named movement. These rules
> are our synthesis of the references in §9. Letters from Sweden (Acne Studios'
> typeface) is the genuinely Swedish foundry among the usual references.

---

## 1. Principles

1. **Catalogue, don't decorate.** Structure (numbers, rules, metadata) does the work that illustrations and gradients do elsewhere.
2. **One loud thing per screen.** Usually the product image or the primary CTA. Everything else is quiet ink on paper.
3. **Emphasis by weight and size, never by colour.** Colour is reserved for state (signal, risk) and the single CTA accent.
4. **The product is the hero.** The merchant's SKU, photographed flat and centred, appears as early and as large as possible. It's the strongest conversion asset we have (04-conversion L3).
5. **Motion is quiet and meaningful.** Every animation either confirms an action, shows work being done, or reveals structure. Nothing loops for attention.
6. **Honest states.** "Gathering signal", "Directional" and "Actionable" (§21) have a distinct visual grammar and are never styled as wins.

---

## 2. Tokens

All tokens are CSS custom properties generated from `packages/ui/tokens.ts`.
They are plain CSS custom properties in `packages/ui/src/styles.css`; components use `ak-*` classes (no Tailwind).

### 2.1 Colour: light ("Paper")

| Token | Value | Use |
| --- | --- | --- |
| `--paper` | `#F5F2EC` | Page background |
| `--paper-raised` | `#FBFAF7` | Panels, inputs, sheets |
| `--paper-sunk` | `#ECE8E0` | Image wells, code, disabled |
| `--ink` | `#1A1917` | Primary text, primary button fill |
| `--ink-2` | `#4A4742` | Secondary text |
| `--stone` | `#8A857D` | Non-text tertiary marks: placeholder wells, dots, the gathering tint |
| `--stone-text` | `#6B6761` | Tertiary text: labels, index numbers, table headers (stone darkened to pass AA on `--paper-sunk`) |
| `--rule` | `#D6D1C7` | Hairlines (1px; 0.5px on 2× screens) |
| `--rule-strong` | `#BDB7AB` | Table header rules |
| `--rule-input` | `#959087` | Input borders (≥ 3:1 on `--paper-raised`, WCAG 1.4.11) |
| `--accent` | `#7A4A32` (clay) | **Only**: the single primary conversion CTA on marketing pages, focus ring, offer timer |
| `--accent-ink` | `#FBFAF7` | Text on accent |
| `--signal-gathering` | `#8A857D` | Gathering signal (stone: deliberately neutral) |
| `--signal-directional` | `#776734` (ochre) | Directional |
| `--signal-actionable` | `#3F5B45` (moss) | Actionable, QA passed, verified claim |
| `--risk` | `#9B3B2F` (oxide) | Blocked claim, hard QA fail, destructive |
| `--risk-soft` | `#F1E3DE` | Risk backgrounds |

Dark ("Ink") mode inverts: `--paper #141312`, `--paper-raised #1C1B19`,
`--ink #EEEAE2`, `--rule #2E2C29`, and the accent lightens to `#C08A6A`. The
state colours lighten with it: `--stone-text #9A948A`, `--rule-input #716C64`,
`--signal-directional #9C8C55`, `--signal-actionable #7F9383`, `--risk #C27F76`
on `--risk-soft #2E1A16`. Pairs are checked for WCAG AA contrast in CI
(`packages/ui/src/tokens.test.ts`: text ≥ 4.5:1, input borders ≥ 3:1). The
marketing site is light-only; the app follows the system setting with a manual
toggle.

### 2.2 Typography

| Role | Family (free, Google Fonts) | Why |
| --- | --- | --- |
| Sans (UI + body) | **Inter Tight** (variable), fallback Inter, system-ui | Neo-grotesk close to Suisse/Söhne. Tight fit suits catalogue density. |
| Serif (display, editorial moments) | **Instrument Serif** | Condensed editorial serif for hero headlines and the "No." numerals. Used sparingly. |
| Mono (index, metadata, numbers) | **IBM Plex Mono** | Archive labels, IDs, timestamps, prices in tables. |

Scale (px / line-height / tracking):

| Token | Size | LH | Tracking | Family |
| --- | --- | --- | --- | --- |
| `display-xl` | 64 (mobile 40) | 1.0 | −0.02em | Serif |
| `display` | 44 (mobile 32) | 1.05 | −0.02em | Serif |
| `h1` | 28 | 1.15 | −0.015em | Sans 500 |
| `h2` | 20 | 1.25 | −0.01em | Sans 500 |
| `body-l` | 17 | 1.5 | 0 | Sans 400 (marketing body) |
| `body` | 15 | 1.5 | 0 | Sans 400 (app body) |
| `small` | 13 | 1.45 | 0 | Sans 400 |
| `label` | 11 | 1.2 | +0.06em, UPPERCASE | Mono 500 |
| `index` | 11 | 1 | +0.02em | Mono 400 (e.g. `No. 014`) |

Rules: tabular numerals (`font-variant-numeric: tabular-nums`) for every number
in tables, timers and prices. Weights: 400 and 500 only (600 for prices). No
italics except serif pull-quotes. Mobile inputs are ≥ 16px so iOS doesn't zoom.

### 2.3 Space, grid, shape
- 4px base; scale `4 8 12 16 24 32 48 64 96 128`.
- Grid: 12 columns, 24px gutters, max content width 1240px. Outer margin 16px on phone (artifact rule), 32px on tablet, 64px on desktop.
- Radius: `0` everywhere; `2px` on inputs and buttons only. No pill shapes except status chips (radius 999).
- Shadows: **none**. Elevation = `--paper-raised` + 1px `--rule`. The only exception is sheets and dialogs: `0 1px 0 var(--rule), 0 24px 48px -24px rgb(26 25 23 / 0.18)`.
- Hairlines: 1px `--rule` between rows; `--rule-strong` for table headers.

### 2.4 Imagery
- Products shown on `--paper-sunk` seamless wells, centred, consistent 4:5 frame. We auto-generate a **cut-out** of the merchant's product in Phase 1 (background removal), so their bottle sits on our paper within seconds of upload. That's the first "this feels like mine" moment.
- Video thumbnails 9:16 in a fixed well with mono caption: `No. 014 · Texture-first · 15s · 9:16`.
- Slight warm grade on our own marketing imagery. **Never** colour-grade merchant product imagery (it would break product fidelity, §16).
- No stock photography of people. No decorative icons. The icon set is Lucide at 1.5px stroke, used only for functional affordances (upload, play, close, more).

---

## 3. Components (catalogue)

| Component | Arkiv treatment |
| --- | --- |
| **Index row** | `No. 014` mono · title sans · metadata mono right-aligned · 1px rule below. The main list pattern (SKUs, experiments, learnings). |
| **Specimen card** | Image well 4:5 + caption block (index, title, 2–3 metadata pairs). For SKUs and concepts. Hover: image scales 1.02 over 400ms; caption rule extends full width. |
| **Metadata table** | Two columns: `LABEL` (mono 11 uppercase stone) / value (sans 15 ink). For product facts, with provenance chip (OBSERVED / INFERRED / DECIDED). |
| **Provenance chip** | Mono 10: `OBS` stone outline, `INF` dashed outline, `DEC` ink fill. Hover shows source + time. Expresses the §15 three-state doctrine visually. |
| **Signal chip** | `GATHERING` / `DIRECTIONAL` / `ACTIONABLE` / `WEAKENING` / `INVALIDATED`. A dot plus mono label in signal colours. Gathering has a slow 2.4s opacity pulse, the only looping animation allowed, and it signals "waiting on data". |
| **Claim chip** | VERIFIED (moss), QUALIFIER (moss outline + ⓠ), REVIEW (ochre), RESTRICTED/BLOCKED (oxide), INFERRED_ONLY (stone dashed). |
| **Primary button** | Ink fill, paper text, 2px radius, 48px tall on mobile (thumb target), 44px desktop. On marketing CTAs: `--accent` fill. One per viewport. |
| **Secondary button** | 1px ink outline, transparent. |
| **Text button** | Underline offset 4px, thickness 1px; the underline animates in from the left on hover. |
| **Input** | `--paper-raised`, 1px `--rule-input`, label above in mono uppercase. Focus: 2px accent ring offset 2px. Errors: oxide text below, never red borders alone (colour-blind safe). |
| **Upload well** | Dashed 1px `--rule-strong` box with a large serif prompt "Your product, catalogued." On mobile the whole well is a single tap target opening camera/library. |
| **Progress ledger** | Vertical list of work steps with mono timestamps (see §5, labor illusion). |
| **Sheet / dialog** | Bottom sheet on mobile, centred panel on desktop. |
| **Toast** | Bottom-left desktop / top on mobile, ink on paper, 4s, never for errors that need action. |
| **Empty state** | Serif line + one sentence + one action. For example: "Nothing archived yet." / "Your first test will appear here, numbered No. 001." |
| **Tables (admin dense)** | 13px, 36px rows, sticky header, column resizers, keyboard navigation. |

All components are built on **Radix UI primitives** (accessible behaviour) with
our own styling, in `packages/ui`, and documented in a Storybook-style
catalogue page (`/internal/catalogue`), itself designed as an arkiv index.

---

## 4. Motion

### 4.1 Tokens

| Token | Value | Use |
| --- | --- | --- |
| `--dur-instant` | 90ms | Press states, checkbox, toggle |
| `--dur-quick` | 160ms | Hover, chip change, tooltip |
| `--dur-base` | 240ms | Reveals, list insert, tab change |
| `--dur-slow` | 360ms | Sheets, dialogs, page transitions |
| `--dur-deliberate` | 600–900ms | Only "work done" moments (catalogue stamp, render reveal) |
| `--ease-out` | `cubic-bezier(0.16, 1, 0.3, 1)` | Entrances (soft expo-out) |
| `--ease-in` | `cubic-bezier(0.7, 0, 0.84, 0)` | Exits (≈25% shorter than entrances) |
| `--ease-standard` | `cubic-bezier(0.2, 0, 0, 1)` | Moves between two on-screen states |

Travel distance is 4–12px. Scale changes are ≤ 1.03. No bounce, no overshoot.
Springs are allowed only with damping that yields no visible overshoot.

### 4.2 Rules
1. Animate only `transform`, `opacity`, `clip-path` (compositor-friendly).
2. **Never** delay or fade in the LCP element (hero headline or product image). It renders immediately; motion decorates what's around it.
3. Feedback within 100ms of every tap (press state), even if the result is async.
4. `prefers-reduced-motion`: translations, scales and clip reveals become 120ms opacity fades; the Gathering pulse stops; counters jump instead of rolling.
5. Nothing blocks input. Animations are interruptible (Motion handles this).
6. Libraries: CSS transitions for hover/press; **Motion** (`motion/react`, with `LazyMotion` + `m` to keep the bundle small) for component motion; React **`<ViewTransition>`** (stable in React 19.3) for route transitions, with a fade fallback where the View Transitions API is unsupported.

### 4.3 Signature micro-interactions

| # | Moment | Motion | Why (conversion/UX) |
| --- | --- | --- | --- |
| M1 | Upload drop | Dashed border draws to solid clockwise (clip-path, 360ms), then the photo "settles" into the well (8px rise + fade, 240ms) | Immediate confirmation that we have it |
| M2 | **Cataloguing** (product analysis) | Metadata rows appear one by one as each fact is actually extracted (driven by real server events, not a fake timer). Each row: index number ticks up, a hairline draws left→right (240ms), and the value types in over 180ms | **Labor illusion / operational transparency**: showing real work raises perceived value (04-conversion L7). Only real events are shown. |
| M3 | Cut-out reveal | Background-removed product fades onto paper with a 600ms clip reveal from the bottom, like a photograph being placed | The "it's mine" moment (IKEA/endowment) |
| M4 | Catalogue stamp | When the Product Brain is confirmed: `No. 001` stamps in (scale 1.03→1, opacity, 240ms) next to the SKU name, with the date in mono | Marks ownership; the archive starts |
| M5 | Three concepts | Cards enter in a 60ms stagger (12px rise), each with its hypothesis line underlined as it lands | Structure over spectacle |
| M6 | "Why this?" | Inline expansion (height via grid-template-rows 0fr→1fr trick, 240ms) showing evidence rows with provenance chips | Trust |
| M7 | Storyboard frames | Frames "develop": a paper-sunk placeholder → frame via 600ms opacity + slight de-blur (filter, opacity) as each real Seedream image arrives | Anticipation while generation happens |
| M8 | Scene lock | Lock icon closes (90ms) and the frame gets a 1px ink inner rule | Clear state |
| M9 | Offer timer | Mono digits roll per second (translateY 100% → 0, 160ms). **No** red flashing and no acceleration near the end; the colour stays clay | Honest urgency (04-conversion §Limits) |
| M10 | Checkout success | Ink wipe (clip-path) reveals "Archived for production · No. 001-A" and then the progress ledger | Closure plus reassurance |
| M11 | Progress ledger | Each semantic step (§8: preparing product, creating scenes, checking accuracy, checking claims, voice & captions, platform versions) gets a mono timestamp as it completes, and a thin rule grows between steps | Labor illusion with real states |
| M12 | Delivery | Video plays inline immediately (muted autoplay with captions, 9:16 frame); the "Export" CTA fades in 1.2s **after** playback starts | Let the payoff land before any ask (§8) |
| M13 | Signal change | Chip cross-fades (160ms); if it becomes Actionable, a hairline draws under the learning statement once | Calm, no confetti |
| M14 | Hover on index rows | Index number shifts 4px right; the row rule darkens to `--rule-strong` | Scannability |
| M15 | Page transitions | Shared-element transition of the product image between SKU list and SKU page (`<ViewTransition name="sku-{id}">`) | Continuity of "the object" |

Banned: confetti, bouncing, shaking CTAs, attention-seeking loops,
parallax on content, scroll-jacking, autoplaying sound, and cursor followers.

---

## 5. Accessibility & performance budgets

| Budget | Target | Enforcement |
| --- | --- | --- |
| LCP (mobile, landing) | ≤ 1.8s on 4G mid-tier device | Lighthouse CI + real-user monitoring |
| INP | ≤ 150ms | RUM |
| CLS | ≤ 0.05 | Lighthouse CI |
| Landing JS (gzipped) | ≤ 90KB first load | Bundle check in CI |
| Fonts | 3 families, subset latin, `font-display: swap`, preload the 2 above-the-fold files | Build check |
| Contrast | WCAG 2.2 AA | Token test + axe in Playwright |
| Keyboard | Every flow completes by keyboard; visible focus | Playwright a11y tests |
| Touch targets | ≥ 44×44px (primary 48px) | Component tests |

---

## 6. Voice & copy

- Short, declarative and specific. Catalogue tone: "Serum No. 3 · 30 ml · Observed on your product page."
- Never "AI magic", model names, tokens or generator jargon (standard §8).
- Uncertainty is stated plainly: "Too early to call. 1,240 impressions so far; we'll know more by Friday."
- Numbers in mono. Dates as `23 Sep 2026`. Times as `14:02 ET`.

---

## 7. Marketing site vs app vs admin

| Surface | Base size | Density | Accent use | Motion |
| --- | --- | --- | --- | --- |
| Marketing / landing | 17px | Airy, editorial | Primary CTA + timer only | Signature moments (M1–M4, M9) |
| App | 15px | Comfortable | Focus ring; no accent buttons except purchase | Full set |
| Admin | 13px | Dense | None (ink only) | Instant/quick only |

---

## 8. Implementation
- `packages/ui`: tokens, Radix-based components, motion presets (`fadeRise`, `drawRule`, `stamp`, `develop`, `rollDigit`), and `useReducedMotion` wrappers.
- Visual regression: Playwright screenshots of the catalogue page per component and theme.
- Fonts self-hosted via `next/font` (no runtime Google request; better LCP and privacy).

## 9. References
Letters from Sweden × Acne Studios typeface; Byredo identity (Acne Art Department); Aesop web and packaging typography (Suisse Int'l / Optima) and editorial layout; Designmuseum Danmark Furnitureindex; Swedish Design Archive; Sweden brand design principles (sharingsweden.se). Motion: NN/g animation duration guidance, Material 3 easing tokens, Apple HIG motion, web.dev animation performance, motion.dev docs, React 19.3 `<ViewTransition>`.
