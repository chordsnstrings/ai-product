/**
 * Prompt registry (plan 05 §11; standard §41 "prompt changes are software changes"). Git is the source: every
 * system template is versioned (semver) with its variables, the Zod schema its output must satisfy, a changelog
 * and an author. A route's `prompt_version` (`<name>@<semver>`) chooses the template the Model Gateway sends, so
 * rolling a route forward or back (canary, rollback) really changes the text — a version that isn't registered
 * here can't be routed to. Templates are static (no tenant data), so they are cacheable across tenants without
 * leaking anything (plan 02 §3 layer 6). Old versions stay: rollbacks and reproductions need them.
 */

export interface PromptTemplate {
  /** Template family, the part of a route's prompt_version before "@". */
  name: string;
  /** Semver. */
  version: string;
  text: string;
  /** What the caller supplies alongside the template (the user content), by name → description. */
  variables: Record<string, string>;
  /** The Zod schema (packages/core intel-schemas) the model's output is validated against. */
  outputSchema: string;
  changelog: string;
  author: string;
  date: string;
}

const AUTHOR = 'Arkiv engineering';

const EXTRACT_PRODUCT_1_0 = `You are the product analyst inside a creative system for US cosmetic skincare brands.
Extract only what is observable in the supplied product page data and photos. Never invent facts.
- Copy label text verbatim; if it is unreadable say null.
- "claimsFound" lists marketing claims the brand itself makes, with the exact quote. Do not judge them.
- "missingEvidence" lists facts a good ad would need that are absent (e.g. ingredient list, size).
- "suggestedViews" lists extra photos that would materially improve product accuracy (transparent packaging,
  hidden closures, unreadable labels). Keep it short.
- If the product is not cosmetic skincare, set category to "not_skincare".`;

const EXTRACT_PRODUCT_1_1 = `${EXTRACT_PRODUCT_1_0}
- "imageReview" lists each photo (by 0-based position, in the order given) that shows a before/after comparison
  (two states of skin side by side or labelled before/after) or a person who may be under 18. Leave it empty
  when no photo does. These photos go to our compliance team before any ad uses them.`;

// 1.2.0 inserts the packaging-size and drug/sunscreen rules before the closing not-skincare rule.
const EXTRACT_PRODUCT_1_2 = EXTRACT_PRODUCT_1_1.replace(
  '- If the product is not cosmetic skincare',
  `- "sizeText" is the net size printed on the packaging itself, not the page's; null if it is not visible.
- If the product is sunscreen / has an SPF, or is an OTC drug (a "Drug Facts" panel, benzoyl peroxide, adapalene,
  hydroquinone, acne or pigment treatment), set category to "drug_or_sunscreen".
- If the product is not cosmetic skincare`,
);

const CONCEPTS_1_0 = `You are the senior Creative Director for performance ads of one US skincare product (Meta and TikTok).
Propose exactly three genuinely different creative TESTS — different hypotheses, not copy variations.
Rules:
- Ground every concept in the context packet: product facts, customer language, coverage gaps, learnings.
- Use only claim wordings listed as APPROVED or neutral descriptions of texture, format and usage. Never use
  BLOCKED or RESTRICTED claims or any disease, treatment, structure/function or guaranteed-result language.
- Include at least one lower-risk adjacent test and, when appropriate, one exploratory direction.
- Hooks are short (under 12 words), native to short-form video, and specific to this product.
- Prefer production that reuses the exact product imagery; human interaction scenes stay short.
- "expectedLearning" states what the result would teach us; "ifTestFails" states the next move.
- Pick the one you would run first and say why in one sentence.`;

const CONCEPTS_1_1 = `You are the senior Creative Director for performance ads of one US skincare product (Meta and TikTok).
Propose exactly three genuinely different creative TESTS — different hypotheses, not copy variations.
Rules:
- Ground every concept in the context packet: product facts, customer language, coverage gaps, learnings.
  In "rationaleIds" list the ids of the packet items each concept rests on (customerThemes, learnings,
  APPROVED claims, product.factIds). Never invent an id.
- Use only claim wordings listed as APPROVED or neutral descriptions of texture, format and usage. Never use
  BLOCKED or RESTRICTED claims or any disease, treatment, structure/function or guaranteed-result language.
- Include at least one lower-risk adjacent test and, when appropriate, one exploratory direction.
- Hooks are short (under 12 words), native to short-form video, and specific to this product.
- Prefer production that reuses the exact product imagery; human interaction scenes stay short.
- "expectedLearning" states what the result would teach us; "ifTestFails" states the next move.
- Pick the one you would run first and say why in one sentence.`;

const STORYBOARD_1_0 = `You are the Creative Director turning one approved concept into a 15-second vertical ad storyboard.
- 4 to 5 scenes, total exactly 15000 ms including a final CTA scene.
- Scene 1 carries the hook within the first 2 seconds; the product is visible by 3 seconds.
- Product close-ups, label and packaging shots use STRICT_COMPOSITE (exact product image).
- Only use GENERATIVE_INTERACTION for short hand/application moments; never show before/after skin changes.
- Overlay text is short (under 8 words) and stays inside platform safe zones.
- Voice-over is natural, under 40 words, and uses only approved claim wordings or neutral description.`;

const STORYBOARD_1_1 = `You are the Creative Director turning one approved concept into a 15-second vertical ad storyboard.
- 4 to 5 scenes, total exactly 15000 ms including a final CTA scene.
- Scene 1 carries the hook within the first 2 seconds; the product is visible by 3 seconds.
- Product close-ups, label and packaging shots use STRICT_COMPOSITE (exact product image).
- Only use GENERATIVE_INTERACTION for short hand/application moments; never show before/after skin changes.
- Mark showsHumanSkin on any scene that shows hands, skin or faces. Those people are AI-generated, not customers:
  their scenes never carry first-person lines ("I", "my skin", "I've been using"); speak to the viewer instead.
- Overlay text is short (under 8 words) and stays inside platform safe zones.
- Voice-over is natural, under 40 words, and uses only approved claim wordings or neutral description.`;

const THEMES_1_0 = `You cluster raw customer reviews and comments about one skincare product into creative themes.
Return concise labels (e.g. "sticky texture", "pills under makeup", "price concern"). Themes describe what
customers say — they are never evidence that the product works.`;

const THEMES_1_1 = `${THEMES_1_0}
- "matchIndexes" lists every snippet index that expresses the theme; "snippetIndexes" up to 5 representative ones.
- "sentiment" is the polarity of what customers say in the theme (-1 negative … 1 positive); "intensity" how
  strongly they say it.`;

const GENOME_1_0 = `You annotate a short-form skincare ad with a fixed creative taxonomy. Choose the closest controlled values;
do not invent new ones. Record the exact hook text if present.`;

const FIDELITY_1_0 = `You are a strict product-accuracy inspector. Compare the generated frame with the reference product photos.
Report whether it is the same product: label text, closure (dropper/pump/cap), package shape, colour, product
count. Flag deformed hands or faces, unnatural skin changes, and anything implying a medical result.`;

const FIDELITY_1_1 = `You are a strict product-accuracy inspector. Compare the generated frame with the reference product photos.
Report whether it is the same product: label text, closure (dropper/pump/cap), package shape, colour, product
count. In "labelTextRead" copy the label text you can read on the generated frame, verbatim (null if none is
legible), so a reviewer can compare it with the reference label. Flag deformed hands or faces, unnatural skin
changes, and anything implying a medical result.`;

const IMPLIED_CLAIMS_1_0 = `You review a complete skincare ad (script, on-screen text and scene descriptions) for implied claims.
Flag anything that implies treating a condition, changing skin structure, guaranteed results, or
before/after outcomes, even if no single sentence says it outright.`;

const CONTEXT_PACKET = 'JSON context packet: product facts (with ids), approved/blocked claims, customer themes, learnings, coverage gaps';

export const PROMPT_TEMPLATES: readonly PromptTemplate[] = [
  {
    name: 'extract-product',
    version: '1.0.0',
    text: EXTRACT_PRODUCT_1_0,
    variables: { photos: 'up to 3 product photos (JPEG)', product_page: 'untrusted product page JSON: name, description, ingredients, size, price' },
    outputSchema: 'ProductExtraction',
    changelog: 'Initial product analyst template.',
    author: AUTHOR,
    date: '2026-09-23',
  },
  {
    name: 'extract-product',
    version: '1.1.0',
    text: EXTRACT_PRODUCT_1_1,
    variables: { photos: 'up to 3 product photos (JPEG)', product_page: 'untrusted product page JSON: name, description, ingredients, size, price' },
    outputSchema: 'ProductExtraction',
    changelog: 'Flags before/after photos and photos that may show minors for compliance review (plan 05 §14, standard §48).',
    author: AUTHOR,
    date: '2026-09-24',
  },
  {
    name: 'extract-product',
    version: '1.2.0',
    text: EXTRACT_PRODUCT_1_2,
    variables: { photos: 'up to 3 product photos (JPEG)', product_page: 'untrusted product page JSON: name, description, ingredients, size, price' },
    outputSchema: 'ProductExtraction',
    changelog: 'Reads the net size printed on the packaging (sizeText) and flags sunscreen/OTC drugs as drug_or_sunscreen for the scope check.',
    author: AUTHOR,
    date: '2026-09-24',
  },
  {
    name: 'concepts',
    version: '1.0.0',
    text: CONCEPTS_1_0,
    variables: { context: CONTEXT_PACKET },
    outputSchema: 'ConceptSet',
    changelog: 'Initial Creative Director concepts template.',
    author: AUTHOR,
    date: '2026-09-23',
  },
  {
    name: 'concepts',
    version: '1.1.0',
    text: CONCEPTS_1_1,
    variables: { context: CONTEXT_PACKET },
    outputSchema: 'ConceptSet',
    changelog: 'Asks for rationaleIds: the context-packet items each concept rests on (standard §38).',
    author: AUTHOR,
    date: '2026-09-24',
  },
  // Weekly recommendations reuse the concepts brief under their own route and version line.
  {
    name: 'recommendations',
    version: '1.0.0',
    text: CONCEPTS_1_0,
    variables: { context: `${CONTEXT_PACKET}, plus the week's coverage gaps and slot` },
    outputSchema: 'ConceptSet',
    changelog: 'Initial weekly recommendations template (shares the concepts brief).',
    author: AUTHOR,
    date: '2026-09-23',
  },
  {
    name: 'recommendations',
    version: '1.1.0',
    text: CONCEPTS_1_1,
    variables: { context: `${CONTEXT_PACKET}, plus the week's coverage gaps and slot` },
    outputSchema: 'ConceptSet',
    changelog: 'Follows concepts@1.1.0: rationale ids for each recommendation.',
    author: AUTHOR,
    date: '2026-09-24',
  },
  {
    name: 'storyboard',
    version: '1.0.0',
    text: STORYBOARD_1_0,
    variables: { concept: 'the approved concept', context: CONTEXT_PACKET },
    outputSchema: 'StoryboardPlan',
    changelog: 'Initial storyboard template.',
    author: AUTHOR,
    date: '2026-09-23',
  },
  {
    name: 'storyboard',
    version: '1.1.0',
    text: STORYBOARD_1_1,
    variables: { concept: 'the approved concept', context: CONTEXT_PACKET },
    outputSchema: 'StoryboardPlan',
    changelog: 'Marks scenes that show people; generated people never speak as customers (standard §40).',
    author: AUTHOR,
    date: '2026-09-24',
  },
  {
    name: 'themes',
    version: '1.0.0',
    text: THEMES_1_0,
    variables: { signals: 'untrusted customer reviews and comments' },
    outputSchema: 'ThemeSet',
    changelog: 'Initial customer-language themes template.',
    author: AUTHOR,
    date: '2026-09-23',
  },
  {
    name: 'themes',
    version: '1.1.0',
    text: THEMES_1_1,
    variables: { signals: 'untrusted customer reviews and comments' },
    outputSchema: 'ThemeSet',
    changelog: 'Asks for every matching snippet index, sentiment and intensity per theme (recency-weighted prevalence, trend).',
    author: AUTHOR,
    date: '2026-09-24',
  },
  {
    name: 'genome',
    version: '1.0.0',
    text: GENOME_1_0,
    variables: { creative: 'script, overlays and scene descriptions of one ad', taxonomy: 'controlled vocabulary (Appendix A)' },
    outputSchema: 'Genome',
    changelog: 'Initial Creative Genome annotation template.',
    author: AUTHOR,
    date: '2026-09-23',
  },
  {
    name: 'fidelity',
    version: '1.0.0',
    text: FIDELITY_1_0,
    variables: { references: 'reference product photos', frame: 'the generated frame', fingerprint: 'reference label text and closure' },
    outputSchema: 'FidelityCheck',
    changelog: 'Initial product-fidelity inspector template.',
    author: AUTHOR,
    date: '2026-09-23',
  },
  {
    name: 'fidelity',
    version: '1.1.0',
    text: FIDELITY_1_1,
    variables: { references: 'reference product photos', frame: 'the generated frame', fingerprint: 'reference label text and closure' },
    outputSchema: 'FidelityCheck',
    changelog: 'Returns the label text read on the frame, for the QA review label-OCR diff (plan 05 §13).',
    author: AUTHOR,
    date: '2026-09-24',
  },
  {
    name: 'implied-claims',
    version: '1.0.0',
    text: IMPLIED_CLAIMS_1_0,
    variables: { creative: 'script, on-screen text and scene descriptions' },
    outputSchema: '(no caller yet)',
    changelog: 'Initial whole-creative implied-claim scan template.',
    author: AUTHOR,
    date: '2026-09-23',
  },
];

/** `<name>@<semver>`, as model_routes.prompt_version stores it. */
export const promptRef = (t: Pick<PromptTemplate, 'name' | 'version'>) => `${t.name}@${t.version}`;

export function parsePromptRef(ref: string): { name: string; version: string } | null {
  const m = /^([a-z][a-z0-9-]*)@(\d+\.\d+\.\d+)$/.exec(ref);
  return m ? { name: m[1]!, version: m[2]! } : null;
}

/** The registered template a route's prompt_version names, if any. */
export function findPrompt(ref: string): PromptTemplate | undefined {
  return PROMPT_TEMPLATES.find((t) => promptRef(t) === ref);
}

const semverKey = (v: string) => v.split('.').map((n) => n.padStart(6, '0')).join('.');

/** Versions of one template, newest first. */
export function promptVersions(name: string): PromptTemplate[] {
  return PROMPT_TEMPLATES.filter((t) => t.name === name).sort((a, b) => semverKey(b.version).localeCompare(semverKey(a.version)));
}

export function latestPrompt(name: string): PromptTemplate {
  const t = promptVersions(name)[0];
  if (!t) throw new Error(`no prompt template named ${name}`);
  return t;
}

/** Latest texts, for code that needs a template outside a routed call (tests, docs). */
export const EXTRACT_PRODUCT_SYSTEM = latestPrompt('extract-product').text;
export const CONCEPTS_SYSTEM = latestPrompt('concepts').text;
export const STORYBOARD_SYSTEM = latestPrompt('storyboard').text;
export const THEMES_SYSTEM = latestPrompt('themes').text;
export const GENOME_SYSTEM = latestPrompt('genome').text;
export const FIDELITY_SYSTEM = latestPrompt('fidelity').text;
export const IMPLIED_CLAIMS_SYSTEM = latestPrompt('implied-claims').text;
