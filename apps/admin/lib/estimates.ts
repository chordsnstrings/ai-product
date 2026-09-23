import { withAdmin } from '@arkiv/db';
import { estimate, loadRates, planProduction, type RateTable } from '@arkiv/core';

/** A representative standard 15s test: 2 generative scenes of 4s, ~300 chars of voiceover (plan 05 §9 impact preview). */
const STANDARD_SCENES = [
  { id: 'a', production_mode: 'GENERATIVE_INTERACTION', duration_ms: 4000, purpose: 'hook' },
  { id: 'b', production_mode: 'COMPOSITED_PRODUCT', duration_ms: 3000, purpose: 'product_reveal' },
  { id: 'c', production_mode: 'GENERATIVE_INTERACTION', duration_ms: 4000, purpose: 'demonstration' },
  { id: 'd', production_mode: 'MOTION_GRAPHIC', duration_ms: 4000, purpose: 'cta' },
];

/** Estimate at the published rates, or with one draft rate table swapped in. */
export async function estimateStandardTest(draftId: string | 'published'): Promise<number> {
  return withAdmin(async (tx) => {
    const rates = await loadRates(tx);
    if (draftId !== 'published') {
      const [d] = await tx`select provider, model, version, unit, rates from provider_rate_tables where id = ${draftId}`;
      if (d) rates.set(`${d.provider}/${d.model}`, d as unknown as RateTable);
    }
    try {
      return estimate(rates, planProduction(STANDARD_SCENES as never, 300).lines).totalMicros;
    } catch {
      return NaN;
    }
  });
}
