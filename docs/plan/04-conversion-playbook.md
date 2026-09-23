# 04 · Conversion Playbook

**Goal:** convert as many visitors as possible, first to upload, then to $19
Taste, then to a subscription. Every page in 03-product-surfaces cites the
levers below by ID (L1, L2…). Research was done 23 Sep 2026. Evidence
reliability: **PR** peer-reviewed · **V** vendor/industry data · **A**
anecdotal · **Law** statute/regulator.

**How to read this:** we pull *every* lever that works, as hard as it can go,
**inside the legal line in §3**. Past that line a lever stops being a lever
and becomes a lawsuit, an FTC order or a Stripe account review. That would end
the business, so those lines are hard limits, enforced in code (§4).

---

## 1. The funnel we're optimizing

| Stage | Event (server-side) | Target (assumption to calibrate) |
| --- | --- | --- |
| S1 Landing view | `LP_VIEWED` | – |
| S2 Upload started | `UPLOAD_STARTED` | ≥ 35% of S1 |
| S3 Valid SKU | `SKU_VALIDATED` | ≥ 85% of S2 |
| S4 Concepts shown | `CONCEPTS_READY` | ≥ 95% of S3, **≤ 45s** after upload |
| S5 Account created | `ACCOUNT_CLAIMED` | ≥ 55% of S4 |
| S6 Storyboard ready | `STORYBOARD_READY` | ≥ 90% of S5, ≤ 90s |
| S7 Checkout started | `CHECKOUT_STARTED` | ≥ 40% of S6 |
| S8 Taste paid | `TASTE_PAID` | ≥ 75% of S7 |
| S9 Watched / exported | `ASSET_EXPORTED` | ≥ 80% of S8 (§10 target) |
| S10 Subscribed | `SUBSCRIPTION_STARTED` | ≥ 25% of S8 within 14 days (model assumes this order of magnitude, §6) |

Overall click → Taste needs about 9% for a $20 CAC (standard §6). The
product of the above is about 4–5%, so **every stage is an optimization
target**. Stages are recorded server-side because ad blockers hide client
analytics (05-admin §4).

---

## 2. Lever catalogue

Each lever: evidence → where we apply it → exact implementation → metric.

### L1 · Message match (ad → page)
- **Evidence:** matching the headline to the ad copy has lifted conversion by tens of percent in agency case studies (KlientBoost; **A**, the direction is reliable but the size isn't). NN/g: 57% of viewing time is above the fold (**PR-adjacent**).
- **Apply:** one landing page per ad archetype (texture demo, serum launch, UGC, creative fatigue, founder). `utm_content` routes to the page (05-admin §5). The headline repeats the ad's promise word for word. The hero visual is the same archetype as the ad.
- **Metric:** S2/S1 per page.

### L2 · Free value first (zero-price effect + reciprocity)
- **Evidence:** the "free" option jumps in preference far beyond its price difference (Shampanier, Mazar & Ariely 2007, **PR**). Reciprocity for visible effort (Buell & Norton 2011, **PR**).
- **Apply:** product analysis + 3 real concepts **before any signup or payment**. The CTA says "Analyze my product: free". No card required anywhere before S7.
- **Metric:** S2/S1, S5/S4.

### L3 · Their product, on screen, immediately (endowment / "it's already mine")
- **Evidence:** IKEA effect: self-involved creations are valued about 63% more (Norton, Mochon & Ariely 2012, **PR**; effect on AI co-creation not yet proven). Standard §5 principle: "pay to finish something that already feels like theirs".
- **Apply:** a background-removed cut-out of *their* bottle on our paper within about 5s of upload (design M3); their product name catalogued as `No. 001`; every later screen shows their product, not ours.
- **Metric:** S5/S4, S7/S6.

### L4 · Endowed progress + goal gradient
- **Evidence:** a pre-stamped 2/10 card completed 34% vs 19% for a blank 8-stamp card (Nunes & Drèze 2006, **PR**). Effort accelerates near the goal (Kivetz et al. 2006, **PR**).
- **Apply:** a 4-step archive rail visible from upload: `01 Product ✓ → 02 Concepts ✓ → 03 Storyboard → 04 Your ad`. Steps 1 and 2 are already complete when we ask for the account. At checkout: "Step 4 of 4: we've done the strategy; this produces it."
- **Metric:** S5/S4, S7/S6.

### L5 · Lazy registration (account after value)
- **Evidence:** forced account creation is an abandonment reason for 18–19% of US shoppers (Baymard, **V/research**). Baymard recommends creating the account after value is shown.
- **Apply:** no account for S1–S4. The account gate sits between concepts and storyboard (standard §8 requires an account before storyboard). Gate copy: "Save *Serum No. 3* and see its storyboard". It's framed as saving *their* work, not signing up.
- **Signup methods (our own auth):** Continue with Google · Continue with Apple · email **magic link** (no password at signup; the user can set a password or passkey later). Passkeys offered after the first purchase. (Passkey sign-in success 93% vs 63% for other methods, FIDO Passkey Index via secondary source, **V, unverified**.) Fields: **email only**.
- **Metric:** S5/S4, time-on-gate.

### L6 · Speed as a feature
- **Evidence:** 0.1s faster mobile → +8.4% retail conversion (Deloitte/Google, **V**). 1s pages convert 2.5–3× better than 5s pages (Portent, **V**). 53% of mobile visits abandon after 3s (Google, **V**).
- **Apply:** landing LCP ≤ 1.8s on mobile 4G (01-design §5); static-rendered landing pages on the CDN; no client JS needed for the hero; upload starts in parallel with the UI animation; concepts ≤ 45s with progressive streaming. Test inside the Instagram and TikTok **in-app browsers** (that's where paid social traffic opens).
- **Metric:** RUM LCP/INP by page vs S2/S1.

### L7 · Labor illusion / operational transparency (real work, shown)
- **Evidence:** people value a service more when they see the work, even with waits (Buell & Norton 2011, **PR**; the benefit fades if waits get excessive).
- **Apply:** "Cataloguing" screen (design M2) streams **real** extraction events: "Reading label: *Niacinamide 10%* ✓", "Price observed: $38.00 ✓", "Checking claim: *reduces pores* → needs your evidence". The render progress ledger (M11) streams real pipeline states. **Every message corresponds to a real server event**; no scripted fake steps (§3 deception risk).
- **Metric:** S4 drop-off during analysis; post-purchase trust survey.

### L8 · Genuine urgency (the 60-minute Taste)
- **Evidence:** scarcity raises desirability (Worchel et al. 1975, **PR**). **Law:** fake timers and false scarcity are FTC dark patterns (§3).
- **Apply:** a server-side 60-minute window starting at `STORYBOARD_READY`; the real expiry timestamp shown (e.g. "Intro price ends 15:42 ET"); rolling digits (M9) with no flashing. On expiry, the price shown is the real standalone $29, which stays purchasable. The offer is **never** reissued to the same workspace (standard §5). An email 15 minutes before expiry (Resend) links back to the storyboard.
- **A/B:** 30 vs 60 vs 120 min (standard §55) with refund rate and trust as guardrails.
- **Metric:** S7/S6, S8/S7, refunds.

### L9 · Honest anchoring
- **Evidence:** anchoring is robust. **Law:** a reference price must be bona fide (16 CFR 233.1) and prevailing within the prior 3 months in California (B&P §17501).
- **Apply:** "$29 → **$19** intro" only because $29 Standalone is **actually sold every day** to anyone past the window. The admin blocks an anchor that isn't a live price (05-admin §6). On the plans page, anchor on per-ad value: "Growth · $99/mo · 7 tests ≈ $14 per test vs $29 standalone".
- **Metric:** S8/S7; plan mix.

### L10 · Show the total, and "no subscription" (price transparency)
- **Evidence:** 40% of US abandonment is extra costs; 12% can't see the total up front (Baymard, **V**). California SB 478 requires the advertised price to include all mandatory fees (**Law**).
- **Apply:** "$19 · one-time · no subscription · tax shown before you pay". The first checkout never contains a subscription item. The $19 purchase **never auto-converts** into a plan.
- **Metric:** S8/S7.

### L11 · Express checkout
- **Evidence:** Apple Pay → +22.3% conversion on average in Stripe's randomized tests (**V**). Stripe Link: over 7% lift for logged-in Link users (**V**).
- **Apply:** Stripe **Embedded Checkout** (or Payment Element) on our own page, so the arkiv context and their storyboard stay visible. Apple Pay, Google Pay and Link are enabled, with Apple Pay domain verification per environment. Express buttons sit first on mobile and cards second. Name and address are collected only if tax requires it.
- **Metric:** S8/S7 by wallet.

### L12 · Trust at the moment of payment
- **Evidence:** 19% didn't trust the site with card details (Baymard, **V**). Perceived security comes from visual encapsulation of the card fields (Baymard testing).
- **Apply:** payment inside a clearly bordered "sealed" panel; "Payments by Stripe · we never see your card"; a **real** guarantee we honour automatically: "If the ad fails our product-accuracy check twice, you don't pay" (true per standard §25 retry policy); a support email in view.
- **Metric:** S8/S7.

### L13 · Social proof: specific and real only
- **Evidence:** specific, local norms beat generic ones (Goldstein, Cialdini & Griskevicius 2008, **PR**). **Law:** FTC fake-reviews rule 16 CFR 465 (civil penalties about $51.7k per violation).
- **Apply:**
  - At launch we have no customers, so we use **no fake numbers or logos**. We use *process* proof: live counters of real totals ("1,284 claims checked this week"), shown only when they're above a minimum and computed live.
  - After launch: named, consented testimonials, each linked to a consent record; brand logos only with written permission; "Used by N skincare brands" computed live.
  - Example ads are labelled "Example, made for a demo product", never implied as customer results.
- **Metric:** S2/S1, S8/S7 (A/B proof block presence).

### L14 · Authority and specificity (vertical focus)
- **Evidence:** relevance and message match (L1). Readability: 5th–7th-grade copy has an 11.1% median conversion vs 5.3% (Unbounce, **V**, correlational).
- **Apply:** "Built only for skincare" is a trust signal in itself. Show skincare-specific intelligence on the landing page: "We check every claim against FDA/FTC cosmetic rules before it reaches your ad". Plain words, short sentences, grade 6–7 readability, checked in CI with a readability lint on landing copy.
- **Metric:** S2/S1.

### L15 · Commitment ladder (foot in the door)
- **Evidence:** a small first request raises compliance with a larger later one (Freedman & Fraser 1966, **PR**; smaller average effect in meta-analyses).
- **Apply:** tiny steps: paste link → pick 1 of 3 concepts (a choice they own) → save → approve storyboard → $19 → plan. Each step is one decision and one tap.
- **Metric:** stage-to-stage conversion.

### L16 · Choice architecture: 3 concepts, 3 plans, one default
- **Evidence:** centre-stage effect (Valenzuela & Raghubir 2009, **PR**). "Most popular" badge lifts reported by vendors (**unverified**). The decoy effect largely fails with realistic stimuli (Frederick et al. 2014, **PR**), so **no decoy plans**.
- **Apply:** exactly 3 concepts (standard §13), with the recommended one marked "Our pick for this SKU" plus a one-line reason. Plans: Launch / **Growth (recommended, centre)** / Scale, with Growth pre-highlighted but **not** pre-selected into a purchase.
- **Metric:** plan mix, S10.

### L17 · Paywall after value, upsell after payoff
- **Evidence:** a hard paywall after context converts far better than freemium in apps (RevenueCat 2026, **V**). Post-purchase upsell is best at peak goodwill (**V**, e-commerce).
- **Apply:** the $19 ask appears only at the storyboard (value seen, asset withheld). The plan upsell appears only **after** the finished ad has played (design M12). It's framed as continuation: "2 more directions for *Serum No. 3* are ready to test. Growth makes them 7 tests a month."
- **Metric:** S10.

### L18 · Loss framing of *their* work (truthfully)
- **Evidence:** loss aversion (Kahneman & Tversky, **PR**).
- **Apply:** "Your storyboard for *Serum No. 3* is saved. The $19 intro price ends at 15:42." On leaving: "Your concepts are saved in your archive." True statements only; no "you will lose everything" (confirmshaming is banned, §3).
- **Metric:** return rate from reminder email.

### L19 · Mobile-first mechanics
- **Evidence:** 49% one-handed grip, about 75% of interactions thumb-driven (Hoober, **observational**). 54–60% of mobile sites use the wrong keyboard (Baymard, **V**). About 83% of landing traffic is mobile (Unbounce, **V**).
- **Apply:** a sticky bottom CTA bar on every funnel page (48px, safe-area aware); `input type="url"` + `inputmode="url"` for links, `type="email"` + `autocomplete="email"`; `<input type="file" accept="image/*" capture="environment">` offered **alongside** library upload; "Paste link" reads the clipboard on tap (with permission); no hover-dependent UI.
- **Metric:** S2/S1 on mobile vs desktop.

### L20 · Recovery loops (abandonment)
- **Apply:** captured email plus a saved storyboard → Resend sequence: T+15 min before offer expiry ("Your intro price ends at 15:42"), T+24h ("Your storyboard is saved; standalone price $29"), T+3d (a new concept for the same SKU; costs us about $0.05 of Opus, not a render). Frequency cap: 3 emails, then stop. One-click unsubscribe.
- **Metric:** recovered S8 per 100 abandoned S6.

### L21 · Reduce anxiety about the output
- **Apply:** show exactly what will be produced before paying (standard §8): 15s, 9:16 + 4:5 + 1:1 exports, hook text, scenes; "product accuracy checked"; "claims checked"; a sample of the QA report.
- **Metric:** S7/S6, refunds.

### L22 · Continuous experimentation (the Offer Engine)
- Every lever above is a candidate A/B in the Offer Engine and Landing variants (05-admin §5–6), with pre-registered metrics, minimum samples and guardrails (refund rate, chargebacks, complaints). We apply our own statistical discipline (§21) to our funnel.

---

## 3. The legal line (hard limits)

| Never | Why | Rule |
| --- | --- | --- |
| Countdown timers that reset, restart per session/device, or aren't tied to a real expiry | FTC dark patterns report (2022); §5 FTC Act | Offer expiry is a DB timestamp, per workspace, never reissued |
| "Only 3 spots left", "12 people viewing" | False scarcity / false demand | No such components exist in `packages/ui` |
| Reference prices we don't charge | 16 CFR 233.1; Cal. B&P §17501/§17500 | Anchor must reference a live, purchasable price |
| Hidden fees; total revealed only at the end | Cal. SB 478; FTC §5 drip pricing | Total shown on offer card |
| Pre-checked subscription, or subscription bundled into the $19 purchase | ROSCA; Cal. ARL (AB 2863) | $19 is a one-time Stripe Price; plans are separate |
| Subscribing without separate express consent to auto-renew terms | ROSCA §8403; Cal. ARL (affirmative consent, not buried in ToS) | Unchecked consent checkbox next to the recurring terms; consent record kept ≥ 3 years |
| Hard-to-cancel flows | ROSCA "simple mechanism"; Cal. ARL online cancel. (FTC Click-to-Cancel rule was vacated July 2025; the FTC restarted rulemaking via ANPRM Mar 2026, so we design for it anyway) | Cancel online in ≤ 2 screens; save offer shown at most once; no phone/chat required |
| Fake/AI-generated testimonials, paid reviews, fake follower counts | 16 CFR 465 (2024) | Testimonials require a consent record ID |
| Confirmshaming ("No thanks, I don't like more sales") | FTC dark patterns report | Decline buttons are neutral: "Not now" |
| Fake progress steps | Deception; also breaks L7 trust | Progress UI only renders server events |
| Implying example ads are customer results | Endorsement Guides | "Example" label enforced by component prop |

Annual renewal reminders don't apply (monthly plans only). Price-change
notices to subscribers are required (Cal. ARL); built in Phase 4. **Get a
one-hour review from a US consumer-protection lawyer on the checkout, plan
and cancel flows before paid launch** (added to Launch Gates in 06-phases).

---

## 4. Enforcement in code
- `packages/ui` has no scarcity/urgency components except `<OfferExpiry offerId>`, which reads the server timestamp.
- `<Testimonial consentId>`: build fails without a consent ID; the runtime hides it if consent is revoked.
- `<ExampleAsset>` always renders the "Example" label.
- Landing publish lint (05-admin §5): readability grade, banned phrases, anchor validity, testimonial consent.
- Checkout contract tests: $19 session contains no recurring items; subscription checkout requires `consent_record_id`.
- Cancel flow e2e test: ≤ 2 screens from Billing to Cancelled.

## 5. Sources
Unbounce Conversion Benchmark (41k pages); NN/g Scrolling & Attention; Deloitte/Google *Milliseconds Make Millions*; Portent site-speed study; Baymard cart-abandonment list and checkout research; Stripe payment-methods A/B study and Link data; Nunes & Drèze 2006; Kivetz, Urminsky & Zheng 2006; Norton, Mochon & Ariely 2012; Buell & Norton 2011; Shampanier, Mazar & Ariely 2007; Goldstein, Cialdini & Griskevicius 2008; Freedman & Fraser 1966; Johnson & Goldstein 2003; Valenzuela & Raghubir 2009; Frederick, Lee & Baskin 2014; Anderson & Simester 2003; Luguri & Strahilevitz 2021; RevenueCat State of Subscription Apps 2026; Hoober 2013; FTC *Bringing Dark Patterns to Light* (2022); 16 CFR 233.1; Cal. B&P §17500–17501; Cal. SB 478; ROSCA 15 U.S.C. §8403; Cal. AB 2863; 8th Cir. vacatur of Click-to-Cancel (Jul 2025) and FTC ANPRM (Mar 2026); 16 CFR 465 Consumer Reviews and Testimonials Rule. Unverified items are marked in the text.
