/**
 * Built-in skincare examples (plan 03 P1 §7 "3–6 skincare examples labelled Example", plan 04 L1 "the hero visual is
 * the same archetype as the ad"; standard §13 "Examples shown must be skincare"). A demo product drawn by
 * packages/media/scripts/landing-examples.ts — never a customer's work — shown until staff choose examples from the
 * internal demo workspace in the console. Every one carries the "Example, made for a demo product" label (L13).
 */
export const EXAMPLE_LABEL = 'Example, made for a demo product';

export interface BuiltInExample {
  key: string;
  /** landing_pages.archetype this example illustrates. */
  archetype: string;
  src: string;
  caption: string;
}

export const BUILT_IN_EXAMPLES: readonly BuiltInExample[] = [
  { key: 'texture', archetype: 'texture_demo', src: '/examples/texture.jpg', caption: 'Texture demo' },
  { key: 'serum-launch', archetype: 'serum_launch', src: '/examples/serum-launch.jpg', caption: 'Serum launch' },
  { key: 'ugc', archetype: 'ugc', src: '/examples/ugc.jpg', caption: 'Creator-style routine' },
  { key: 'founder', archetype: 'founder', src: '/examples/founder.jpg', caption: 'Founder story' },
  { key: 'fatigue', archetype: 'creative_fatigue', src: '/examples/fatigue.jpg', caption: 'Creative refresh' },
];

/** The demo product's photo: what a merchant uploads (the "input" half of the hero demo). */
export const EXAMPLE_INPUT = '/examples/input.jpg';
/** A muted loop of the finished frames, for the desktop hero only. */
export const EXAMPLE_LOOP = '/examples/loop.mp4';

/** The example for a page's archetype (the default page leads with the texture demo). */
export function exampleFor(archetype: string | null | undefined): BuiltInExample {
  return BUILT_IN_EXAMPLES.find((e) => e.archetype === archetype) ?? BUILT_IN_EXAMPLES[0]!;
}
