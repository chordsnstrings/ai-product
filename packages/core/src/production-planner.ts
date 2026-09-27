import type { ProductionMode } from '@arkiv/shared';

/**
 * Production Planner (standard §23 "chooses the medium scene by scene"; plan 06 Phase 3 #2): the Creative Director
 * proposes a mode per scene; the planner decides it from what is true about this product and this plan, and records
 * why, so the merchant sees the final medium of every scene before approving (§13) and no scene is silently
 * downgraded later (§48).
 *
 * Rules, in order:
 *  1. Packaging, label, reveal and CTA shots → strict product composite (the exact product; §23).
 *  2. A generated interaction the video model can't be trusted with → strict composite when the packaging is
 *     transparent or reflective and there are too few reference views (§44), a hybrid when the beat is longer than a
 *     short interaction (≤ 6 s, §23 "short scenes") or the video partner is unavailable.
 *  3. Modes this pipeline cannot make (a remix of merchant footage, a creator pack) → hybrid (generated setting with
 *     the exact product), with the reason.
 *  4. Over the class cost ceiling (§5, §6) → the lowest-priority generated interactions become hybrids, one at a
 *     time, each with the reason, until the plan fits.
 */

export interface PlannerScene {
  purpose: string;
  durationMs: number;
  productionMode: string;
}

export interface PlannerFacts {
  /** visual_fingerprints.transparency ('transparent', 'translucent', 'reflective', 'opaque' or null). */
  transparency: string | null;
  /** How many reference views of the product the fingerprint holds. */
  referenceViews: number;
  /** Whether the product's cut-out keyed cleanly (a hybrid or composite shows the exact product). */
  keyedCutout: boolean;
  /** Whether the video route (or its approved fallback) can take work now. */
  videoAvailable: boolean;
  /** Rights-attested footage of the product that a remix may use. */
  remixFootage: boolean;
}

export interface PlannedScene {
  mode: ProductionMode;
  reason: string;
}

/** Longest beat planned as a generated interaction (§23 "stronger QA and short scenes"). */
export const MAX_INTERACTION_MS = 6000;
/** Reference views a transparent or reflective package needs before a video model may render it (§44). */
export const MIN_VIEWS_FOR_TRANSPARENT = 3;

const PACKAGING_PURPOSES = new Set(['product_reveal', 'cta', 'label', 'packaging']);
/** Which generated interactions to keep when the plan must shed cost: the demonstration first, the hook last. */
const KEEP_PRIORITY: Record<string, number> = { demonstration: 4, application: 4, texture: 3, proof: 2, problem: 1, hook: 0 };
const HARD_TO_RENDER = new Set(['transparent', 'translucent', 'reflective']);

/** The planner's mode and reason for each scene (before the cost ceiling). */
export function planSceneModes(scenes: readonly PlannerScene[], f: PlannerFacts): PlannedScene[] {
  return scenes.map((s) => {
    if (PACKAGING_PURPOSES.has(s.purpose)) return { mode: 'STRICT_COMPOSITE', reason: 'Packaging and call-to-action shots always use your exact product.' };
    const asked = s.productionMode as ProductionMode;
    if (asked === 'GENERATIVE_INTERACTION') {
      if (f.transparency && HARD_TO_RENDER.has(f.transparency) && f.referenceViews < MIN_VIEWS_FOR_TRANSPARENT) {
        return { mode: 'STRICT_COMPOSITE', reason: `Your ${f.transparency} packaging is hard for video models to keep exact, so this shot uses your exact product. Add more product views to allow a generated interaction.` };
      }
      if (s.durationMs > MAX_INTERACTION_MS) return hybrid(f, `Generated interactions are kept to short beats (${MAX_INTERACTION_MS / 1000}s or less); this longer shot is a generated setting with your exact product.`);
      if (!f.videoAvailable) return hybrid(f, 'Our video partner is unavailable right now, so this shot is a generated setting with your exact product.');
      return { mode: 'GENERATIVE_INTERACTION', reason: 'A short hands-on moment, generated and checked against your product photos.' };
    }
    // Remixing merchant footage is a production path of its own (not made by this pipeline yet): until then a
    // proposed remix is planned as a hybrid, and the merchant is told why rather than getting a silent still.
    if (asked === 'REAL_ASSET_REMIX') {
      return hybrid(f, f.remixFootage ? 'Remixing your own footage isn’t available in this ad yet, so this shot is a generated setting with your exact product.' : 'There is no rights-cleared footage of this product to remix, so this shot is a generated setting with your exact product.');
    }
    if (asked === 'CREATOR_PACK') return hybrid(f, 'Creator footage comes from a Creator Pack; in this ad the shot is a generated setting with your exact product.');
    if (asked === 'HYBRID') return hybrid(f, 'A generated setting with your exact product placed in it.');
    if (asked === 'STRICT_COMPOSITE') return { mode: 'STRICT_COMPOSITE', reason: 'Your exact product, composited.' };
    return hybrid(f, 'A generated setting with your exact product placed in it.');
  });
}

/** A hybrid (without a clean cut-out the storyboard draws it as the exact-product frame, never a generated product). */
function hybrid(f: PlannerFacts, reason: string): PlannedScene {
  return { mode: 'HYBRID', reason: f.keyedCutout ? reason : `${reason} Your product photo couldn’t be cut out cleanly, so the shot shows the photo itself.` };
}

/**
 * Fit the plan under a cost ceiling: while `estimate` of the plan exceeds it, the lowest-priority generated
 * interaction becomes a hybrid, with the reason recorded. Returns the (possibly changed) plan.
 */
export function fitCeiling(scenes: readonly PlannerScene[], planned: PlannedScene[], estimate: (modes: readonly ProductionMode[]) => number, ceilingMicros: number | null, f: PlannerFacts): PlannedScene[] {
  const out = planned.map((p) => ({ ...p }));
  if (ceilingMicros == null) return out;
  for (;;) {
    if (estimate(out.map((p) => p.mode)) <= ceilingMicros) return out;
    const candidates = out
      .map((p, i) => ({ p, i, keep: KEEP_PRIORITY[scenes[i]!.purpose] ?? 2 }))
      .filter((c) => c.p.mode === 'GENERATIVE_INTERACTION')
      .sort((a, b) => a.keep - b.keep || b.i - a.i);
    const drop = candidates[0];
    if (!drop) return out; // nothing left to shed: the Cost Governor refuses the plan at approval, loudly
    out[drop.i] = hybrid(f, 'To keep this ad within its cost limit, this shot is a generated setting with your exact product instead of generated motion.');
  }
}
