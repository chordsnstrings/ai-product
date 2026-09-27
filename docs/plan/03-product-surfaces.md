# 03 · Product Surfaces: Page by Page

Each page lists: **job**, **layout** (mobile first; desktop differences
noted), **levers** (04-conversion IDs), **states**, **edge cases**, and
**events** (server-side, 04-conversion §1). Motion IDs (M1…) refer to
01-design-system §4.3.

Route map:

```
Marketing (static, CDN)          Funnel (dynamic, provisional or user)        App (authenticated, /w/<slug>)
/                                /start            upload                      /this-week
/for/<archetype>  landing pages  /start/:sku       cataloguing + confirm       /map
/pricing                         /start/:sku/concepts                          /studio/:experimentId
/examples                        /start/:sku/save  account gate                /products/:sku  (Product Brain)
/legal/*                         /start/:sku/storyboard   + offer              /products/:sku/claims
                                 /checkout/:offer  embedded Stripe             /results
                                 /produce/:job     progress ledger             /settings/{members,billing,integrations,brand,access-log,data}
                                 /deliver/:asset   watch + export + upsell
Auth: /login  /auth/magic/:token  /auth/google  /auth/apple  /invite/:token
```

---

## Part A: The conversion funnel

### P1 · Campaign landing page `/for/<archetype>` (and `/`)
- **Job:** turn an ad click into an upload within 10 seconds.
- **Layout (phone):**
  1. Top bar: wordmark left; "Log in" text button right. **No nav menu** (single path, L1).
  2. Hero (above fold on a 390×844 viewport): mono label `SKINCARE · AD TESTING`; serif headline that echoes the ad (e.g. "Texture-first ads for your serum. Made this week."); one-sentence sub (grade 6–7, L14).
  3. **Upload module in the hero** (not below): the upload well with two actions, "Upload product photo" and "Paste product link" (L2, L19).
  4. Micro-assurance line under the module: "Free analysis · no card · about 40 seconds" (L2, L10).
  5. Proof strip: live process counters (L13, only when above the minimum), or "Built only for skincare brands" before launch.
  6. "How it works" as a 4-row index list: `01 Your product → 02 Three test ideas → 03 Storyboard → 04 Your ad` (L4 preview).
  7. Example gallery: 3–6 skincare examples labelled "Example" (L13 rules), each 9:16 with mono caption.
  8. What we check: claims (FDA/FTC), product accuracy, platform formats (L14).
  9. FAQ (5 items: price, subscription? no, what's needed, how long, data privacy).
  10. Footer: legal, privacy, contact.
  - **Sticky bottom bar** after the hero scrolls away: "Analyze my product: free" (L19).
- **Desktop:** two columns in the hero (copy left, upload well + animated example right). Max 1240 width.
- **States:** default; returning visitor with a provisional SKU ("Continue with *Serum No. 3*" replaces the hero CTA, L18); logged-in user ("Go to your archive" + "Add a product").
- **Edge cases:** unknown `utm_content` → default page; the in-app browser blocks the file picker (some TikTok versions) → offer "Paste link" first and an "Open in browser" hint; JS disabled → the plain form still posts a URL (progressive enhancement); bot traffic → Turnstile invisible challenge on submit only.
- **Events:** `LP_VIEWED {page, variant, utm}`, `UPLOAD_STARTED {method}`.

### P2 · Upload `/start` (also inline in P1)
- **Job:** get a usable product input with zero friction.
- **Inputs:** URL (Shopify, other stores, Amazon links rejected politely per the ICP), 1–6 photos (camera/library), or both.
- **Behaviour:** starts uploading the moment a file is chosen (presigned PUT to quarantine); the URL is validated as the user types (valid URL shape → a subtle ✓). M1 animation.
- **Levers:** L2, L5 (no account), L6 (parallel upload), L19.
- **Edge cases:**
  - URL is a collection page or home page → "Which product?" picker from parsed products.
  - URL blocked / JS-only / 403 → keep the URL, ask for 1–3 photos, and say what we'll use them for (standard §13).
  - Photo shows several products → tap-to-select the hero product (§42).
  - HEIC from iPhone → convert server-side.
  - A huge file (> 25MB) → compress client-side before upload; if impossible, explain.
  - A non-skincare product (detected) → "We're built for skincare. This looks like *candles*." plus a waitlist email (no generation spend).
  - A drug/SPF/acne product (detected) → explain it's out of V1 scope and offer the waitlist (standard §1).
  - Offline mid-upload → resumable; retry automatically when back online.
- **Events:** `UPLOAD_STARTED`, `UPLOAD_COMPLETED`, `URL_PARSE_FAILED {reason}`, `SKU_VALIDATED`, `SKU_REJECTED {reason}`.

### P3 · Cataloguing `/start/:sku` (analysis in progress)
- **Job:** hold attention for 20–45s and build perceived value (L7).
- **Layout:** product cut-out (M3) top; below it a live **metadata table** filling row by row from real extraction events (M2): name, size, price, category, key ingredients (INCI if found), claims found (each with a claim chip), texture/format; then "3 test ideas being drafted…" rows.
- **Levers:** L3, L4 (rail shows 01 active), L7.
- **Edge cases:** extraction slower than 45s → an honest message: "Your page is detailed; about 20 more seconds" (true estimate from the job); a failure after partial facts → show what we have and ask for the missing field; the user leaves → the work continues, and "Resume" is available on return (cookie) or by email link if captured.
- **Events:** `PRODUCT_ANALYZED {duration}`, per-fact `PRODUCT_FACT_OBSERVED`.

### P4 · Product confirmation (same route, after analysis)
- **Job:** establish product truth fast; a correction must take ≤ 1 tap per fact.
- **Layout:** metadata table with provenance chips (OBS / INF). Each row has an inline edit (becomes DEC). "Claims we found" section: each claim with a plain-language status ("Can use", "Needs your evidence", "We won't use this: medical claim"). An optional prompt: "Add a side/back photo for sharper product accuracy" (only if fidelity confidence is low, standard §13).
- **CTA:** "Looks right: show my 3 ideas" (concepts may already be ready; show instantly).
- **Levers:** L3, L4, L15.
- **Edge cases:** conflicting price (page vs photo) → mark DISPUTED and ask; missing ingredient list → no ingredient claims are inferred (§42); the user edits the product name to something offensive or unrelated → allowed (it's their data), but the fidelity reference stays the photo.

### P5 · Three concepts `/start/:sku/concepts`
- **Job:** make them want one of these ads made.
- **Layout:** 3 specimen cards (M5), swipeable on phone and 3-up on desktop. Each card has:
  - Index `A / B / C`
  - Hypothesis in one line ("Buyers worry it pills under makeup. Show that it doesn't.")
  - Hook text (quoted, serif)
  - Customer tension (with source if from reviews)
  - Production style (mono)
  - Expected learning ("If this wins, texture is your lead angle")
  - "Why this?" expander (M6)
  - One card marked **"Our pick"** plus a one-line reason (L16).
- **CTA per card:** "Storyboard this one".
- **Levers:** L2, L3, L15, L16.
- **Edge cases:**
  - The user wants a different idea → "Try 3 more", limited to 1 regeneration on a provisional workspace (COGS cap), unlimited after signup within rate limits.
  - Concepts contain a claim needing evidence → a chip on the card, and the storyboard will use a compliant alternative.
  - Opus returns fewer than 3 valid concepts after validation → retry once, then show 2 with an honest note (never pad with junk).

### P6 · Save gate (account) `/start/:sku/save`
- **Job:** create the account with minimum friction (L5).
- **Layout:** a bottom sheet over the concepts (context stays visible). Title: "Save *Serum No. 3* and see its storyboard." Buttons: Continue with Apple · Continue with Google · email field + "Email me a link". Small print: Terms + Privacy links (no checkbox needed for a free account; acceptance logged by the action and timestamp).
- **Magic-link flow:** "Check your email" state keeps a **"Keep going here"** promise: the storyboard begins generating immediately in the provisional workspace. When the link is clicked (same or other device), the workspace is claimed.
- **Edge cases:**
  - Email typo (e.g. `gmial.com`) → inline suggestion.
  - Link opened on a different device → claim works there, and the original tab updates via polling or realtime.
  - Link expired (15 min) → a one-tap resend.
  - Existing account → 02-multi-tenancy §2.1.
  - Apple "Hide my email" relay → accepted; we note that Resend deliverability to relays is fine.
  - Disposable email domains → allowed for the free step but flagged for abuse scoring.
- **Events:** `ACCOUNT_CLAIMED {method}`.

### P7 · Storyboard + offer `/start/:sku/storyboard`
- **Job:** show the ad they'll get, then ask for $19.
- **Layout:**
  1. Rail: 01 ✓ 02 ✓ 03 ✓ 04 → (L4).
  2. Storyboard: 4–6 frames developing in (M7), each with a scene line, spoken line, overlay text and duration. The frame count and timing sum to 15s.
  3. "What you'll get" metadata table: 15s · 1 hook · 9:16, 4:5, 1:1 · captions · voice-over · product-accuracy checked · claims checked (L21).
  4. **Offer card** (sealed panel): "Produce this ad" · ~~$29~~ **$19 intro** · "one-time · no subscription" · "Intro price ends **15:42 ET**" with rolling digits (M9) · optional bonus "+ alternate opening hook" if the Offer Engine assigned it (L8, L9, L10). CTA (accent): **"Produce my ad for $19"**.
  5. Guarantee line (L12).
- **Sticky bottom bar (phone):** price + CTA always visible.
- **Edits before paying:** text, CTA or overlay edits are free (standard §13); "Change scene" regenerates one frame, limited to 3 free frame regenerations pre-purchase.
- **States:** offer active; offer expired → the card shows **$29 Standalone** with the same CTA, with no drama and no reissue; already purchased → "In production" link.
- **Edge cases:**
  - The timer tab is backgrounded → the server timestamp governs.
  - The device clock is wrong → display is computed from server time offset.
  - The user opens the storyboard on a second device → same offer, same expiry.
  - Storyboard generation fails → the offer clock **doesn't start** until `STORYBOARD_READY` (standard §5).
  - A Seedream frame has a product-fidelity issue → the frame is replaced with an exact-product composite before display.
- **Events:** `STORYBOARD_READY`, `OFFER_ISSUED {offer_id, variant, expires_at}`, `OFFER_EXPIRED`, `CHECKOUT_STARTED`.

### P8 · Checkout `/checkout/:offer` (embedded Stripe)
- **Job:** take payment with zero surprise.
- **Layout:** left (desktop) or top (phone): an order summary with the storyboard thumbnail, "Serum No. 3 · 15s ad · one-time $19.00 · tax $x.xx · total". Right/below: Stripe Embedded Checkout with Apple Pay / Google Pay / Link first (L11), inside a sealed bordered panel (L12).
- **Edge cases:** see 02-multi-tenancy B1–B5, B10. Also:
  - Wallet unavailable → card.
  - 3DS challenge → handled by Stripe.
  - The user closes checkout → back to P7 with the offer still live.
  - Payment succeeds but the webhook is delayed → the success page polls; production starts only on the webhook (the entitlement source of truth), and the UI shows "Payment confirmed, starting production" once it arrives (usually < 5s).
- **Events:** `TASTE_PAID`.

### P9 · Production progress `/produce/:job`
- **Job:** reassure and build anticipation during about 3–8 minutes of production.
- **Layout:** progress ledger (M11) with semantic steps (standard §8): Preparing product → Creating scenes (n of m) → Checking product accuracy → Checking claims → Voice & captions → Platform versions. Each has a real timestamp. Storyboard frames above are replaced by rendered stills as they arrive.
- **Messaging:** "You can close this page. We'll email you when it's ready." (Resend `ASSET_READY` email).
- **Edge cases:** a QA retry → the step shows "Improving product accuracy" (true), with no alarm; technique switch → "Using your exact product photo for the close-up" (true); provider outage → "Queued: our video partner is busy. Your place is held." plus an ETA if known; exceeds 20 min → a proactive email plus a staff alert (05-admin §12 stuck detector).
- **Events:** `VARIANT_GENERATED`, `QA_PASSED/FAILED`, `COMPOSITION_COMPLETED`.

### P10 · Delivery `/deliver/:asset`
- **Job:** let the payoff land, then get the export, then the plan (L17).
- **Layout:**
  1. The video plays immediately (muted autoplay, captions on, tap for sound), 9:16 frame (M12).
  2. After 1.2s of playback: "Export" (TikTok 9:16 / Reels 9:16 / Feed 4:5 / 1:1) + "Download all".
  3. The QA summary folded under the video: "Product accuracy ✓ · Claims: 3 used, all verified ✓".
  4. **Only after export or 10s of watch:** a continuation card: "2 more directions for *Serum No. 3* are ready to test" with concepts B and C thumbnails → "See plans" (L17).
- **Edge cases:** the user dislikes the ad → "Not right?" diagnoses strategy / accuracy / style (standard §48) and offers one free re-plan if QA-related, otherwise the standalone price; a download on iOS Safari → share-sheet flow; exports carry a platform-safe filename.
- **Events:** `ASSET_WATCHED {seconds}`, `ASSET_EXPORTED {format}`.

### P11 · Plans `/pricing` and the in-app upgrade sheet
- **Layout:** 3 columns (stacked on phone, Growth first on phone with a "Recommended" label, centre on desktop, L16):

  | | Launch | **Growth** | Scale |
  | --- | --- | --- | --- |
  | Price | $49/mo | **$99/mo** | $199/mo |
  | Creative Tests | 3 | **7** | 16 |
  | Per test | ≈ $16 | **≈ $14** | ≈ $12 |
  | vs standalone $29 | | | |

  Plus a line per plan on what a Creative Test includes (standard §5). Then a comparison table and FAQ ("Cancel anytime online in two clicks").
- **Subscription checkout consent (Law, 04 §3):** before payment, a sealed box shows "$99 charged today and every month on the 23rd until you cancel. Cancel online anytime in Settings → Billing." with an **unchecked** checkbox, "I agree to the recurring charge above", which is required. We store the consent record (text version, timestamp, IP, UA, workspace, user) for ≥ 3 years.
- **Edge cases:** an existing Taste buyer → the first month could credit $19 (Offer Engine experiment, not default); already subscribed → the page shows the current plan with upgrade/downgrade; CA users → same flow (we apply ARL to everyone).

---

## Part B: The app (retention surfaces, standard §12)

Global layout: a left rail on desktop (This Week, Map, Studio, Products,
Results + workspace switcher + settings); a bottom tab bar on phone with 5
items. The page header always shows the workspace name and a data freshness
chip ("Meta synced 2h ago").

### A1 · This Week `/this-week` (home)
- **Job:** answer "what should we test this week?" (standard §2 north-star behaviour).
- **Layout:**
  - Serif date line ("Week 39 · 22–28 Sep").
  - **3 recommended experiments** as specimen cards: hypothesis, why now, mode (Controlled/Exploratory), portfolio slot (Exploit/Expand/Explore), estimated Creative Tests, and actions "Approve", "Adjust", "Not now" (with reason).
  - Active jobs strip.
  - "What changed": only significant state changes (standard §11).
  - Entitlement meter: "4 of 7 tests left · renews 23 Oct".
- **Edge cases:**
  - Cold start (no history) → recommendations labelled "Based on your product and reviews, not performance yet" (§48).
  - Stale integration → a downgraded-basis banner (§31).
  - All tests used → "Buy 1 standalone test ($29)" or "Upgrade", no nagging.
  - Recommendations ignored for 3 cycles → a churn-risk signal (§10) and a single question: "Are these the wrong kind of tests?".
  - Out-of-stock SKU → recommendations paused for that SKU unless the merchant opts in.

### A2 · Creative Map `/map`
- **Job:** show the archive: what's been tested, what's under-tested, promising, fatigued, inconclusive.
- **Layout:** index table per SKU: rows = angles (Appendix A), columns = hook mechanisms / production treatments. Each cell is a mono count with a signal colour. Toggle to a timeline view. Click a cell → the experiments in it.
- **Edge cases:** multi-SKU ads are counted in the primary SKU only, with a secondary tag (§48); a taxonomy version change → a banner and the old cells mapped.

### A3 · Studio `/studio/:experimentId`
- **Job:** approve and refine an experiment before spend.
- **Layout:** experiment header (hypothesis, primary variable, held constant); variant columns; scene timeline with lock toggles (M8); a right panel for the selected scene (spoken line, overlay, claim IDs used, production mode, cost class); a natural-language edit box that previews the **structured change** and **entitlement impact** before applying (standard §13).
- **Edge cases:**
  - Editing a locked scene → unlock required.
  - Two members editing → presence avatars plus last-write-wins per scene field, with a conflict toast.
  - An edit would change the primary variable of a CONTROLLED experiment → warn: "This makes it exploratory".
  - An edit introduces an unverified claim → blocked with a compliant alternative.
  - Estimated cost exceeds the Creative Test ceiling → a premium classification prompt (standard §5 V1.1).

### A4 · Product Brain `/products/:sku`
- Tabs: Facts (metadata table with provenance and history per fact), Visual Fingerprint (reference views, label crops, versions), Customer Language (themes with prevalence, trend and snippets), Assets (library with rights status), Offer context (price, bundles, subscription availability), Integrations (source status).
- **Edge cases:** packaging refresh → "New packaging version" flow; Shopify conflict → DISPUTED with both values shown; duplicate SKU detected → a merge offer.

### A5 · Claims Vault `/products/:sku/claims`
- A list by status; each claim shows canonical meaning, preferred wording, qualifier, markets/platforms, evidence documents (upload PDF/image), and history. Approve requires Owner/Admin plus a scope selection.
- **Edge cases:** evidence expiry → the claim auto-moves to REVIEW 14 days before expiry; the merchant insists on a blocked claim → explanation plus alternatives (§43); a RESTRICTED claim → "Our compliance team will review within 2 business days" (05-admin §14).

### A6 · Results `/results`
- An experiment list with signal chips; the experiment detail shows variants side by side with metrics **inside their measurement context** (a Meta paid panel and a TikTok GMV Max panel are never merged), plus the confidence state, what changed, and the effect on recommendations.
- "Mark a confounder" action (stockout, site outage, price change, influencer spike) with a date range.
- **Edge cases:** tiny samples → Gathering signal with a plain explanation; late conversions → "Updated: numbers revised on 24 Sep" with history; mixed currencies → native currency shown, reporting currency converted with the rate date.

### A7 · Creator Pack (inside an experiment)
- A printable/shareable page (signed link, 14-day expiry, revocable): goal, tension, 3 hooks, first-shot guidance, product-visible timing, required shots, approved/forbidden claims, CTA, safe-zone overlay diagram, optional example VO.
- **Edge cases:** the link is forwarded widely → view counter plus revoke; the creator uploads footage back through an upload link scoped to that experiment only (quarantine flow, rights attestation by the merchant on accept).

### A8 · Workspace settings `/settings/*`
- **Members:** list, invite (email + role), pending invites, remove, transfer ownership (02-multi-tenancy §1.1, §5).
- **Billing:** plan, usage meter, invoices (Stripe hosted links), payment method (Stripe portal), **Cancel** (A9).
- **Integrations:** Shopify, Meta and TikTok cards with status, scopes, last sync, disconnect; connection wizards (Day 0–1, standard §9).
- **Brand:** Brand Brain (logo, colours, tone, prohibited aesthetics, disclosures).
- **Access log:** staff break-glass access (05-admin §0.3), integration token events, exports.
- **Data:** export all, delete workspace (02-multi-tenancy §7), retention policy text.
- **Profile (user-level):** name, email, passkeys, sessions (revoke), notification preferences.

### A9 · Cancel flow
- Billing → "Cancel plan" → **screen 1:** what happens (access until period end, archive kept for 90 days, export available) + optional reason (single select + text) + an honest alternative shown **once**: downgrade (and pause when §55 enables it) → **screen 2:** "Cancelled. Your plan ends 23 Oct." plus an export link. Two screens maximum (04 §3).
- **Edge cases:** reserved jobs in flight → honoured (§46); cancel during PAST_DUE → immediate; re-subscribe before the period end → un-cancel with no new charge.

### A10 · Notifications and email (Resend)
- Transactional: magic link, invite, receipt, asset ready, offer ending (the one allowed pre-expiry email), export ready, integration disconnected, QA needs you, claim review result, cancellation confirmation, security (new login, ownership change).
- Weekly: the Monday "This Week" brief, the Friday learning summary (standard §11), the Day-30 SKU Creative Review.
- All emails use the arkiv template: paper background, serif headline, mono metadata, one CTA.

---

## Part C: Auth screens (in-house)
- `/login`: Apple · Google · email magic link · "Use password" (if set) · passkey (conditional UI / autofill).
- Rate limits: 5 magic links per email per hour; 10 login attempts per IP per 15 min, then Turnstile.
- Sessions: 30-day rolling, HttpOnly/Secure/SameSite=Lax cookie, rotated on privilege change; listed and revocable in Profile.
- **Edge cases:** Google and Apple accounts with the same email → linked after verified-email check; the Apple relay email differs from the Google email → two users unless linked from Profile; a magic link clicked twice → the second click shows "Already signed in" if the same browser, else expired; the email provider pre-fetches links (security scanners) → the magic link lands on a confirm page with a button (GET doesn't consume the token; POST does).
