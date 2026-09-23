import { detectSkincareCategory, nonSkincareCategory } from './compliance';
import type { ConceptSet, Genome, ProductExtraction, Proposal, StoryboardPlan } from './intel-schemas';

/**
 * Deterministic "model" outputs for PROVIDERS_MODE=mock. They are built from the real product data so dev,
 * tests and demos produce specific, plausible skincare work — and they double as golden expectations.
 */

export interface ProductContext {
  name: string;
  category: string;
  sizeText?: string | null;
  texture?: string | null;
  ingredients?: string[];
  approvedClaims: string[];
  themes: { label: string; signalType: string }[];
  testedAngles: string[];
}

const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

const INGREDIENTS = ['niacinamide', 'hyaluronic acid', 'ceramides', 'squalane', 'peptides', 'vitamin c', 'retinol', 'glycerin', 'panthenol', 'centella', 'bakuchiol', 'azelaic acid'];

export function mockExtraction(input: { name?: string; description?: string; text: string; ingredients?: string; sizeText?: string }): ProductExtraction {
  const all = `${input.name ?? ''} ${input.description ?? ''} ${input.text}`;
  const notSkin = nonSkincareCategory(all);
  const category = notSkin ? 'not_skincare' : detectSkincareCategory(all);
  const lower = `${all} ${input.ingredients ?? ''}`.toLowerCase();
  const keyIngredients = INGREDIENTS.filter((i) => lower.includes(i)).slice(0, 5);
  const claimSentences = (input.description ?? '')
    .split(/(?<=[.!])\s+/)
    .filter((s) => /\b(hydrat|smooth|bright|firm|plump|calm|sooth|absorb|glow|reduce|visibly|clinically|dermatologist|non-comedogenic|fragrance[- ]free|lightweight|acne|wrinkle)/i.test(s))
    .slice(0, 6)
    .map((s) => ({ wording: s.trim().replace(/\s+/g, ' ').slice(0, 200), sourceQuote: s.trim().slice(0, 300) }));
  const format = /\bgel\b/i.test(all) ? 'gel' : /\boil\b/i.test(all) ? 'oil' : /\bcream\b/i.test(all) ? 'cream' : category === 'serum' ? 'serum' : null;
  const packaging = category === 'serum' || category === 'facial_oil' ? 'dropper_bottle' : category === 'moisturizer' || category === 'mask' ? 'jar' : category === 'cleanser' ? 'pump_bottle' : 'bottle';
  return {
    name: (input.name ?? 'Untitled product').slice(0, 160),
    brand: null,
    category: category as ProductExtraction['category'],
    sizeText: input.sizeText ?? null,
    format,
    texture: /lightweight|weightless/i.test(all) ? 'lightweight, fast-absorbing' : format === 'cream' ? 'rich cream' : null,
    keyIngredients,
    labelText: input.name ?? null,
    packaging: { type: packaging, closure: packaging === 'dropper_bottle' ? 'dropper' : packaging === 'pump_bottle' ? 'pump' : 'cap', transparent: false, colors: ['white'] },
    claimsFound: claimSentences,
    missingEvidence: [!input.ingredients ? 'Full ingredient list (INCI)' : null, !input.sizeText ? 'Product size' : null].filter(Boolean) as string[],
    suggestedViews: ['side', 'swatch'],
    assetQualityConfidence: 0.8,
    multipleProductsVisible: false,
  };
}

function pickThemes(ctx: ProductContext) {
  const objection = ctx.themes.find((t) => t.signalType === 'objection')?.label;
  const benefit = ctx.themes.find((t) => t.signalType === 'benefit')?.label;
  return { objection: objection ?? (ctx.category === 'serum' ? 'feels sticky under makeup' : 'heavy, greasy feel'), benefit: benefit ?? 'skin feels soft and comfortable' };
}

export function mockConcepts(ctx: ProductContext, batch = 1): ConceptSet {
  const n = ctx.name;
  const { objection, benefit } = pickThemes(ctx);
  const ing = ctx.ingredients?.[0];
  const approved = ctx.approvedClaims.slice(0, 1);
  const texture = ctx.texture ?? (ctx.category === 'serum' ? 'lightweight' : 'silky');
  const base: Proposal[] = [
    {
      hypothesis: `Showing the ${texture} texture in the first two seconds beats a talking opening for ${n}.`,
      customerTension: `Shoppers worry a new ${ctx.category} will ${objection}.`,
      customerTensionSource: ctx.themes.length ? 'reviews' : 'category_pattern',
      whyNow: ctx.testedAngles.includes('TEXTURE_SENSORY') ? 'Texture was directional; this isolates the opening.' : 'Texture is untested for this SKU and is the most native skincare format.',
      primaryVariable: 'hook',
      angle: 'TEXTURE_SENSORY',
      hookMechanism: 'DEMONSTRATION',
      hookOptions: [`Watch this ${texture} ${ctx.category} disappear`, 'No sticky finish. Here is proof.', `The ${ctx.category} that layers under makeup`],
      bodyStrategy: 'Macro texture drop → spread on hand → absorbs → product hero → routine placement → CTA.',
      proofMechanism: 'TEXTURE_DEMO',
      treatment: 'HYBRID',
      claimWordings: approved,
      expectedLearning: 'Whether a texture-first opening lifts hold rate versus the brand’s usual opening.',
      ifTestFails: 'Keep the body, test a problem-first hook instead.',
      riskProfile: 'lower_risk',
      estimatedGenerationClass: 'hybrid_short',
    },
    {
      hypothesis: `Answering the “${objection}” objection directly converts better than general benefits for ${n}.`,
      customerTension: `“Will it ${objection}?” is the most common hesitation.`,
      customerTensionSource: ctx.themes.length ? 'reviews' : 'category_pattern',
      whyNow: 'Objection handling is uncovered in this SKU’s creative map.',
      primaryVariable: 'angle',
      angle: 'OBJECTION_HANDLING',
      hookMechanism: 'QUESTION',
      hookOptions: [`Does it ${objection}? Let’s check.`, 'The question everyone asks about this', 'I tested it under makeup'],
      bodyStrategy: 'State the worry → show it layered under makeup → close-up finish → product hero → CTA.',
      proofMechanism: 'APPLICATION_DEMO',
      treatment: 'POLISHED_UGC',
      claimWordings: approved,
      expectedLearning: 'Whether naming the objection lifts click-through against benefit-led openings.',
      ifTestFails: 'Move the objection to the middle and test a benefit-led hook.',
      riskProfile: 'adjacent',
      estimatedGenerationClass: 'generative_short',
    },
    {
      hypothesis: ing
        ? `A simple ${ing} explainer builds more purchase intent than lifestyle footage for ${n}.`
        : `Placing ${n} in a 3-step routine sells it better than a single-product focus.`,
      customerTension: ing ? `Buyers see ${ing} everywhere but don’t know what it does in this formula.` : 'Routines feel complicated; people want to know where it fits.',
      customerTensionSource: 'category_pattern',
      whyNow: 'An exploratory direction to widen the tested territory.',
      primaryVariable: 'angle',
      angle: ing ? 'INGREDIENT_EDUCATION' : 'ROUTINE',
      hookMechanism: ing ? 'MYTH' : 'LIST',
      hookOptions: ing ? [`What ${ing} actually does in your routine`, `${ing[0]!.toUpperCase()}${ing.slice(1)}, explained in 10 seconds`, 'Stop guessing what goes on first'] : ['My 3-step night routine', 'Where this goes in your routine', 'Step two is the one that matters'],
      bodyStrategy: ing ? 'Ingredient title card → product hero → how to apply → feel → CTA.' : 'Step 1 cleanse → step 2 this product → step 3 moisturize → CTA.',
      proofMechanism: ing ? 'INGREDIENT_EXPLANATION' : 'APPLICATION_DEMO',
      treatment: 'MOTION_GRAPHICS',
      claimWordings: [],
      expectedLearning: 'Whether education-led creative earns cheaper clicks for this SKU.',
      ifTestFails: 'Retire the education angle for this SKU and reinvest in texture.',
      riskProfile: 'exploratory',
      estimatedGenerationClass: 'remix',
    },
  ];
  const offset = (batch - 1) % 3;
  const concepts = [...base.slice(offset), ...base.slice(0, offset)] as [Proposal, Proposal, Proposal];
  if (batch > 1) concepts.forEach((c, i) => (c.hookOptions = [c.hookOptions[(i + batch) % 3]!, ...c.hookOptions.filter((_, j) => j !== (i + batch) % 3)]));
  return { concepts, pickIndex: 0, pickReason: `Lowest production risk and it tests the ${concepts[0].angle.toLowerCase().replace(/_/g, ' ')} angle this SKU has not tried yet.` };
}

export function mockStoryboard(ctx: ProductContext, concept: Proposal): StoryboardPlan {
  const hook = concept.hookOptions[0]!;
  const claim = ctx.approvedClaims[0];
  const vo = [hook + '.', concept.proofMechanism === 'TEXTURE_DEMO' ? 'Two drops. It absorbs fast and leaves no sticky finish.' : `Here is how ${ctx.name} fits your routine.`, claim ? `${claim}.` : 'Skin feels soft and comfortable.', 'Tap to try it.'].join(' ');
  return {
    hook,
    cta: 'Shop now',
    voiceover: vo.slice(0, 420),
    scenes: [
      { purpose: 'hook', durationMs: 3000, visualPlan: `Macro close-up: ${ctx.name} on seamless warm paper, soft side light.`, productBehavior: 'Product upright, label facing camera', spokenLine: hook, overlayText: hook.slice(0, 60), productionMode: 'STRICT_COMPOSITE', showsHumanSkin: false },
      { purpose: 'demonstration', durationMs: 4000, visualPlan: 'A hand releases a drop onto the back of the other hand; slow spread.', productBehavior: 'Dropper/pump dispensing, product partly visible', spokenLine: 'Two drops. It absorbs fast.', overlayText: 'Absorbs in seconds', productionMode: 'GENERATIVE_INTERACTION', showsHumanSkin: true },
      { purpose: 'product_reveal', durationMs: 3000, visualPlan: 'Hero shot, product centred, label sharp, gentle push-in.', productBehavior: 'Static hero', spokenLine: claim ?? 'Skin feels soft and comfortable.', overlayText: ctx.sizeText ? `${ctx.name} · ${ctx.sizeText}` : ctx.name, productionMode: 'STRICT_COMPOSITE', showsHumanSkin: false },
      { purpose: 'routine', durationMs: 3000, visualPlan: 'Flat lay of the routine with the product as step two.', productBehavior: 'Product in routine line-up', spokenLine: 'Morning and night, after cleansing.', overlayText: 'AM + PM, after cleansing', productionMode: 'HYBRID', showsHumanSkin: false },
      { purpose: 'cta', durationMs: 2000, visualPlan: 'End card with product name and CTA.', productBehavior: null, spokenLine: 'Tap to try it.', overlayText: null, productionMode: 'STRICT_COMPOSITE', showsHumanSkin: false },
    ],
  };
}

export function mockGenome(text: string): Genome {
  const h = hash(text);
  const t = text.toLowerCase();
  const angle = /texture|absorb|feel/.test(t) ? 'TEXTURE_SENSORY' : /routine|step/.test(t) ? 'ROUTINE' : /ingredient|niacinamide|hyaluronic/.test(t) ? 'INGREDIENT_EDUCATION' : /\?/.test(t) ? 'OBJECTION_HANDLING' : /founder|i made/.test(t) ? 'FOUNDER_STORY' : /off|sale|bundle/.test(t) ? 'OFFER' : 'PROBLEM_SOLUTION';
  return {
    angle,
    secondaryAngle: null,
    hookMechanism: /\?/.test(t) ? 'QUESTION' : /watch|look/.test(t) ? 'DEMONSTRATION' : 'PROBLEM',
    hookText: text.split(/[.!?]/)[0]?.slice(0, 160) ?? null,
    proofMechanism: angle === 'TEXTURE_SENSORY' ? 'TEXTURE_DEMO' : angle === 'INGREDIENT_EDUCATION' ? 'INGREDIENT_EXPLANATION' : 'APPLICATION_DEMO',
    treatment: (['RAW_UGC', 'POLISHED_UGC', 'PRODUCT_ONLY', 'HYBRID'] as const)[h % 4]!,
    customerProblem: null,
    productRevealSec: 2,
    faceRevealSec: null,
    durationSec: 15,
    hasCaptions: true,
    hasVoiceover: true,
    offer: /\d+% off|bundle|free shipping/.test(t) ? (t.match(/\d+% off|bundle|free shipping/)?.[0] ?? null) : null,
  };
}

export function mockThemes(snippets: string[]) {
  const buckets: [RegExp, string, 'objection' | 'benefit' | 'question' | 'usage' | 'sentiment'][] = [
    [/sticky|tacky|greasy|oily/i, 'sticky or greasy feel', 'objection'],
    [/pill|under makeup|foundation/i, 'pilling under makeup', 'objection'],
    [/price|expensive|pricey|cost/i, 'price concern', 'objection'],
    [/sensitive|irritat|sting|burn|red/i, 'sensitivity concern', 'objection'],
    [/smell|scent|fragrance/i, 'scent', 'sentiment'],
    [/soft|smooth|glow|hydrat|plump/i, 'feels hydrated and soft', 'benefit'],
    [/absorb|quick|fast|lightweight/i, 'absorbs quickly', 'benefit'],
    [/how (do|to)|when|order|routine/i, 'how to use it in a routine', 'question'],
  ];
  const themes = buckets
    .map(([re, label, signalType]) => {
      const idx = snippets.map((s, i) => (re.test(s) ? i : -1)).filter((i) => i >= 0);
      return { label, signalType, intensity: Math.min(1, idx.length / Math.max(3, snippets.length / 3)), snippetIndexes: idx.slice(0, 5), count: idx.length };
    })
    .filter((t) => t.count > 0)
    .sort((a, b) => b.count - a.count)
    .map(({ count: _c, ...t }) => t);
  return { themes };
}
