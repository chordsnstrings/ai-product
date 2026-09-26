/**
 * This Week's "What changed" (plan 03 A1: "only significant state changes (standard §11)"; standard §12:
 * "significant performance state changes"). Each row names the test, learning or connection that changed and
 * links to it. Renders finishing and claim decisions are not performance state changes and are left out.
 */
export const WHAT_CHANGED_TYPES = [
  'CONFIDENCE_CHANGED',
  'LEARNING_CREATED',
  'LEARNING_WEAKENED',
  'LEARNING_INVALIDATED',
  'EXPERIMENT_CONFOUNDED',
  'INTEGRATION_DEGRADED',
  'INTEGRATION_DISCONNECTED',
] as const;

export interface ChangeEvent {
  type: string;
  subjectId: string | null;
  refs: { experimentId?: string; skuId?: string } | null;
  payload: { to?: string; provider?: string } | null;
}

export interface ChangeSubjects {
  experiments: ReadonlyMap<string, { hypothesis: string; sku: string | null; state: string }>;
  learnings: ReadonlyMap<string, { statement: string; sku: string | null }>;
  integrations: ReadonlyMap<string, { provider: string; name: string | null }>;
}

/** Experiment states still being made (Studio); every later state reads on Results (standard §35). */
export const STUDIO_STATES: ReadonlySet<string> = new Set(['DRAFT', 'RECOMMENDED', 'APPROVED', 'PRODUCING', 'READY_TO_RUN']);
const PROVIDER: Record<string, string> = { meta: 'Meta', tiktok: 'TikTok', shopify: 'Shopify' };
const clip = (s: string, n = 90) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** A change in words, and where to look at it; null when its subject no longer exists (or isn't this workspace's). */
export function describeChange(e: ChangeEvent, s: ChangeSubjects, slug: string): { text: string; href: string | null; state: string | null } | null {
  const base = `/w/${slug}`;
  const experiment = (id: string | null | undefined) => (id ? s.experiments.get(id) : undefined);
  // A test in results reads on Results; one still being made lives in Studio.
  const testHref = (id: string, state: string) => (STUDIO_STATES.has(state) ? `${base}/studio/${id}` : `${base}/results/${id}`);
  switch (e.type) {
    case 'CONFIDENCE_CHANGED':
    case 'EXPERIMENT_CONFOUNDED': {
      const x = experiment(e.subjectId);
      if (!x || !e.subjectId) return null;
      const what = e.type === 'CONFIDENCE_CHANGED' ? 'Confidence changed' : 'Marked confounded — something outside the test moved the numbers';
      return { text: `${what}: “${clip(x.hypothesis)}”${x.sku ? ` · ${x.sku}` : ''}`, href: testHref(e.subjectId, x.state), state: e.type === 'CONFIDENCE_CHANGED' ? (e.payload?.to ?? null) : null };
    }
    case 'LEARNING_CREATED':
    case 'LEARNING_WEAKENED':
    case 'LEARNING_INVALIDATED': {
      const l = e.subjectId ? s.learnings.get(e.subjectId) : undefined;
      if (!l) return null;
      const what = e.type === 'LEARNING_CREATED' ? 'New learning' : e.type === 'LEARNING_WEAKENED' ? 'Learning weakened' : 'Learning no longer holds';
      const exp = e.refs?.experimentId;
      return { text: `${what}: “${clip(l.statement)}”${l.sku ? ` · ${l.sku}` : ''}`, href: exp && s.experiments.has(exp) ? `${base}/results/${exp}` : `${base}/map`, state: null };
    }
    case 'INTEGRATION_DEGRADED':
    case 'INTEGRATION_DISCONNECTED': {
      const i = e.subjectId ? s.integrations.get(e.subjectId) : undefined;
      const provider = PROVIDER[i?.provider ?? e.payload?.provider ?? ''] ?? i?.provider ?? e.payload?.provider ?? 'A connection';
      const name = i?.name ? ` (${i.name})` : '';
      return { text: e.type === 'INTEGRATION_DEGRADED' ? `${provider}${name} needs attention — results may be incomplete` : `${provider}${name} was disconnected`, href: `${base}/settings/integrations`, state: null };
    }
    default:
      return null;
  }
}
