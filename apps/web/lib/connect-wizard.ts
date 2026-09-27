/**
 * The Day 0–1 connection wizard (plan 03 A8 "connection wizards (Day 0–1, standard §9)"): Shopify for product
 * truth, then Meta and TikTok for results. Every step can be skipped; nothing in the product waits on it.
 */
export const WIZARD_STEPS = ['shopify', 'meta', 'tiktok'] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number] | 'done';

/** The step after `provider` (the wizard's end after the last one, or for anything unknown). */
export function wizardStepAfter(provider: string): WizardStep {
  const i = (WIZARD_STEPS as readonly string[]).indexOf(provider);
  return i >= 0 && i < WIZARD_STEPS.length - 1 ? WIZARD_STEPS[i + 1]! : 'done';
}

/** The step to show: the one asked for, else the first one not connected yet. */
export function currentWizardStep(asked: string | undefined, connected: ReadonlySet<string>): WizardStep {
  if (asked === 'done' || (WIZARD_STEPS as readonly string[]).includes(asked ?? '')) return asked as WizardStep;
  return WIZARD_STEPS.find((s) => !connected.has(s)) ?? 'done';
}
