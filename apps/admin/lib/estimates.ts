import { withAdmin } from '@arkiv/db';
import { COST_LIMITS } from '@arkiv/shared';
import { estimate, loadRates, planProduction, productionEstimate, productionRoutes, type RateTable } from '@arkiv/core';

/** A representative standard 15s test: 2 generative scenes of 4s, ~300 chars of voiceover (plan 05 §9 impact preview). */
const STANDARD_SCENES = [
  { id: 'a', production_mode: 'GENERATIVE_INTERACTION', duration_ms: 4000, purpose: 'hook' },
  { id: 'b', production_mode: 'STRICT_COMPOSITE', duration_ms: 3000, purpose: 'product_reveal' },
  { id: 'c', production_mode: 'GENERATIVE_INTERACTION', duration_ms: 4000, purpose: 'demonstration' },
  { id: 'd', production_mode: 'STRICT_COMPOSITE', duration_ms: 4000, purpose: 'cta' },
];

/**
 * What a production retry would authorise at today's rates and routes (plan 05 §12: a retry that can spend shows
 * the fresh Cost Governor estimate to the operator), reusing accepted renders. Null when the plan can't be priced.
 */
export async function estimateProjectRetry(workspaceId: string, projectId: string): Promise<number | null> {
  return withAdmin(async (tx) => {
    try {
      return await productionEstimate(tx, workspaceId, projectId);
    } catch {
      return null;
    }
  });
}

/** Estimate on the stable routes at the published rates, or with one draft rate table swapped in. */
export async function estimateStandardTest(draftId: string | 'published'): Promise<number> {
  return withAdmin(async (tx) => {
    const rates = await loadRates(tx);
    if (draftId !== 'published') {
      const [d] = await tx`select provider, model, version, unit, rates from provider_rate_tables where id = ${draftId}`;
      if (d) rates.set(`${d.provider}/${d.model}`, d as unknown as RateTable);
    }
    try {
      const routes = await productionRoutes(tx, null);
      return estimate(rates, planProduction(STANDARD_SCENES as never, 300, routes, rates, { plates: 1, ceilingMicros: COST_LIMITS.CREATIVE_TEST_CEILING }).lines).totalMicros;
    } catch {
      return NaN;
    }
  });
}
