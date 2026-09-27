/**
 * Where a project's own page is, from its state (plan 03 P3–P10, A1 "Active jobs strip"): the funnel page that
 * shows what is happening now. A project made from an experiment (Studio) opens there instead.
 *
 *   analysing / confirming         → /start/:id
 *   CONCEPTS_READY                 → /concepts/:id
 *   CONCEPT_SELECTED (drawing), STORYBOARD_READY → /storyboard/:id
 *   NEEDS_USER_ACTION before anything was paid for (the analysis waits for a photo) → /start/:id
 *   production states, stopped states → /produce/:id
 *   COMPLETE                       → /deliver/:id
 */
export const PRE_PAYMENT_STATES = ['CONCEPT_SELECTED', 'STORYBOARD_READY'] as const;
const EARLY = ['PRODUCT_UPLOADED', 'PRODUCT_ANALYZED', 'BRIEF_READY'];

export function projectRoute(state: string, projectId: string, opts: { experimentId?: string | null; slug?: string | null; entitlementUnit?: string | null } = {}): string {
  if (opts.experimentId && opts.slug) return `/w/${opts.slug}/studio/${opts.experimentId}`;
  if (EARLY.includes(state) || (state === 'NEEDS_USER_ACTION' && !opts.entitlementUnit)) return `/start/${projectId}`;
  if (state === 'CONCEPTS_READY') return `/concepts/${projectId}`;
  if ((PRE_PAYMENT_STATES as readonly string[]).includes(state)) return `/storyboard/${projectId}`;
  if (state === 'COMPLETE') return `/deliver/${projectId}`;
  return `/produce/${projectId}`;
}
