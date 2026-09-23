SKINCARE CREATIVE OS
Product, Software & Operating Standard
V1.1  |  23 September 2026  |  US DTC Cosmetic Skincare
<TABLE>
| SOURCE OF TRUTH / This document defines what the product is, who it is for, what it must and must not do, how the intelligence layer is structured, how customer value compounds over time, and the software/operating rules engineering must follow. Where this standard conflicts with an ad-hoc feature request, the standard wins until the decision is deliberately revised and versioned. |
</TABLE>
Product promise
Know what skincare ad to make next. Then make it.
An AI performance-creative operating system built exclusively for small, already-selling DTC skincare brands that need a continuous pipeline of credible, product-accurate creative tests for Meta and TikTok.
# Document Control
<TABLE>
| Field | Current standard |
| Status | Normative V1 product/software standard |
| Primary market | United States |
| Primary vertical | DTC cosmetic skincare |
| Primary buyer | Founder / Head of Growth / Performance Marketer / Ecommerce Manager |
| Primary job | Decide what creative to test next, produce it quickly, and learn from results |
| Primary channels | Meta + TikTok; Shopify as product-commerce source |
| Commercial entry | Free personalized preview -> $19 Taste -> $49 / $99 / $199 subscriptions |
| Development environment | Claude Code / Opus 5.5 is suitable for implementation; runtime architecture remains model-agnostic |
| Financial scope | Platform economics only; human payroll and other human OPEX/CAPEX excluded from current model |
| External facts verified | 23 September 2026 |
| Revision | V1.1 - reconciled billing event names, fixed CONFOUNDED typo, corrected R25 citation, added Creative Test cost ceiling, recorded stack decisions (Stripe, in-house auth, Postgres-backed queue, DigitalOcean). |
</TABLE>
## How to use this document
Requirements marked MUST, MUST NOT, SHOULD and MAY use their normal engineering meaning. MUST and MUST NOT are launch gates. SHOULD indicates a default that may be overridden only with a documented reason. MAY indicates optional functionality. Research-derived facts carry source markers such as [R4]; commercial assumptions and internal targets are labelled as assumptions or targets rather than presented as external facts.
The product must remain narrow. A feature that makes the system more impressive as a generic AI tool but does not materially help an in-house operator at a US DTC skincare brand create, test or learn from performance creative is out of scope for V1. This document deliberately prefers compounding customer intelligence and trustworthy workflow over feature breadth.
## Contents
• Part I - Product doctrine and market
• Part II - Commercial system and acquisition
• Part III - Complete customer experience and retention
• Part IV - Product surfaces and UX rules
• Part V - Proprietary intelligence core
• Part VI - Production, QA and creator workflows
• Part VII - Platform integrations and data contracts
• Part VIII - Software architecture and engineering standard
• Part IX - Edge cases, failure modes and abuse resistance
• Part X - Metrics, launch gates, roadmap and risk register
• Appendices - taxonomies, schemas, events, formulas and source register
## Decision hierarchy
1. Regulatory and platform safety outrank conversion optimization.
2. Product truth and claim provenance outrank persuasive copy.
3. Customer control and transparency outrank autonomous convenience.
4. Product fidelity outranks visual spectacle.
5. Useful learning from controlled creative experiments outranks raw content volume.
6. Cost per usable exported experiment outranks cost per generated second.
7. Retention must come from compounding value and memory, never dark-pattern lock-in.
8. Provider/model choice is implementation detail; proprietary customer intelligence is the durable asset.
# Executive Standard
The company is not building a general AI video generator. It is building a skincare-specific performance creative operating system. The system learns each SKU, preserves product truth and approved claims, decomposes historical ads into a Creative Genome, turns customer language and past performance into explicit hypotheses, recommends the next experiments worth running, produces those experiments using the cheapest technique that can meet quality, validates every output before the merchant sees it, and learns from Meta/TikTok performance without overstating statistical certainty.
[IMAGE]
Figure 1. The product loop: memory and learning are the product; generation is one stage inside it.
<TABLE>
| North-star behaviour / A merchant should open the product on Monday and see "What should we test this week?" rather than "What would you like to generate?" The home screen should progressively become more useful as the SKU accumulates experiments and evidence. |
</TABLE>
<TABLE>
| Non-negotiable | Standard |
| ICP | US DTC cosmetic skincare brand; already selling; active paid-social operator; small in-house team. |
| Object hierarchy | Brand -> SKU -> Hypothesis -> Experiment -> Variant -> Performance -> Learning -> Recommendation. |
| Intelligence boundary | Opus proposes and interprets. Deterministic services validate claims, attribution, cost, entitlement and confidence. |
| Generation boundary | No creative agent may directly spend model budget; every billable request passes Cost Governor. |
| Truth model | Observed, inferred and decided information must never be collapsed into one state. |
| QA | Provider success is not customer success. Every output passes product, claims, visual, audio and platform QA. |
| Retries | One automatic paid-model repair/retry maximum. Repeated failure changes technique instead of looping spend. |
| Retention | Weekly recommendations, persistent SKU memory and performance learning create recurring value. |
| Scope control | No generic image/video playground, no broad vertical expansion, no autonomous media buying in V1. |
</TABLE>
PART I
Product doctrine and market
This section is normative unless explicitly marked as a hypothesis, experiment, benchmark or future-state item.
# 1. Product Definition
## What we are building
The product is an AI performance-creative team for DTC skincare brands, delivered as software. It does not sell model access, tokens, seconds of generation or an avatar library. It sells a repeatable creative decision loop: understand the SKU, identify the next valuable hypothesis, build controlled variants, deliver platform-ready assets, observe results, update confidence and decide what to test next.
The core user-facing promise is: "Know what skincare ad to make next. Then make it." The system should reduce the operator's need to coordinate separate research, scripting, creator briefs, storyboards, AI generators, editors, claim reviews and performance spreadsheets. It should not attempt to replace creators or ad-platform optimization algorithms. It should make the brand's creative supply smarter and faster.
## Why skincare is the fixed V1 vertical
Skincare is large enough to justify a vertical product and has unusually repeatable creative structures: routines, textures, application, ingredient education, objections, comparisons, social proof, founder/expert explanation, value, bundles and problem-oriented narratives. Charm estimates skincare generated $844.1M of US TikTok Shop GMV in the 12 months ending June 2026 and was the largest beauty subcategory in its dataset [R3]. NIQ reports beauty represents 46% of FMCG value sales on TikTok Shop and that roughly 30% of TikTok Shop beauty buyers had not purchased beauty online in the previous year [R2].
The addressable creative problem is also structurally strong. MADA estimates US TikTok Shop Beauty & Personal Care generated $1.92B between January and July 2026 across 39,855 active shops, with 81.8% of category revenue attributed to affiliate creators and 69% to short video [R1]. These are third-party estimates, not official TikTok reporting, and attribution definitions vary; the strategic implication is still clear: creative supply and creator content are central to skincare commerce.
## Exact target group
<TABLE>
| Dimension | Launch ICP |
| Geography | United States first. UK may be evaluated later; V1 copy, policy logic and integrations optimize for the US. |
| Category | Cosmetic skincare: cleansers, moisturizers, serums, masks, facial oils, eye products and adjacent non-drug cosmetics. |
| Company profile | Founder-led or small growth team, typically 1-10 people. |
| Revenue proxy | Roughly $20k-$300k/month online sales. This is an internal targeting heuristic, not an industry boundary. |
| Paid-social proxy | Roughly $3k-$50k/month across Meta and/or TikTok. |
| Product profile | At least one proven SKU/hero product; typically 1-30 active SKUs. |
| Creative need | Needs at least five new creative variations per month and experiences creative throughput as a constraint. |
| Primary buyer/user | Founder, Head of Growth, Performance Marketer or Ecommerce Manager responsible for creative testing. |
| Primary stack | Shopify plus Meta Ads and/or TikTok Shop/TikTok Ads; creator/UGC assets often live in Drive/CapCut or creator messages. |
| Core JTBD | "Give me new ads worth testing this week without another shoot, creator coordination cycle or blank-page brief." |
</TABLE>
## Who is explicitly not the V1 target
• Pre-revenue skincare startups seeking their first demand signal; they are likely to have high churn and little performance history.
• Dropshippers that change products constantly; persistent SKU intelligence has little value for them.
• Amazon-only or marketplace-only brands with little paid-social creative testing.
• Enterprise beauty companies requiring complex procurement, legal workflows and multi-region governance from day one.
• OTC acne-treatment, sunscreen/SPF and other drug or drug/cosmetic products unless a dedicated regulatory path is later built.
• Agencies as the primary user, generic social-media managers, creators, influencers, fashion, restaurants, real estate, apps and unrelated verticals.
# 2. Market Behaviour and Jobs To Be Done
## The problem is creative throughput plus decision quality
The customer does not fundamentally have a video-generation problem. They have a weekly decision problem: existing winners fatigue, creator deliveries are inconsistent, agencies can execute without understanding the SKU, and ad platforms increasingly automate targeting/bidding while still requiring a pool of quality creative. TikTok's current GMV Max automatically uses merchant, organic and authorized affiliate creatives and optimizes paid plus organic delivery at the product level [R4]. TikTok also recommends active creative supply and, in its SMB Shop Ads checklist, at least five videos before launch and two to three new affiliate videos per week thereafter [R6].
The software therefore must optimize "learning velocity" rather than "render volume." The valuable output is a Creative Test: a documented hypothesis with controlled or intentionally exploratory variants, platform-ready production and enough lineage that later performance can teach the system something. An attractive video that cannot be connected to a hypothesis is content; it is not creative intelligence.
## Recurring skincare creative territories
<TABLE>
| Territory | Examples of questions the system should test |
| Problem / solution | Which customer problem produces the strongest attention and intent for this SKU? |
| Texture / sensory | Does fast absorption, finish or consistency matter to purchase intent? |
| Routine placement | Morning vs night; before makeup; after cleansing; simpler routine. |
| Ingredient education | Which ingredient story is understandable and supported by the actual product evidence? |
| Objection handling | Sticky, pilling, sensitive-feeling skin, price, complexity, compatibility. |
| Application / how-to | Quantity, order, visible usage, demonstration and product handling. |
| Comparison | Approved, substantiated comparison against a routine/problem rather than unsupported competitor denigration. |
| Social proof | Customer language or creator experience without turning anecdote into efficacy substantiation. |
| Founder/expert | Origin, formulation rationale and education where authority is genuine. |
| Offer/value | Bundle, subscription, price anchoring, free shipping or limited promotion. |
| Lifestyle / identity | Premium, simplicity, ritual, self-care, convenience, travel, gifting. |
| FAQ / comment response | Turn actual customer questions into ads while staying inside Claims Vault. |
</TABLE>
TikTok's beauty guidance explicitly highlights product reviews, problem/solution, tutorials, hacks, routines, comment responses and related educational formats [R7]. The product should encode these as a starting taxonomy but learn the SKU-specific pattern rather than assuming category best practice guarantees performance.
# 3. Competitive Standard
## What competitors already do well
<TABLE>
| Competitor | Current strength | Our required response |
| Higgsfield | Product URL to ads across UGC, cinematic and TV-spot directions; broad frontier-model creative environment [R18]. | Do not compete on model shelf. Match low-friction ingest, then win on skincare memory, claims, controlled testing and performance learning. |
| Creatify | URL-to-ad, 1,500 actors, 100+ premium models, competitor tracking, Performance Agent, automations and Meta/TikTok launching on its Pro tier [R19]. | Assume generic ad generation and agentic campaign workflow are commodity. Our recommendation logic must understand a SKU more deeply. |
| Arcads | 1,000+ AI actors, workflow canvas and one-product-to-multiple-creative-directions capability [R20]. | Use AI talent when useful, but do not make actor choice the product. Real creator footage may outperform synthetic content. |
| Foreplay | Massive cross-platform ad research corpus and creative research workflows; MCP exposes 200M+ ads [R21]. | Market intelligence can inform exploration, but our moat is first-party SKU memory, evidence and controlled learning. |
| Motion | Deep creative insights and video drop-off analysis for Meta/TikTok [R22]. | Do not stop at dashboards. Convert observations into the next test while preserving uncertainty. |
| Pencil | Modular creative agents for audience, strategy, copy, generation and related workflows [R23]. | Our agents must remain orchestrated by deterministic truth/cost/confidence systems and skincare-specific data. |
| Pippit | Product URL ingestion, ecommerce video creation, scheduling/publishing and social analytics [R24]. | Publishing is not differentiation. Our output should be a smarter creative portfolio, not a more complete social scheduler. |
</TABLE>
## Where we must be objectively better
1. Persistent SKU-level Product Brain, rather than restarting from a product page for each generation.
2. A Claims Vault with evidence provenance, implied-claim detection and market/platform restrictions.
3. A Creative Genome that records what has actually been tested and what changed between variants.
4. A controlled Experiment Engine that distinguishes exploration from causal learning.
5. Product fidelity as a hard QA gate, especially packaging text, geometry and color.
6. Skincare-specific customer-language understanding from reviews/comments rather than generic persona invention.
7. Creator Packs that translate the same hypothesis into a real-creator brief instead of pretending AI talent replaces affiliates.
8. Performance learning that preserves attribution context and statistical uncertainty.
9. An interface centered on "what should we test next?" rather than "choose a model / template / actor."
# 4. Scope Discipline
## V1 includes
• Shopify/product URL and manual asset ingestion; persistent Product Brain and Brand Brain.
• Read-only Meta and TikTok performance connections where permissions/API access allow.
• Customer Language ingestion from approved sources; theme clustering with provenance.
• Claims Vault; product visual fingerprint; brand rules; creative-history import and genome extraction.
• Weekly experiment recommendations; Creative Test creation; storyboard review; scene locking/versioning.
• Seedream concept/storyboard generation and Seedance 2.5 video generation through provider adapters.
• Use of real uploaded footage/product assets, motion graphics, AI talent and generated footage according to Production Planner.
• Product/claims/visual/audio/platform QA with one automatic repair attempt and technique fallback.
• Platform-ready TikTok, Instagram Reels and Facebook exports; creator-ready briefs from the same hypothesis.
• Cost Governor, usage ledger, internal COGS dashboard and event-level auditability.
## V1 explicitly excludes
• Generic image or video playgrounds; unrestricted prompts are not a primary product surface.
• Fashion, fragrance, haircare, makeup and other vertical expansion until the skincare loop demonstrates retention.
• Full CapCut/Premiere-style editor; only the controls required to approve or correct an experiment.
• Autonomous ad-budget changes, bidding, campaign optimization or media buying.
• Creator discovery/marketplace/CRM; V1 creates creator briefs but does not become an affiliate-management platform.
• Complex enterprise roles, procurement, multi-region regulatory workflow or bespoke legal approval chains.
• Claims that require drug/OTC pathways unless specifically supported by a future compliance module.
• Artificial feature volume such as hundreds of templates whose only purpose is catalogue size.
PART II
Commercial system and acquisition
This section is normative unless explicitly marked as a hypothesis, experiment, benchmark or future-state item.
# 5. Offer Architecture
The commercial system must sell business value rather than compute. Users should understand "Creative Tests" and finished deliverables; model tokens and generation seconds remain internal accounting units. Raw generation is becoming commoditized, while the customer's accumulated product/creative intelligence should become more valuable over time.
<TABLE>
| Offer | Price | Customer receives | Commercial role |
| Free preview | $0 | Product analysis, three strategic concepts, one visual/storyboard preview; no expensive finished video. | Demonstrate thinking before asking for money; target preview COGS <= $0.20. |
| Taste | $19 once | One finished 15-second ad for the chosen concept, one primary hook, TikTok/Instagram/Facebook exports, product/claims QA. | First monetized conversion event; acquisition-cost recovery and proof of output quality. |
| Standalone | $29 | One standard finished ad outside a subscription. | Makes subscription economics obvious without forcing commitment. |
| Launch | $49/mo | 3 Creative Tests per month. | Small operator beginning continuous testing. |
| Growth | $99/mo | 7 Creative Tests per month. | Default core-ICP plan; maintain meaningful weekly creative supply. |
| Scale | $199/mo | 16 Creative Tests per month. | Aggressive testing / multiple variants / higher activity. |
</TABLE>
## Definition of a Creative Test
A standard Creative Test is one explicit hypothesis with one master body/creative direction, up to three economical hook/copy variants where feasible, platform adaptations, claim/fidelity QA and experiment lineage. The production plan should reuse expensive footage aggressively; hook variants should preferentially use original assets, alternate copy/voice, motion graphics, crop/pacing changes or short incremental scenes rather than three complete video regenerations. A Smart 60-second explainer consumes more internal entitlement; a fully generative 60-second film is a premium output and should not be treated as equivalent to a short test. Cost ceiling (V1.1): a standard Creative Test is budgeted at no more than $8.50 variable COGS - one full standard output (~$5.49) plus at most two incremental hook scenes of up to 5 generated seconds each (~$1.45 each including retry reserve). Any further hook variants must be non-generative (re-cut, re-caption, voice or motion graphics). Cost Governor MUST refuse a Creative Test plan that exceeds the ceiling unless it is explicitly classed as premium. At $199/16 = ~$12.44 revenue per test this keeps Scale above ~30% variable margin; the ceiling is an assumption to validate in the pilot.
## Taste conversion architecture
Paid traffic should not land on a generic pricing page. It should land on a specialized page that exactly matches the ad premise: for example, skincare UGC, texture demonstration, serum launch or creative-fatigue replacement. The user uploads a product or product URL, receives Product Brain analysis and three real concepts, selects one and reaches a personalized storyboard. Only then does the $19 Taste offer appear.
The default Taste offer is a genuine account/session-bound introductory production price that lasts 60 minutes after the qualifying storyboard is ready. The regular standalone price is $29. The timer MUST be server-side, MUST NOT reset on refresh, and the same expired offer MUST NOT be silently reissued. Higgsfield currently uses account-specific Exclusive Offers that expire and cannot be reactivated in the same form [source to be added; R25 covers paid-trial pricing structure only]; the product should borrow the credible urgency mechanism, not deceptive evergreen countdown behaviour.
<TABLE>
| Conversion principle / The customer should pay to finish something that already feels like theirs. By checkout they should have seen their SKU, a relevant hypothesis, a visual direction and a storyboard. We are not asking them to buy access to software; we are asking whether they want the ad already designed for their product produced. |
</TABLE>
# 6. Unit Economics and Cost Guardrails
The current financial model intentionally prices from ordinary provider economics rather than relying on promotional resource packages. BytePlus currently lists Dreamina Seedance 2.5 at $10.70 per million tokens without video input and $6.40 per million with video input [R14]. Seedance 2.5 supports up to 30 seconds per generation and resource packages advertise usage offsets up to roughly 1:1.8 [R15]. Dola Seedream 5.0 Pro starts at $0.045 per image [R16]. Opus 5.5 is currently $4/M input, $20/M output and $0.20/M cache reads [R17].
<TABLE>
| Paid-output cost driver | Planning allowance |
| Seedance raw cost - standard 15 sec 720p | $3.47 |
| Automatic QA retry reserve | 25% of raw video cost |
| Opus/agent reasoning | $0.50 |
| Seedream concept/storyboard | $0.30 |
| Voice/audio | $0.05 |
| Transcode/storage/delivery | $0.15 |
| Other variable platform buffer | $0.15 |
| All-in planning COGS | ~$5.49 per standard paid output |
</TABLE>
The Cost Governor MUST use the live provider rate table and actual requested modality/resolution/duration rather than hard-coded assumptions. Promotional packages reduce realized cost but should be recorded as savings, not treated as necessary for retail viability. The primary cost metric is cost per usable exported Creative Test, not cost per generated second.
## Current 12-month platform-only model - working baseline
The existing driver-based workbook is a planning model, not a forecast, and was built before the final skincare-only acquisition plan is fully re-based. Under its current Base assumptions it shows $340k of Year-1 paid media, approximately 7,490 Taste buyers, approximately 1,873 new subscribers, 1,548 ending active subscribers, $139k ending MRR, $749k Year-1 net revenue and about $127k platform contribution after variable platform costs and paid media. It shows approximately $45.39 media CAC per Taste buyer, $136.66 effective CAC per subscriber after Taste contribution, about 2.45 months CAC payback and 6.93x simple contribution LTV/effective CAC. These figures MUST be recalibrated as real skincare ICP traffic data arrives; they are valuable as sensitivity structure, not as promises.
A critical result from the model is that a $20 Taste CAC is a stretch target, not a baseline assumption. Under the current paid-social inputs, the blended click-to-Taste conversion would need to approach roughly 9% to hit that CAC. The business should therefore instrument every funnel stage and improve conversion through relevance, personalization and proof rather than plan around unrealistically cheap media.
# 7. Acquisition and Funnel Instrumentation
<TABLE>
| Stage | Required metric | Why |
| Ad impression | CPM, creative ID, audience/campaign | Separates media cost from landing conversion. |
| Click / landing view | CTR, CPC, LPV | Quantifies traffic quality and loss before load. |
| Upload start | LP -> upload start % | First signal that promise matches need. |
| Valid SKU | Upload completion / parsability | Identifies technical/product-page friction. |
| Concepts ready | Product analysis success | Activation before payment. |
| Storyboard selected | Concept -> storyboard % | Measures whether strategy resonates. |
| Taste checkout | $19 checkout start / completion | First revenue conversion. |
| Taste delivered | QA pass and delivery success | Operational reliability. |
| Watch/export | Realized value | Better signal than payment alone. |
| Ad account connected | Meta/TikTok connection rate | Unlocks compounding intelligence. |
| Subscription | Taste -> plan conversion, plan mix | Recurring monetization. |
| Month 2+ | Retention, experiment count, performance-linked tests | Measures whether product became workflow. |
</TABLE>
## Offer Engine rules
Offer personalization should be deterministic and experimentable. The engine may vary Taste price tests, bonus hook, urgency duration, paywall moment and subscription-upgrade timing through explicit experiment assignments. It may not invent arbitrary personalized prices from an LLM. Every offer has an offer_id, eligibility rule, assigned variant, starts_at, expires_at, price, bonus entitlements and next-eligible-offer policy. Expired offers remain expired.
PART III
Complete customer experience and retention
This section is normative unless explicitly marked as a hypothesis, experiment, benchmark or future-state item.
# 8. End-to-End Customer Journey
[IMAGE]
Figure 2. Acquisition to recurring creative intelligence. The paid output is the bridge into a compounding SKU workflow.
## First visit and free preview
The landing page should be phone-first and visually demonstrate input-to-output immediately. The primary action is "Upload my product" or "Paste product link." The product should avoid model names, prompt fields and technical configuration. A visitor can start with a SKU before creating a full account; an account is required before expensive/persistent storyboard generation so the work can be resumed and abuse can be rate-limited.
The system analyzes the product and returns a concise Product Brain confirmation: product identity, price, category, visible key attributes, likely claims found, missing evidence, asset-quality confidence and whether additional product views would improve fidelity. It then creates three genuinely distinct concepts. The user can choose a goal such as sell the product, UGC-style review, explain the product or premium creative, but the system should default to performance-oriented recommendations rather than forcing an extensive brief.
## The $19 Taste moment
After the user selects a concept, the platform creates a low-cost visual/storyboard preview. The checkout page is personalized to the SKU and chosen concept. It shows exactly what will be produced, the regular $29 single-ad reference price, the $19 first-production price, the true expiry timestamp and any low-COGS bonus such as an alternate opening hook. The user must understand there is no required subscription.
After payment the customer sees semantic progress: preparing product, creating scenes, checking product accuracy, checking claims, adding voice/captions and preparing platform versions. The interface should not expose provider job IDs or token counts. If the browser closes, the job continues server-side and reload resumes the same job rather than creating a duplicate.
## Delivery and post-purchase conversion
When the Taste output completes, the platform should let the user watch the finished asset before presenting any subscription pitch. The emotional payoff matters. The page then explains that two additional strategic directions remain untested and that the recurring plans turn the SKU into a continuous experiment system. The upsell should be framed as continued creative testing, not more credits. The system can show the next recommended hypothesis immediately so the subscription has a concrete purpose.
# 9. First 30 Days of a SKU
<TABLE>
| Timing | Customer experience | System work / retention purpose |
| Day 0 | Add SKU; confirm product facts and claims. | Build Product Brain, Visual Fingerprint, Brand context and initial Claims Vault. Fast time-to-value. |
| Day 0-1 | Connect Shopify + read-only Meta/TikTok. | Import product truth, historical creatives and performance. Create early switching value. |
| Day 1 | See Creative Map and gaps. | Genome historical ads; distinguish repeated executions from distinct hypotheses. |
| Day 1-2 | Receive three recommended experiments. | Rank Exploit / Expand / Explore candidates with deterministic Opportunity Score. |
| Day 2-3 | Approve storyboard / variants. | Create controlled or intentionally exploratory test; estimate COGS before spend. |
| Day 3-4 | Receive QA-verified assets / Creator Pack. | Production, repair, composition, platform adaptation and lineage tracking. |
| Days 5-7 | See "Gathering signal" rather than fake winners. | Ingest performance; preserve measurement context; apply sample-size shrinkage. |
| Week 2 | Review what changed and next tests. | Create recommendation from new signal plus remaining coverage gaps. |
| Week 3 | Controlled iterations and fatigue replacement. | Use accumulated Creative Genome and learning graph; avoid repetitive cloning. |
| Day 30 | SKU Creative Review and Month 2 plan. | Summarize tested hypotheses, evidence, contradictions, untested space and recommended portfolio. |
</TABLE>
# 10. Retention and Low-Churn Architecture
Retention is a product requirement, not a lifecycle-email project. The product must become more valuable after each experiment because it remembers the SKU, claims, customer language, tested hypotheses, asset library and evidence. A customer should be able to reproduce raw video elsewhere but should find it intellectually expensive to recreate months of SKU-specific creative memory and disciplined experiment history.
<TABLE>
| Retention mechanism | Product implementation |
| Fast first value | Product analysis and useful concepts before the first paid render. |
| Weekly ritual | "This Week" recommends a small number of specific experiments rather than a blank creation canvas. |
| Compounding memory | Creative Map and Product Brain visibly accumulate tests, learnings, claims and customer themes. |
| Performance connection | Read-only Meta/TikTok makes recommendations SKU-specific instead of generic. |
| Controlled learning | The user learns why a test exists and what a result changes; product becomes an operating process. |
| Asset reuse | Existing UGC/product footage is reused intelligently, reducing cost and giving the platform a practical archive. |
| Creator workflow | Creator Packs keep the platform useful even when the best production choice is a human creator. |
| Churn prevention | Detect underuse, poor output acceptance, disconnected integrations or missing performance and intervene with value, not friction. |
| Transparent cancellation | Easy cancellation/export preserves trust. Offer pause/downgrade only as honest alternatives. |
| Return value | If policy/consent allows, preserve archived SKU intelligence for a clearly disclosed retention period so returning customers resume rather than restart. |
</TABLE>
## Leading churn indicators
The system should flag churn risk before billing failure: no SKU activity for seven days, paid customer with no export, repeated QA rejection, three recommendation cycles ignored, ad account disconnected, product out of stock, falling experiment acceptance rate, utilization under 25% for two cycles, utilization over 95% with repeated entitlement friction, no performance-linked test in 30 days, or support sentiment indicating output distrust. These triggers should route to product interventions and lifecycle messaging, not automatic discounting.
## Internal retention targets
These are operating targets, not claimed industry standards: first paid output export >80%; paid customer connects at least one performance source within 14 days >60%; Growth customer completes >=3 Creative Tests in first 30 days; Month-2 Core-ICP logo retention >70% at launch and improving; mature Core-ICP monthly logo churn target <5%; first-render acceptance after automatic QA/repair >70%; repeated product-fidelity failure <3% of paid projects. If retention misses, adding more generation features is not the default response; diagnose whether recommendations, trust, output quality or integration value are failing.
# 11. Weekly Operating Ritual
The ideal customer should not need to spend hours in the tool. Monday: review three recommended tests and approve one to three. Midweek: receive signal updates only when thresholds change, not noisy daily commentary. Friday: receive a concise learning summary, what remains uncertain, what is fatiguing and what the next recommendation will likely be. At month-end: receive a SKU Creative Review. The software should reduce operational coordination, not replace it with an AI chat that requires constant prompting.
PART IV
Product surfaces and UX rules
This section is normative unless explicitly marked as a hypothesis, experiment, benchmark or future-state item.
# 12. Information Architecture
<TABLE>
| Primary surface | Purpose |
| This Week | Recommended experiments, priority actions, active jobs and significant performance state changes. |
| Creative Map | What has been tested, under-tested, promising, fatigued or inconclusive. |
| Studio | Concept, storyboard, scenes, versions, production plan and controlled revisions. |
| Product Brain | Product truth, assets, customer themes, offer context and integration status. |
| Claims Vault | Claims, evidence, qualifiers, restrictions and review needs. |
| Results | Experiments, performance observations, learnings and confidence. |
</TABLE>
Creator Packs belong inside an Experiment rather than becoming a top-level application. Brand settings, billing, integrations and team settings sit at workspace level. The application should not expose a separate menu for every backend service.
# 13. Screen-by-Screen UX Requirements
## Landing and upload
• Hero communicates the output and vertical in one sentence; no generic AI jargon.
• Primary CTA accepts product photo or URL immediately. The page can be specialized by paid campaign and product archetype.
• Examples shown must be skincare. Never show unrelated fashion/app/real-estate templates to this ICP.
• If product URL parsing fails, preserve the entered URL and request images/details without forcing restart.
• Mobile upload, camera roll and Shopify connection must be first-class; desktop drag/drop is secondary.
## Product confirmation
• Show what was observed versus what needs confirmation. Never present AI-inferred claims as facts.
• Ask only for additional photos that materially improve fidelity: front, side, back, swatch/texture, closure or packaging where necessary.
• Highlight claim risks early but use plain language. Compliance detail is available on demand.
• Allow merchant corrections to become DECIDED data with provenance rather than silently editing raw observations.
## Concept selection
• Exactly three default concepts, meaningfully different in hypothesis rather than superficial copy.
• Each concept shows hook, customer tension, creative angle, production style, expected learning and estimated entitlement.
• One-click "Why this?" explains the evidence/gap behind the recommendation.
• Concepts should include at least one lower-risk adjacent test and, when appropriate, one exploratory direction.
## Storyboard / Studio
• Scenes are independently versioned and lockable. Regenerating one scene MUST NOT destroy approved scenes.
• User edits can be natural language, but the system converts them into structured changes and shows billable implications before render.
• Changing text, CTA, caption or price overlay should be free/near-free when no new generation is required.
• Changing person, location or physical product interaction may require new generation and should show expected entitlement before execution.
• The storyboard is the approval boundary before expensive production; render-first experimentation should be the exception.
## Results
• Never label a winner from trivial samples. Use Gathering Signal, Directional and Actionable states.
• Show platform/measurement context beside conclusions when it matters; do not merge incompatible attribution systems.
• Explain what changed between test variants and what the result does to future recommendations.
• Allow the merchant to mark an operational confounder such as stockout, site outage, influencer event or price change.
# 14. Trust and Interaction Rules
The product should communicate confidence and uncertainty explicitly. It may say "texture-first openings are directionally stronger on Meta for this SKU"; it should not say "texture increases conversions 31%" unless an analysis actually supports that causal claim. The interface must distinguish product truth, customer language, platform observations and system interpretation.
The system should push back when appropriate. If a user asks for five random new ads while one experiment is still generating meaningful signal, Creative Director can recommend controlled iterations instead. If the user insists, the product can proceed within compliance/cost rules, but the default should be strategic guidance rather than obedient content volume.
PART V
Proprietary intelligence core
This section is normative unless explicitly marked as a hypothesis, experiment, benchmark or future-state item.
# 15. Canonical Data Doctrine
<TABLE>
| Three states everywhere / OBSERVED = came from a source. INFERRED = system interpretation. DECIDED = approved merchant/system decision. A value must not silently move from INFERRED to OBSERVED or VERIFIED. |
</TABLE>
The database must favor atomic, versioned records with provenance rather than giant unsourced JSON context blobs. The system should be able to answer why a specific sentence, price, claim or recommendation existed at the moment a creative was produced. Derived intelligence can be rebuilt when algorithms improve; raw observations and decision history must remain auditable.
# 16. Product Brain
## ProductFact schema
<TABLE>
| ProductFact
  id, workspace_id, brand_id, sku_id
  fact_type, normalized_key
  value_text | value_number | value_json
  source_type, source_id, source_url
  observed_at, confidence
  merchant_confirmed
  valid_from, valid_to
  supersedes_fact_id
  state = OBSERVED | INFERRED | DECIDED
  status = ACTIVE | SUPERSEDED | DISPUTED |
</TABLE>
Examples include product name, size, price, compare-at price, category, variant, INCI ingredient, usage directions, subscription availability and bundle eligibility. Shopify exposes product title/description, media, variants and merchandising data through the current GraphQL Admin Product model [R8], so canonical product facts should prefer structured commerce data over LLM extraction where available.
## Visual Fingerprint
The Visual Fingerprint stores reference assets and machine-readable constraints: approved front/side/back views, label crops, OCR product/brand text, package type and geometry, cap/dropper/pump structure, dominant colors, liquid color, transparency, critical regions and similarity thresholds. It should be versioned because packaging changes. Product fidelity is not a single average score: wrong logo/text, wrong package count, materially wrong shade or a different closure are hard failures regardless of the overall visual score.
## Brand Brain
Brand Brain sits above the SKU and stores logo, colors, font rules, tone, visual references, prohibited aesthetics, approved spokespeople/talent types, mandatory disclosures, CTA vocabulary and any brand-wide claims or restrictions. SKU-level truth always wins when product-specific facts conflict with generic brand guidance.
# 17. Claims Vault
<TABLE>
| Claim
  id, sku_id
  canonical_meaning, preferred_wording
  claim_category, risk_level
  status
  allowed_markets[], allowed_platforms[]
  mandatory_qualifier
  merchant_approved, reviewed_at

ClaimEvidence
  claim_id, evidence_type
  source_document, source_location
  supplied_by, applicability
  evidence_strength, expiry_date |
</TABLE>
<TABLE>
| Status | System behavior |
| VERIFIED | May be used automatically within allowed market/platform scope. |
| VERIFIED_WITH_QUALIFIER | May be used only with exact approved qualification. |
| MERCHANT_REVIEW_REQUIRED | May appear in concept discussion but cannot reach final render without approval. |
| RESTRICTED | Requires specialist/manual compliance path. |
| BLOCKED | Never used in output. |
| INFERRED_ONLY | May guide idea generation but cannot appear as factual advertising claim. |
</TABLE>
FDA states cosmetic claims must be truthful and not misleading, and claims that a product treats/prevents disease or affects the structure/function of the body can cause it to be regulated as a drug [R12]. FTC requires adequate substantiation for objective express and implied health-related claims and warns that testimonials do not substitute for scientific substantiation [R13]. These rules make provenance and implied-claim detection product requirements rather than optional moderation.
# 18. Customer Language Engine
Raw customer signals are imported with original text/source/time and never rewritten in-place. Sources can include product reviews, product Q&A, approved TikTok/Meta comments, support exports or surveys. The clustering layer creates CustomerTheme objects such as sticky texture, pilling under makeup, routine complexity, value concern or sensitivity concern. Each theme stores signal type, recency-weighted prevalence, sentiment/intensity, sample size, trend direction, SKU relevance and representative source snippets.
Customer language can inspire hooks and identify objections. It cannot prove product efficacy. The context builder should expose representative phrases to Opus so copy is grounded in real language while enforcing Claims Vault at generation time.
# 19. Creative Genome
Every historical or newly created ad must receive a versioned structured genome. Free-form tags are useful for search but cannot be the canonical taxonomy because they drift. The schema should encode strategic genes, hook genes, body/proof genes, production genes, compliance genes and lineage. The initial taxonomy is intentionally skincare-specific and can be versioned over time.
<TABLE>
| Genome family | Examples |
| Strategy | Primary/secondary angle, customer problem, desired outcome, objection, benefit, ingredient proposition, offer, funnel intent, emotional frame. |
| Hook | Exact spoken/overlay text, mechanism, first-frame subject, product reveal time, face reveal time, first motion. |
| Body / proof | Texture demo, application, routine, ingredient education, comparison, testimonial, social proof, objection resolution, CTA. |
| Production | Duration, scenes, cut rate, human/product screen ratio, synthetic ratio, captions, voice, music, polish style. |
| Compliance | Claim IDs, qualifier/disclosure needs, implied-claim flags, before/after, creator connection. |
| Lineage | Source assets, parent creative, experiment, variant role, changed variables, prompt/model/production version. |
</TABLE>
# 20. Experiment Engine
<TABLE>
| Experiment
  sku_id
  hypothesis
  rationale
  primary_variable
  controlled_variables[]
  control_variant_id
  primary_metric
  leading_metrics[]
  expected_learning
  mode = CONTROLLED | EXPLORATORY
  status

Variant
  experiment_id
  creative_id
  changed_variables[]
  held_constant[]
  platform_assets[] |
</TABLE>
A CONTROLLED experiment changes a limited set of variables and keeps enough of the body/offer/context stable to produce interpretable learning. An EXPLORATORY experiment may change many dimensions to search new territory; it can still produce a winner, but the system must not pretend it identified which variable caused the result. This distinction should be visible in the internal data and available in user explanations.
## Opportunity Score
<TABLE>
| Driver | Weight | Intent |
| Customer relevance | 22% | Frequency/recency/intensity of the customer tension. |
| Adjacent historical signal | 18% | Evidence from related genes after shrinkage, not raw winner cloning. |
| Creative coverage gap | 16% | Reward genuinely under-tested territory. |
| Fatigue / replacement need | 12% | Increase priority when current family carries spend and deteriorates. |
| Learnability | 12% | Reward tests capable of isolating useful information. |
| Production feasibility | 8% | Asset availability and fidelity probability. |
| Platform fit | 7% | Native fit for intended distribution environment. |
| COGS efficiency | 5% | Prefer asset reuse when quality is equivalent; never optimize into low-quality content. |
</TABLE>
Hard gates happen before scoring: blocked claims, missing evidence, infeasible product fidelity, near-duplicate recent tests, cost violations, missing rights/assets or platform disallowance prevent automatic production. The score cannot override a gate.
## Portfolio rule
<TABLE>
| SKU maturity | Exploit | Expand | Explore |
| Cold / low history | 20% | 40% | 40% |
| Developing | 40% | 35% | 25% |
| Mature | 50% | 30% | 20% |
</TABLE>
This rule prevents local optimization where the system clones yesterday's winner until the audience is saturated. TikTok's GMV Max guidance likewise emphasizes continuous creative exploration and more anchored/affiliate videos, rather than relying on a single creative [R4].
# 21. Statistics and Learning Graph
Performance confidence must be calculated by deterministic statistics rather than LLM intuition. For rate metrics such as CTR, hold rate and CVR, use Bayesian shrinkage toward the recent SKU/account/platform baseline so tiny samples do not produce false winners. CPA/ROAS comparisons must preserve conversion uncertainty and purchase-value variability. Thresholds should scale with account volume.
<TABLE>
| State | Meaning | User-facing behavior |
| GATHERING_SIGNAL | Exposure/results below useful evidence floor. | Do not recommend major strategy change. Explain that more data is needed. |
| DIRECTIONAL | Interesting evidence but insufficient for a strong conclusion. | May influence exploration and monitoring, but avoid definitive language. |
| ACTIONABLE | Sufficient evidence and commercial effect to influence future allocation. | Use in recommendation ranking; still preserve platform/scope. |
| WEAKENING | Previously useful learning is losing support. | Reduce weight and schedule validation. |
| INVALIDATED | New evidence contradicts prior learning strongly enough. | Do not use as current prior; preserve history for audit. |
</TABLE>
TikTok notes that learning-phase volatility typically starts to decline after roughly 25 results or seven days [R11]. This is not a universal experiment threshold, but it reinforces the product rule that early fluctuations should not be over-interpreted.
## Learning object
<TABLE>
| Learning
  sku_id
  statement
  scope_platform, scope_market
  relevant_genes[]
  supporting_experiments[]
  contradicting_experiments[]
  confidence
  state
  valid_from, last_revalidated_at
  do_not_generalize_to[] |
</TABLE>
Every learning must state its scope. A Meta result for one serum is not automatically a TikTok result for the whole brand. Learnings must be able to weaken or invalidate when context, offer or market changes.
# 22. Creative Director and Model Boundaries
Opus 5.5 should serve as the senior Creative Director for high-value reasoning because its current token cost is small relative to video generation [R17]. It receives a curated Context Packet, not raw database access. The packet includes product truth, approved/blocked claims, top customer themes, creative coverage, recent experiments, learnings with confidence, current winners/fatigue, available assets, platform, business objective and production budget class.
<TABLE>
| CreativeDirectorProposal
  hypothesis
  customer_tension_id
  why_now
  primary_variable
  control_creative_id
  angle
  hook_options[]
  body_strategy
  claim_ids[]
  asset_ids[]
  production_mode
  expected_learning
  if_test_fails
  estimated_generation_class |
</TABLE>
Opus proposes. Deterministic services validate. The merchant approves. Cost Governor spends. Opus MUST NOT change claim status, calculate official attribution, decide statistical sufficiency, debit credits, bypass policy, mutate raw product truth or authorize model spend. Smaller/cheaper models may later handle well-tested extraction/classification tasks behind the Model Gateway, but accuracy must be evaluated against a curated benchmark before routing is changed.
PART VI
Production, QA and creator workflows
This section is normative unless explicitly marked as a hypothesis, experiment, benchmark or future-state item.
# 23. Production Engine
Production Planner chooses the medium scene by scene. It can reuse creator UGC, founder footage, product photos, original product cutouts, Seedream imagery, Seedance video, motion graphics, typography and voice. The goal is not maximum AI generation; it is the best credible ad at the lowest total cost that preserves product truth and produces a meaningful experiment.
<TABLE>
| Mode | Preferred use | Risk / control |
| Strict product composite | Hero, label, packaging, CTA and text-heavy product shots. | Highest fidelity; generate environment/hands separately where possible. |
| Generative interaction | Application, holding, opening, pouring and human/product physical interaction. | Higher product mutation risk; stronger QA and short scenes. |
| Hybrid - default | Generated interaction + exact-product hero/composite + real assets. | Best balance of realism, fidelity and COGS. |
| Real-asset remix | Existing UGC/product video with new hook, captions, pacing or voice. | Often cheapest and most native; rights/provenance required. |
| Creator Pack | Hypothesis delivered as a structured brief for a human creator. | No generated acting required; claims and shot rules remain enforced. |
</TABLE>
# 24. Storyboard and Scene Model
A project timeline is a composition of independently versioned scenes. Each scene stores purpose, duration, visual plan, product behavior, spoken line, overlay text, claims used, source assets, production mode, model/prompt version, cost estimate, render versions and approval state. Locking a scene prevents unrelated edits from regenerating it. Composition is reproducible from scene versions, not a one-off opaque render.
One-minute outputs should usually be Smart Explainers with perhaps 20-30 seconds of truly generated motion plus exact product assets, Seedream visuals, typography, motion graphics, narration and CTAs. Seedance 2.5 currently supports up to 30-second single generations and up to 50 multimodal references [R14/R15], so fully generative 60-second films must be stitched and have materially higher continuity/retry risk.
# 25. Quality Assurance
## QA pipeline
1. Product fidelity: logo, exact label text, package geometry, cap/dropper/pump, material color, liquid/shade, product count and critical regions.
2. Visual quality: hands, faces, object interactions, impossible physics, flicker, background artifacts and shot continuity.
3. Claims: every material product statement maps to an allowed Claim ID; implied claim scan runs on text, voice and visual context.
4. Audio/transcript: voice and captions match; no accidental claim mutation; music/license source is known.
5. Platform: duration, aspect ratio, safe-zone placement, resolution, caption readability and export codec.
6. Experiment integrity: variant actually changes the intended variable and preserves held-constant components where promised.
7. Final asset integrity: files exist in owned object storage, checksums match, metadata/lineage is complete and URLs do not depend on temporary provider links.
Meta reports that Reels ads built as 9:16 video with audio and key creative elements in the safe zone achieved 34.5% lower cost per result than image ads in its cited split-test meta-analysis [R5]. The product should therefore treat platform-native framing, audio and safe-zone QA as default production requirements rather than optional polish.
## Retry policy
<TABLE>
| Failure type | Customer charge | System response |
| Provider/API failure | No charge | Release reservation; retry only per provider-safe policy. |
| QA failure - first attempt | No extra charge | One automatic repair/retry covered by reserve. |
| QA failure again | No extra charge for failed scene | Stop expensive loop; switch technique, composite real product or redesign shot. |
| Customer changes taste/style after acceptable output | Billable if new generation needed | Show cost before action. |
| Text/CTA/price/caption-only edit | Usually no render charge | Recompose without expensive model call. |
| Cancellation before dispatch | No charge | Release reserved entitlement. |
| Browser close / reload | No duplicate charge | Server-side job continues; idempotent resume. |
</TABLE>
# 26. Creator Packs
Because beauty commerce on TikTok is heavily affiliate/creator-driven in current third-party estimates [R1], the product must not assume synthetic actors replace creators. Every strong hypothesis should optionally produce a Creator Pack containing goal, customer tension, 3 hook options, exact first-shot guidance, product-visible timing, required demonstration shots, approved claims, forbidden claims, CTA, framing/safe-zone notes and optional example voiceover. The same experiment ID links creator-produced footage back into Creative Genome when the merchant later uploads or authorizes the asset.
Creator discovery, outreach, sample management and commission negotiation remain outside V1. The software should make creators easier to brief and their output easier to interpret, not become a marketplace.
PART VII
Platform integrations and data contracts
This section is normative unless explicitly marked as a hypothesis, experiment, benchmark or future-state item.
# 27. Integration Principles
Integrations exist to provide product truth, creative history and performance context. V1 should request the minimum permissions required and prefer read-only access. Write operations that affect budgets, bids, campaigns or commercial commitments are explicitly out of scope. Every connector has connection status, granted scopes, last successful sync, last complete date, cursor/checkpoint, timezone, currency and error state.
# 28. Shopify
Shopify is the preferred canonical commerce source when available. The current GraphQL Admin Product model exposes title, descriptions, media, variants, options and related merchandising structures under read_products access [R8]. Product import should capture Shopify product/variant IDs and preserve the raw payload snapshot/hash so future changes can be reconciled rather than blindly overwritten.
• Import product and variant identity, price/compare-at price, media, SKU/barcode, product status and available relevant metafields.
• Do not assume reviews are universally present in the core product object; integrate review providers or page content separately.
• Re-sync on webhook/event where supported plus scheduled reconciliation.
• When merchant corrects a Shopify-derived fact locally, mark the conflict rather than silently breaking source truth.
# 29. Meta
Meta connection is read-only for V1 performance learning. Meta's Marketing API Insights supports ad-level fields including spend, impressions, clicks, reach, frequency, conversions/value and video milestones such as 25/50/75/95/100% watched and average watch time, with attribution-window controls [R9]. The normalized observation table should store raw counts and the attribution context; derived CTR, CVR, CPA and ROAS are calculated by our system.
# 30. TikTok and TikTok Shop
TikTok's API for Business exposes campaign/reporting APIs plus Creative Fatigue Detection, Creative Reports, Video Insights and Creative Insights [R10]. Product GMV Max uses available merchant, organic and authorized affiliate creatives and optimizes both paid and organic traffic [R4]. Accordingly, the system must preserve `measurement_context` and avoid comparing GMV Max total-channel results as though they are equivalent to a conventional paid-only Meta attribution report.
TikTok now also exposes an official TikTok for Business MCP Server and Agentic Hub for campaign management, performance reporting, audience configuration and creative operations [R26]. This is strategically useful for future agentic media operations, but V1 canonical ingestion should remain direct and deterministic; MCP can later become an action interface rather than the source of truth.
## Normalized performance context
<TABLE>
| PerformanceObservation
  platform, account_id, campaign_id, adgroup_id, ad_id
  creative_id, variant_id, date, currency
  spend, impressions, reach, frequency, clicks, outbound_clicks
  video_starts, video_25, video_50, video_75, video_100, avg_watch_time
  add_to_cart, checkout, purchases, purchase_value
  attribution_model, attribution_window, optimization_event
  campaign_type, measurement_context

measurement_context examples
  META_PAID_ATTRIBUTED
  TIKTOK_PAID_ATTRIBUTED
  TIKTOK_GMV_MAX_TOTAL
  SHOPIFY_BLENDED_ORDER
  MERCHANT_IMPORTED |
</TABLE>
# 31. Data Freshness and Reconciliation
A recommendation must know whether its inputs are stale. Product facts, price/offers, claims and performance each have a freshness policy. If ad-account sync has been broken for seven days, the UI should not quietly continue producing "performance-informed" recommendations. It should downgrade the recommendation basis and say that results are incomplete. Late-arriving platform data must be able to update historical observations without mutating the creative lineage itself.
PART VIII
Software architecture and engineering standard
This section is normative unless explicitly marked as a hypothesis, experiment, benchmark or future-state item.
# 32. High-Level Architecture
[IMAGE]
Figure 3. Recommended V1 architecture. The LLM is one component inside a controlled, auditable system.
# 33. Service / Module Boundaries
<TABLE>
| Module | Responsibility |
| ProductTruthService | Versioned facts, source precedence, conflicts and product-change events. |
| ClaimsService | Claims, evidence, qualifiers, market/platform eligibility, implied-claim flags. |
| CustomerSignalService | Raw signal ingestion, clustering inputs and theme provenance. |
| CreativeGenomeService | Versioned taxonomy extraction for historical/new assets. |
| PerformanceIngestionService | Normalized raw performance observations and connector checkpoints. |
| StatisticsService | Shrinkage, evidence floors, confidence states and learning updates. |
| ExperimentService | Hypothesis, control/variant lineage, experiment status and integrity. |
| RecommendationService | Opportunity Score, gates, portfolio composition and deduplication. |
| ContextBuilder | Curated bounded packet for the Creative Director. |
| CreativeDirector | Opus-driven hypothesis/creative reasoning; structured output only. |
| ProductionPlanner | Selects production medium per scene and prepares render plan. |
| CostGovernor | Rates, entitlement, markup floor, reservations and authorization to spend. |
| ModelGateway | Provider-agnostic image/video/voice/vision adapters and fallback policy. |
| QAGateway | Fidelity, claims, visual, audio, platform and experiment-integrity checks. |
| Composer | FFmpeg/media composition, captions, overlays, aspect ratios and export. |
| UsageLedger | Immutable reservations, consumption, release, refund and realized provider cost. |
</TABLE>
# 34. Technology Baseline
<TABLE>
| Layer | Recommended baseline | Guideline |
| Web | Next.js / React / TypeScript | Responsive mobile-first product; server-rendered where useful. |
| Application API | TypeScript service layer | Typed contracts, explicit authorization, no business logic hidden in UI. |
| Database | Postgres | Tenant-aware canonical state and append-only events/ledger. |
| Object storage | S3-compatible (DigitalOcean Spaces) | Own copies of source/generated/final assets; signed URLs. |
| Queue | pg-boss job queue on Postgres + worker processes | All AI/media/platform jobs asynchronous and resumable; jobs enqueued in the same transaction as the state change that creates them. |
| Media | FFmpeg workers | Deterministic composition/transcode separate from generative models. |
| AI | Provider-agnostic Model Gateway | Opus 5.5 initially for Creative Director; BytePlus image/video adapters; easy replacement. |
| Observability | Structured logs + traces + metrics | Every job joins workspace/SKU/experiment/generation IDs. |
| Auth/secrets | In-house auth (email + password with Argon2id, email verification, server-side sessions in Postgres) + DigitalOcean encrypted secrets | Login rate-limited; session cookies HttpOnly/Secure/SameSite; OAuth tokens encrypted; least privilege; no credentials in source code. |
| Payments | Stripe (Checkout for Taste, Billing for subscriptions) | Card data stays with Stripe; webhooks signature-verified and deduplicated; entitlements granted only from confirmed webhook events. |
| Hosting | DigitalOcean: App Platform (web, API, workers), Managed Postgres, Spaces object storage + CDN | Containerized services; staging and production environments; automated database backups tested before paid launch. |
</TABLE>
# 35. Canonical State Machines
## Creative project state
<TABLE>
| PRODUCT_UPLOADED
 -> PRODUCT_ANALYZED
 -> BRIEF_READY
 -> CONCEPTS_READY
 -> CONCEPT_SELECTED
 -> STORYBOARD_READY
 -> STORYBOARD_APPROVED
 -> RENDER_RESERVED
 -> RENDERING
 -> QA_RUNNING
 -> COMPOSING
 -> PLATFORM_VARIANTS
 -> FINAL_QA
 -> COMPLETE

alternate terminal/intermediate states:
  NEEDS_USER_ACTION
  BLOCKED_COMPLIANCE
  PROVIDER_FAILED
  REFUNDED
  CANCELLED |
</TABLE>
## Experiment state
<TABLE>
| DRAFT -> RECOMMENDED -> APPROVED -> PRODUCING -> READY_TO_RUN
 -> GATHERING_SIGNAL -> DIRECTIONAL -> ACTIONABLE
 -> ARCHIVED

may also become:
  INCONCLUSIVE
  INVALIDATED
  OPERATIONALLY_CONFOUNDED |
</TABLE>
Every transition must be idempotent and evented. A duplicate provider callback cannot double-settle credits; a page refresh cannot create a second generation; a partially completed export can resume from durable state.
# 36. Event Architecture
Important mutations emit durable events that can rebuild downstream intelligence. Minimum events include PRODUCT_IMPORTED, PRODUCT_FACT_CHANGED, CLAIM_APPROVED, CLAIM_BLOCKED, CUSTOMER_THEME_UPDATED, CREATIVE_IMPORTED, GENOME_EXTRACTED, EXPERIMENT_CREATED, EXPERIMENT_APPROVED, VARIANT_GENERATED, PERFORMANCE_INGESTED, CONFIDENCE_CHANGED, LEARNING_CREATED, LEARNING_INVALIDATED, RECOMMENDATION_CREATED, RECOMMENDATION_ACCEPTED, QA_FAILED, QA_PASSED, CREDIT_RESERVED, CREDIT_CONSUMED, CREDIT_RELEASED, CREDIT_REFUNDED and PROVIDER_COST_RECORDED. Events carry actor, timestamp, tenant, object IDs and schema version.
# 37. Cost Governor and Usage Ledger
No creative or agent may directly call a billable generation provider. Production Planner requests an estimate; Cost Governor reads current provider rates, computes expected input/output/duration/resolution, applies retry reserve, checks entitlement and markup floor, writes a CREDIT_RESERVED/amount reservation and returns an authorization token. Model Gateway accepts only valid authorizations. On completion, actual provider cost is recorded and the reservation is settled as CREDIT_CONSUMED, CREDIT_RELEASED or CREDIT_REFUNDED. CREDIT_* events track customer entitlement; PROVIDER_COST_RECORDED tracks our realized provider cost. There are no separate COST_* events.
<TABLE>
| UsageLedger events
  CREDIT_RESERVED
  PROVIDER_JOB_CREATED
  PROVIDER_JOB_SUCCEEDED
  PROVIDER_JOB_FAILED
  QA_FAILED
  FREE_QA_RETRY
  CREDIT_CONSUMED
  CREDIT_RELEASED
  CREDIT_REFUNDED
  PROVIDER_COST_RECORDED |
</TABLE>
The customer-facing balance can be derived from the ledger. Do not store only `user.credits = 12` as the source of truth. Every billing dispute must be reconstructable.
# 38. API Contract Principles
<TABLE>
| Endpoint family | Examples | Rules |
| Products | POST /products/import-url, GET /products/:id, PATCH /products/:id/decisions | Return observed/inferred/decided separately; never hide provenance. |
| Claims | GET /products/:id/claims, POST /claims/:id/approve | Approval requires explicit actor and scope. |
| Recommendations | GET /products/:id/recommendations | Response includes rationale IDs and confidence, not raw chain-of-thought. |
| Experiments | POST /experiments, POST /experiments/:id/approve | Server validates controlled-variable schema and gates. |
| Production | POST /experiments/:id/render-estimate, POST /.../render | Render endpoint requires cost authorization and idempotency key. |
| Jobs | GET /jobs/:id, POST /jobs/:id/cancel | Safe retry/resume; cancel semantics depend on dispatch state. |
| Results | GET /experiments/:id/performance | Includes measurement_context and freshness. |
| Webhooks | /webhooks/shopify, /webhooks/meta, /webhooks/tiktok, provider callbacks | Verify signature, deduplicate, persist raw receipt, async process. |
</TABLE>
# 39. Reliability, Idempotency and Recovery
• Every externally triggered create action receives an idempotency key scoped to workspace + operation.
• Provider request IDs, callbacks and raw provider response metadata are persisted; duplicate callbacks are expected, not exceptional.
• Queue workers use leases/timeouts and dead-letter queues; retries are bounded and separated from creative QA retries.
• Generation reservations have expiry/reconciliation jobs so crashed workers cannot strand entitlement indefinitely.
• Every output is copied to owned object storage immediately; provider temporary URLs are never treated as durable assets.
• Long-running jobs expose heartbeat/progress state; browser sessions are never the job authority.
• Database backups, object-storage versioning and recovery procedures must be tested before paid launch.
# 40. Security and Privacy
The platform handles commercially sensitive product assets, advertising results and OAuth access. Security is therefore part of the product proposition. OAuth tokens must be encrypted at rest, scopes kept minimal and revocation detected. Tenant isolation must be enforced server-side on every database/object access. Signed asset URLs should be short-lived. Secrets never belong in source code, prompts or client bundles. Payment card data should remain with the payment processor rather than enter our systems.
• Maintain a data inventory and retention policy for product assets, ad data, prompts/model outputs and audit logs.
• Allow customers to disconnect integrations, delete uploaded assets and request account/data deletion subject to legitimate financial/audit retention obligations.
• Never use one customer's raw creative, claims, reviews or performance to answer another customer without explicit legal/contractual authorization and aggregation policy.
• Uploaded creator/UGC assets require merchant attestation that they have rights to use/process them; preserve origin metadata where possible.
• AI-generated talent and synthetic media must follow platform disclosure requirements as they evolve; do not misrepresent a real person or customer endorsement.
• All administrative/support access to customer data should be logged and least-privilege.
# 41. Observability and Model Governance
Every inference/render/QA decision must be reproducible enough to debug. Store model/provider/version, prompt template version, input object IDs/hashes, output ID, latency, token/compute estimate, actual cost where available, moderation status, QA scores, repair reason and final acceptance. Prompt changes are software changes: version them, evaluate them on a regression suite and roll them out gradually rather than editing production prompts in an admin textbox without audit.
Model routing is allowed only after evaluation. Maintain a golden dataset of real or licensed representative skincare products, claims, packaging conditions, customer-language inputs and historical creative. A lower-cost model may replace Opus for a subtask only if it meets the required quality threshold on that task and does not increase downstream regeneration or compliance risk.
PART IX
Edge cases, failure modes and abuse resistance
This section is normative unless explicitly marked as a hypothesis, experiment, benchmark or future-state item.
# 42. Product and Ingestion Edge Cases
<TABLE>
| Edge case | Expected behavior |
| Product page blocked / JS-only / unavailable | Fall back to image/manual input; do not invent missing fields. |
| Multiple products on page/photo | Ask/select which SKU is being advertised; preserve other products as context only. |
| Bundle | Treat bundle as distinct sellable entity while linking component SKUs; claims must be applicable to the bundle. |
| Variants / sizes | Store variant-specific price/media where relevant; do not show wrong size/shade. |
| Packaging refresh | Create new Visual Fingerprint version; historical creatives remain tied to prior packaging. |
| Duplicate import | Detect source/product match and offer merge rather than creating competing Product Brains. |
| Out of stock | Flag before offer/production; recommendations can focus on waitlist/launch only if merchant intends. |
| Price changes during production | Update overlays/composition without re-generating footage when possible. |
| Conflicting source facts | Mark DISPUTED; show merchant the conflict; source precedence alone cannot hide a material discrepancy. |
| Missing ingredient list | Do not infer ingredient claims from category; request source if ingredient creative is desired. |
</TABLE>
# 43. Claims and Regulatory Edge Cases
<TABLE>
| Edge case | Expected behavior |
| Customer review says "cured acne" | Store as customer-language signal; block as efficacy claim unless legally valid drug pathway/evidence exists. |
| "Clinically tested ingredient" | Do not imply the finished product was clinically proven unless evidence supports product-specific claim [R13]. |
| Before/after images | Require provenance/permission and separate policy review; avoid generated deceptive outcome imagery. |
| "Dermatologist tested/recommended" | Evidence and exact wording required; merchant assertion alone can be marked pending, not verified. |
| Ingredient study not matching formulation/dose | Evidence applicability must be reviewed; do not automatically transfer ingredient evidence to product claim. |
| Market-specific wording | Claims carry allowed markets; US approval does not imply UK/EU approval. |
| Visual implies a medical result | Implied-claim scanner must evaluate whole creative, not text only. |
| Merchant insists on blocked claim | Do not render it; explain restriction and propose factual/appearance-oriented alternatives. |
</TABLE>
# 44. Generation and Fidelity Edge Cases
<TABLE>
| Edge case | Expected behavior |
| Label text mutates | Hard fail; repair once then composite exact product. |
| Wrong cap/dropper / bottle shape | Hard fail if identity-critical; switch production method after one repair. |
| Transparent packaging confuses model | Ask for additional reference views or use strict composite mode. |
| Hands/fingers deform | Visual QA failure; regenerate short interaction scene or replace with product-only shot. |
| Skin appearance changes unnaturally | Reject misleading/uncanny result; do not create synthetic before/after efficacy proof. |
| AI talent inconsistent across scenes | Use reference constraints or split into product-only/hybrid; continuity is not worth endless retries. |
| Model moderation false positive | Surface provider limitation internally; try policy-compliant alternative provider/shot if permitted, never bypass safety. |
| Provider returns lower quality than expected | QA rejects; customer receives no degraded output merely to avoid cost. |
| Model price doubles | Rate table updates; Cost Governor adjusts estimate/entitlement before new jobs; active customer promises handled by commercial policy. |
| Provider outage | Queue/pause, optional approved fallback provider, preserve reservation and clear status. |
</TABLE>
# 45. Performance and Experiment Edge Cases
<TABLE>
| Edge case | Expected behavior |
| Tiny spend but high ROAS | Shrink toward baseline; remain Gathering/Directional. |
| Same creative reused in multiple campaigns | Store placement/campaign observations separately, aggregate only under compatible context. |
| Attribution windows differ | Never compare without normalizing or clearly scoping; preserve raw window. |
| Offer changed mid-test | Mark confounder; learning may become OPERATIONALLY_CONFOUNDED. |
| Stockout/site outage | Merchant or automated signal marks affected date range; exclude/downweight from creative learning. |
| TikTok GMV Max includes organic/affiliate | Use TIKTOK_GMV_MAX_TOTAL context; do not compare directly to paid-only ROAS [R4]. |
| Creative winner fatigues | Learning can remain historically valid while FatigueNeed rises; recommend controlled refresh. |
| External viral event drives sales | Flag anomaly; avoid attributing lift solely to creative. |
| Platform reports late conversions | Allow backfill; confidence and learning may revise retrospectively with audit trail. |
</TABLE>
# 46. Billing and Entitlement Edge Cases
<TABLE>
| Edge case | Expected behavior |
| User double-clicks Generate | Idempotency returns the existing job; no second reservation. |
| User closes browser | Job continues; next session reconnects to job state. |
| Cancel before provider dispatch | Full release. |
| Cancel after dispatch | Commercial policy depends on provider cost; do not promise refund that creates guaranteed loss. |
| Provider fails but bills partially | Record actual provider cost internally; customer policy can still protect user; investigate provider reconciliation. |
| QA retry consumes reserve | Customer sees no extra charge. |
| Repeated customer preference changes | Show new entitlement before regeneration. |
| Credit balance appears wrong | Ledger reconciliation rebuilds derived balance; no manual magic-number edits. |
| Subscription downgrade with queued jobs | Honor already reserved authorized jobs; future entitlements follow new plan date. |
| Resource-package discount expires | Retail entitlement unchanged until commercial rules change; internal realized margin changes. |
</TABLE>
# 47. Integration and Permission Edge Cases
<TABLE>
| Edge case | Expected behavior |
| OAuth revoked | Mark connection degraded immediately; stop claiming fresh performance insight. |
| Partial scopes | Explain exactly which features are unavailable; do not repeatedly ask for unrelated permissions. |
| Wrong ad account selected | Allow account switch; keep observations scoped to source account. |
| Currency mismatch | Store native currency + normalized reporting currency; never sum raw values across currencies. |
| Timezone mismatch | Normalize timestamps but retain source timezone for daily reporting. |
| Rate limit | Backoff, checkpoint, resume; user should see data freshness rather than a generic error. |
| API schema change | Adapter versioning and contract tests fail safely; canonical schema remains stable. |
| Duplicate webhook | Deduplicate by platform event/request identifier or content hash. |
</TABLE>
# 48. Customer Lifecycle Edge Cases
<TABLE>
| Edge case | Expected behavior |
| No historical ads | Cold-start mode: prioritize customer language, category taxonomy and balanced Explore/Expand portfolio; never pretend performance learning exists. |
| No Meta/TikTok connection | Product remains usable, but recommendations are labelled context-limited; gently show value of connection. |
| Very low ad spend | Use lighter evidence floors and qualitative learning without overstating certainty. |
| Seasonal pause | Offer honest pause/downgrade where commercially sensible; preserve memory per disclosed data-retention policy. |
| Customer returns months later | Revalidate price, packaging, claims, product availability and integrations before using old memory. |
| Customer hates first render | Diagnose whether strategy, fidelity or execution failed; preserve storyboard and re-plan rather than wholesale regenerate blindly. |
| Under-utilizing plan | Recommend a small prioritized batch before month-end; do not spam generic "use your credits" messages. |
| Over-utilizing plan | Offer add-on/upgrade based on actual workflow value; never throttle an already-paid in-flight job. |
</TABLE>
## Adversarial, abuse and rights edge cases
<TABLE>
| Edge case | Expected behavior |
| Prompt injection in product page/review/comment | Treat all imported web/store/customer text as untrusted data, never instructions. Delimit it in model context; it cannot alter system policy, tool permissions, claim status or spend. |
| Malicious or malformed upload | Verify MIME/magic bytes, scan where appropriate, sandbox media parsing, cap dimensions/duration/file size and reject decompression/parser bombs without privileged processing. |
| Free-preview bot/farm abuse | Rate-limit by account/device/network signals, require account verification before persistent or expensive work, and keep free-preview COGS bounded without silently punishing legitimate multi-SKU evaluation. |
| Unauthorized creator/celebrity/customer asset | Require merchant rights attestation and preserve provenance. Do not clone or imply endorsement by a real person without valid authorization; suspicious assets route to review/block. |
| Creator usage rights expire or are revoked | Mark the asset unavailable for new production, preserve historical lineage/performance, warn on derivative reuse and offer replacement footage rather than silently continuing. |
| Cross-tenant object or API ID guessed | Authorize every read/write server-side against workspace ownership. Deny and log; never rely on obscurity of IDs or client-side filtering. |
| Customer text contains secrets/PII | Minimize raw ingestion, redact/limit unnecessary personal information in model contexts and logs, and keep retention scoped to the creative purpose. |
| Admin/support needs temporary access | Use explicit least-privilege elevation with reason, expiry and audit log; avoid shared superuser credentials. |
</TABLE>
## Skincare-specific human and representation edge cases
<TABLE>
| Edge case | Expected behavior |
| Skin tone changes between generated scenes | Treat material lightening/darkening or complexion drift as a visual-integrity failure when it could imply efficacy or misrepresent the person; repair or replace the scene. |
| AI silently improves blemishes/texture | Do not allow synthetic retouching to become implied before/after proof. Preserve intended skin appearance unless a clearly disclosed, policy-compliant non-efficacy treatment is intentional. |
| Synthetic talent appears under 18 | V1 synthetic direct-response talent should default to clearly adult presentation. Merchant-supplied footage involving minors requires rights and platform/policy review. |
| Pregnancy/postpartum/sensitive-condition wording | Treat as elevated claim/targeting context; do not infer medical suitability from ingredients or reviews. Require appropriate evidence/review for product statements. |
| Non-English or dense label text | Do not hallucinate label copy. Use exact-product compositing when fidelity confidence is insufficient; preserve Unicode text and original artwork. |
| Shade, swatch, serum or cream color materially altered | Hard or near-hard fidelity failure when color is product-identifying or purchase-relevant; prefer source-asset texture/swatch or calibrated composite. |
| Customer language reveals health or other sensitive personal data | Use only to understand aggregate creative themes where lawful; do not infer or build sensitive audience profiles from individual reviewers. |
</TABLE>
## Data contamination and experiment-integrity edge cases
<TABLE>
| Edge case | Expected behavior |
| One ad contains multiple SKUs | Record primary and secondary SKUs explicitly; claim applicability and performance learning must not be blindly assigned to every product shown. |
| Historical creative deleted from ad platform | Preserve locally stored metadata/media only within rights/retention policy, mark source as deleted/stale and keep lineage rather than fabricating missing observations. |
| Merchant edits a live creative outside the platform | Detect a new creative/hash/version on next sync where possible; fork lineage and treat it as a new variant rather than mutating the experiment retrospectively. |
| Audience, bid strategy or optimization event changes mid-test | Record the change as context/confounder; do not attribute the resulting performance shift solely to creative. |
| Landing page, checkout, price or promotion changes materially | Create an operational-confounder window. The affected period is downweighted/excluded from causal interpretation while historical learning remains auditable. |
| Organic or affiliate creative has no paid-spend context | Store separate organic/affiliate measurement context; virality or GMV is useful evidence but not directly interchangeable with paid-ad CPA/ROAS. |
| Same master creative adapted across Meta and TikTok | Share creative lineage but preserve platform observations and platform-specific genes; never average into one universal result by default. |
| Source data is backfilled or corrected | Write new observations/revisions with audit timestamps, recompute derived confidence, and allow Learnings to weaken or invalidate without rewriting history. |
</TABLE>
## Provider, queue and cost race conditions
<TABLE>
| Edge case | Expected behavior |
| Provider silently changes model/version | Capture returned model/version metadata; pin where possible and route changed versions through regression/canary policy before becoming default. |
| Provider returns wrong duration/resolution/format | Validate the deliverable contract before QA acceptance; repair/retry/refund/release according to actual provider cost and retry policy. |
| Rate changes after estimate but before dispatch | Authorization records rate-table version and maximum permitted cost. Re-estimate or stop before dispatch if the ceiling would be exceeded. |
| Very long provider queue | Expose truthful queued state/ETA where available; do not submit duplicates because progress is slow. Allow safe cancellation according to dispatch/cost state. |
| Callback arrives before polling response / out of order | State machine consumes idempotent provider events by job ID/version; late events cannot move a terminal job backwards or double-settle ledger entries. |
| Fallback provider differs materially in style/capability | Production Planner must revalidate prompt/asset plan; do not silently substitute a materially lower-quality mode merely to complete a job. |
| Model output is non-deterministic on re-run | Preserve original asset and generation lineage. Reproduction means reconstructable inputs/version history, not a promise of pixel-identical regeneration. |
</TABLE>
PART X
Metrics, launch gates, roadmap and risk register
This section is normative unless explicitly marked as a hypothesis, experiment, benchmark or future-state item.
# 49. North Star and Metrics Tree
The primary product metric should be the number of completed, performance-linked Creative Tests that produce a usable learning state per active SKU, not total videos generated. Generation volume can rise while product quality and retention fall. The business should optimize the combination of usable output, experiment integrity, learning and customer reuse.
<TABLE>
| Metric family | Core metrics |
| Acquisition | CPM, CTR, CPC, upload-start rate, valid-SKU rate, storyboard rate, Taste CVR, Taste CAC. |
| Activation | Time to Product Brain, time to first useful concept, Taste delivery success, export rate, ad-account connection. |
| Quality | First-render acceptance, fidelity hard-fail rate, claim-block rate, QA repair rate, scene fallback rate. |
| Usage | Creative Tests per active SKU, recommendations accepted, creator packs produced, asset reuse rate. |
| Learning | Experiments reaching Directional/Actionable, time to evidence, contradictions resolved, coverage gaps closed. |
| Retention | W4 active SKU rate, Month-2 retention, plan churn, downgrade/pause, reactivation, product reuse. |
| Economics | Cost per usable export, Taste contribution, effective CAC, subscription contribution, payback, gross/platform margin. |
| Reliability | Job success, duplicate charge incidents, ledger reconciliation errors, connector freshness, provider-failure recovery. |
</TABLE>
# 50. Launch Gates
1. End-to-end: a new merchant can import one eligible skincare SKU, confirm facts/claims, receive concepts, approve a storyboard, pay, render, pass QA and export without operator intervention.
2. Product truth: every final factual statement can be traced to a ProductFact/Claim source or explicit merchant decision.
3. Claims: no BLOCKED or unapproved claim can reach final composition through any text, voice or template path.
4. Billing: idempotency, reservation, failure release, refund and reconciliation tests pass; no double charge under duplicate callback/browser retry tests.
5. Fidelity: hard product-identity failures are caught in the regression set; one-retry-plus-fallback policy works.
6. Performance: Meta/TikTok observations preserve attribution/measurement context and stale connections visibly downgrade recommendations.
7. Experiment integrity: controlled and exploratory tests are distinguished and lineage survives export/import.
8. Observability: every generation can be reconstructed from model/prompt/assets/cost/QA/version metadata.
9. Retention loop: This Week, Creative Map and Day-30 SKU Review are functional; the product is not merely a studio.
10. Security: least-privilege OAuth, tenant isolation, encrypted tokens/secrets, signed asset access and backup/recovery tests are complete.
# 51. Testing Strategy
## Golden datasets
Maintain a versioned evaluation corpus across clear packaging, reflective/transparent bottles, droppers, pumps, jars, multiple bottle counts, dense labels, small text, dark/light packaging, skin application, texture macro, creator footage and product composites. Include allowed, ambiguous and blocked claims; customer reviews containing deceptive therapeutic language; low-sample and confounded performance examples; and historical ads that are visually different but strategically identical.
## Required automated test layers
• Unit tests for scores, eligibility gates, billing/ledger math, state transitions and source precedence.
• Contract tests for Shopify/Meta/TikTok/provider adapters using recorded fixtures and schema-version checks.
• Prompt/model regression tests comparing structured outputs against gold labels.
• Fidelity QA regression with known product mutations and acceptable lighting/angle variation.
• Claims regression including express and implied claim cases.
• End-to-end tests with provider mocks plus scheduled production canaries.
• Load/concurrency tests around batch generation and platform sync; cost ceilings included in tests.
• Chaos/recovery tests: duplicate webhook, worker crash, delayed callback, provider timeout, object-storage failure and rate limit.
# 52. Roadmap
<TABLE>
| Phase | Build | Do not add yet |
| V1 - prove retention | Skincare-only Product Brain, Claims Vault, Creative Genome, read-only performance, recommendations, Studio, production/QA, creator packs, commercial funnel and cost controls. | Autonomous budgets/bids, broad verticals, creator marketplace, enterprise workflow. |
| V1.5 - deepen loop | Better review/comment ingestion, creative-research context, more provider routing, collaboration basics, direct asset handoff/publishing where safe, improved retention automation. | Generic creative suite or feature catalog. |
| V2 - performance operating layer | Optional campaign actions through official APIs/MCP with explicit authorization, fatigue replacement workflow, stronger performance priors, multi-SKU portfolio planning. | Autonomy without controls/approval. |
| Later - category intelligence | Permissioned/aggregated cross-brand priors, UK/localized compliance, adjacent cosmetic categories after skincare economics/retention are proven. | Expansion for TAM optics alone. |
</TABLE>
# 53. Risk Register
<TABLE>
| Risk | Severity | Mitigation / design response |
| Raw AI ad generation commoditizes | High | Differentiate through Product Brain, claims, experiment memory and performance learning; provider-agnostic architecture. |
| Competitors add similar agents | High | Stay narrower and deeper in skincare; own first-party SKU truth and experiment lineage. |
| Product fidelity remains unreliable | High | Strict/hybrid production, hard QA, short scenes, exact product compositing and one-retry fallback. |
| Claims create regulatory/platform risk | High | Evidence-backed Claims Vault, implied-claim review, restricted V1 product scope, audit trail. |
| Paid acquisition is expensive | High | Taste contribution, personalized funnel, rigorous stage measurement and channel reallocation; do not assume $20 CAC. |
| Churn due to novelty wear-off | High | This Week recommendations, performance integration, persistent SKU memory, monthly reviews and creator workflow. |
| False performance conclusions | High | Measurement-context separation, shrinkage, evidence floors and explicit confidence states. |
| Provider pricing/outages | Medium-High | Rate table, Cost Governor, adapters, fallback providers and own asset storage. |
| API permissions/platform change | Medium-High | Least privilege, adapter isolation, data-freshness state and graceful degraded mode. |
| Complexity overwhelms small teams | Medium | Hide backend complexity behind six primary surfaces; default to decisions, not dashboards. |
| Data/privacy concern | High | Tenant isolation, clear retention/deletion, no unauthorized cross-customer learning, audit access. |
</TABLE>
# 54. Engineering Rules to Abide By
<TABLE>
| Do not violate these / These rules are intentionally stronger than normal style guidance. They protect the product moat, economics and customer trust. |
</TABLE>
1. Do not add a model/template/agent feature merely because a competitor has it. Tie every feature to the fixed skincare JTBD and a measurable customer-state improvement.
2. Do not let an LLM become a source of truth. Store sources first, interpretations second and decisions third.
3. Do not allow a model to spend money directly. All billable calls require Cost Governor authorization.
4. Do not ship provider output directly. QA is a mandatory state, not a visual enhancement.
5. Do not call tiny-sample performance a winner. StatisticsService owns confidence terminology.
6. Do not silently compare incompatible attribution contexts.
7. Do not regenerate an entire approved asset when a scene or deterministic overlay can be changed.
8. Do not hide model/provider changes. Every output carries version lineage internally.
9. Do not create lock-in through hostage data or cancellation friction. Make the product sticky because its memory is useful.
10. Do not expand beyond cosmetic skincare until Core-ICP retention and unit economics demonstrate a repeatable business.
# 55. Open Decisions Before Implementation Freeze
<TABLE>
| Decision | Recommended default | Validation |
| Taste timer | 60 minutes after qualified storyboard | A/B 30 vs 60 vs 120; measure purchase, refunds and trust signals. |
| Launch/Growth/Scale Creative Test definition | One hypothesis + master creative + economical hook variants + platform exports | Pilot COGS; ensure hook variants do not silently triple generation. |
| Read-only Meta/TikTok required? | Strongly encouraged after Taste; not mandatory for first output | Measure connection conversion and retention effect. |
| Data retention after cancellation | Keep clearly disclosed archive for a limited period unless deletion requested | Legal/privacy review and reactivation analysis. |
| Pause plan | Do not launch immediately; add only if seasonal churn appears meaningful | Cohort churn reasons. |
| Direct publishing in V1 | Export first; optional asset handoff if low risk | Engineering cost vs retention impact. |
| Secondary runtime models | Opus for high-value reasoning; cheaper models only after evaluation | Golden-set quality + downstream retry COGS. |
</TABLE>
APPENDICES
Reference schemas, taxonomies, formulas and sources
This section is normative unless explicitly marked as a hypothesis, experiment, benchmark or future-state item.
# Appendix A - Initial Creative Taxonomy
<TABLE>
| Family | Initial controlled values |
| Angle | PROBLEM_SOLUTION; INGREDIENT_EDUCATION; TEXTURE_SENSORY; ROUTINE; APPLICATION_HOWTO; OBJECTION_HANDLING; PRODUCT_COMPARISON; SOCIAL_PROOF; FOUNDER_STORY; EXPERT_AUTHORITY; MYTH_BUSTING; FAQ_RESPONSE; LIFESTYLE_IDENTITY; PRICE_VALUE; OFFER; SIMPLICITY; PREMIUM_LUXURY. |
| Hook mechanism | PROBLEM; QUESTION; CONTRARIAN; CURIOSITY; CONFESSION; TESTIMONIAL; DEMONSTRATION; RESULT_FIRST; LIST; WARNING; MYTH; COMMENT_REPLY; DIRECT_PRODUCT. |
| Proof mechanism | TEXTURE_DEMO; APPLICATION_DEMO; INGREDIENT_EXPLANATION; CUSTOMER_TESTIMONIAL; CREATOR_TESTIMONIAL; FOUNDER_EXPLANATION; EXPERT_EXPLANATION; PRODUCT_COMPARISON; BEFORE_AFTER_RESTRICTED; NONE. |
| Production treatment | RAW_UGC; POLISHED_UGC; FOUNDER; CREATOR; PRODUCT_ONLY; MOTION_GRAPHICS; AI_TALENT; AI_PRODUCT; HYBRID; PREMIUM_STUDIO. |
</TABLE>
All taxonomies are versioned. New values require schema review; ad-hoc free-text can coexist for search but cannot silently become canonical categories.
# Appendix B - Event Catalogue
<TABLE>
| Domain | Events |
| Product | PRODUCT_IMPORTED; PRODUCT_FACT_CHANGED; PRODUCT_CONFLICT_DETECTED; VISUAL_FINGERPRINT_VERSIONED; CUSTOMER_THEME_UPDATED. |
| Claims | CLAIM_CREATED; CLAIM_EVIDENCE_ATTACHED; CLAIM_APPROVED; CLAIM_RESTRICTED; CLAIM_BLOCKED. |
| Creative | CREATIVE_IMPORTED; GENOME_EXTRACTED; CREATIVE_VERSIONED. |
| Experiment | EXPERIMENT_CREATED; EXPERIMENT_APPROVED; VARIANT_GENERATED; VARIANT_EXPORTED; EXPERIMENT_CONFOUNDED. |
| Performance | PERFORMANCE_INGESTED; DATA_FRESHNESS_CHANGED; CONFIDENCE_CHANGED; LEARNING_CREATED; LEARNING_WEAKENED; LEARNING_INVALIDATED. |
| Recommendation | RECOMMENDATION_CREATED; RECOMMENDATION_ACCEPTED; RECOMMENDATION_DISMISSED. |
| Production | PROVIDER_JOB_CREATED; PROVIDER_JOB_SUCCEEDED; PROVIDER_JOB_FAILED; QA_FAILED; QA_PASSED; COMPOSITION_COMPLETED. |
| Billing | CREDIT_RESERVED; CREDIT_CONSUMED; CREDIT_RELEASED; CREDIT_REFUNDED; FREE_QA_RETRY; PROVIDER_COST_RECORDED. |
</TABLE>
# Appendix C - Key Formulas / Definitions
<TABLE>
| Metric | Definition |
| Taste contribution | Taste net revenue after expected refunds - output COGS - payment fee allocation. |
| Effective subscriber CAC | (Paid media + free-preview COGS - Taste contribution) / new subscribers; floor at zero for reporting if Taste fully funds acquisition. |
| Cost per usable export | All variable generation/agent/media/QA costs divided by customer-accepted exported paid outputs. |
| Creative coverage | Meaningfully tested hypotheses / eligible hypothesis universe; one trivial/under-delivered ad should not mark territory complete. |
| First-render acceptance | Paid projects accepted/exported without customer-requested creative regeneration after automatic QA repair. |
| Learning velocity | Experiments reaching Directional or Actionable learning state per active SKU per month. |
| Churn | Logo churn and revenue churn tracked separately; pause/downgrade distinguished from full cancellation. |
</TABLE>
# Appendix D - Research Notes and Source Discipline
Official platform/regulatory documentation is treated as authoritative for capabilities and rules at the time accessed. Competitor pages describe vendor-claimed features and should not be treated as independent validation of performance. MADA/Charm market figures are third-party estimates derived from public activity rather than official TikTok Shop financial reporting. Acquisition, conversion, churn and financial figures in the internal model are editable assumptions and scenarios, not industry facts. All sources below were accessed or verified on 23 September 2026 unless otherwise noted.
<TABLE>
| ID | Source | URL |
| R1 | MADA - How do beauty and skincare brands grow on TikTok Shop? | https://wearemada.com/industries/beauty-skincare/ |
| R2 | NIQ - Why Ignoring TikTok Shop Is a Strategic Risk | https://nielseniq.com/global/en/insights/report/2026/why-ignoring-tiktok-shop-is-a-strategic-risk/ |
| R3 | Charm - TikTok Shop's $980M Beauty Boom | https://blog.charm.io/en/blog/tiktok-shops-980m-beauty-boom-marks-another-near-1b-quarter |
| R4 | TikTok - About / Best practices for Product GMV Max | https://ads.tiktok.com/resources/help/article/about-product-gmv-max?lang=en-GB |
| R5 | Meta - Instagram & Facebook Reels Ads | https://www.facebook.com/business/ads/facebook-instagram-reels-ads |
| R6 | TikTok - Getting Started on Shop Ads Checklist - SMB | https://ads.tiktok.com/business/library/Getting_Started_On_Shop_Ads_Checklist_SMB_Managed.pdf |
| R7 | TikTok Creative Center - Creative Tips for Beauty and Personal Care | https://ads.tiktok.com/business/creativecenter/quicktok/online/creative-tips-for-beauty-personal-care/pc/en |
| R8 | Shopify GraphQL Admin API - Product | https://shopify.dev/docs/api/admin-graphql/latest/objects/product |
| R9 | Meta Facebook Marketing API collection - Insights / Attribution settings | https://www.postman.com/meta/facebook-marketing-api/request/5wdl62t/attributionsetting |
| R10 | TikTok API for Business - creative/reporting capabilities | https://ads.tiktok.com/gateway/docs/index?doc_id=1738084416214017&identify_key=c0138ffadd90a955c1f0670a56fe348d1d40680b3c89461e09f78ed26785164b&language=ENGLISH |
| R11 | TikTok - Learning Phase | https://ads.tiktok.com/help/article/learning-phase?lang=en |
| R12 | US FDA - Cosmetics Labeling Claims | https://www.fda.gov/cosmetics/cosmetics-labeling/cosmetics-labeling-claims |
| R13 | US FTC - Health Products Compliance Guidance | https://www.ftc.gov/business-guidance/resources/health-products-compliance-guidance |
| R14 | BytePlus AI - Dreamina Seedance 2.5 pricing and model listing | https://ai.byteplus.com/en |
| R15 | BytePlus - Dreamina Seedance 2.5 resource plans / offers | https://ai.byteplus.com/en/activity/seedanceplans |
| R16 | BytePlus - Dola Seedream 5.0 Pro | https://ai.byteplus.com/en/product/Seedream |
| R17 | Anthropic - Introducing Claude Opus 5.5 | https://www.anthropic.com/claude-opus-5-5 |
| R18 | Higgsfield - AI Ad Generator | https://higgsfield.ai/ai-ad-generator |
| R19 | Creatify - Pricing and platform capabilities | https://creatify.ai/pricing |
| R20 | Arcads - AI ads / workflows / 1,000+ actors | https://www.arcads.ai/ |
| R21 | Foreplay - Changelog / MCP access to 200M+ ads | https://feedback.foreplay.co/changelog |
| R22 | Motion - Creative Insights for Meta & TikTok | https://help.motionapp.com/en/articles/8292732-creative-insights-for-meta-tiktok |
| R23 | Pencil - Introducing Agents | https://help.trypencil.com/en/articles/11452225-introducing-agents-a-smarter-way-to-create-ads-with-pencil |
| R24 | Pippit - Publisher, analytics and ecommerce video workflow | https://www.pippit.ai/resource/help-center/publisher-n-analytics |
| R25 | Zeely - 2026 pricing / paid-trial structure | https://zeely.ai/blog/how-much-does-zeely-cost-in-2026/ |
| R26 | TikTok - TikTok for Business MCP Server / Agentic Hub | https://ads.tiktok.com/help/article/about-tiktok-for-business-agentic-hub-and-mcp-server?lang=en-GB |
</TABLE>
# Appendix E - Final Product Standard
<TABLE>
| One sentence / Build the best system for the person responsible for performance creative at a small US DTC cosmetic-skincare brand: know the SKU, know what has been tried, know what can be said, recommend the next useful experiment, produce it accurately, learn from the result, and make that loop more valuable every week. |
</TABLE>
Any future product decision should be tested against that sentence. If a feature does not improve one of those responsibilities, it is probably not V1. If it makes the system more generic, less auditable, more expensive without increasing usable output, or more dependent on a single provider, it should face a high burden of proof.
