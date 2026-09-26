import type { Tx } from '@arkiv/db';
import { DomainError } from '@arkiv/shared';
import type { Proposal } from './intel-schemas';
import type { RateMetric } from './statistics';

/**
 * Experiment design (§20, §38): the variable an experiment compares, CONTROLLED vs EXPLORATORY, what a controlled
 * test holds constant, the metrics it is judged on, and the controlled-variable schema the server validates.
 */

/** Dimensions a CONTROLLED experiment keeps stable, before its primary variable is taken out. */
export const HELD_DEFAULT = ['body', 'offer', 'cta', 'product', 'duration'] as const;

/** A CONTROLLED experiment holds every default dimension except the one it tests (§20); an EXPLORATORY one holds none. */
export const heldConstant = (mode: 'CONTROLLED' | 'EXPLORATORY', primaryVariable: string): string[] => (mode === 'CONTROLLED' ? HELD_DEFAULT.filter((v) => v !== primaryVariable) : []);

/**
 * The variable an experiment compares: without the merchant's current ad as a control only the hook differs
 * between the variants (the master and its hook variants), so the hook is what the test isolates.
 */
export const experimentPrimaryVariable = (p: Pick<Proposal, 'primaryVariable'>, controlCreativeId?: string | null) => (controlCreativeId ? p.primaryVariable : 'hook');

/**
 * CONTROLLED vs EXPLORATORY (§20), for a proposal before it is an experiment (recommendation cards, plan 03 A1) and
 * when it becomes one: a hook test, or any test against the merchant's current ad, changes one thing — unless the
 * proposal itself is exploratory.
 */
export function modeFor(p: Pick<Proposal, 'primaryVariable' | 'riskProfile'>, controlCreativeId?: string | null): 'CONTROLLED' | 'EXPLORATORY' {
  const controlled = p.primaryVariable === 'hook' || !!controlCreativeId;
  return controlled && p.riskProfile !== 'exploratory' ? 'CONTROLLED' : 'EXPLORATORY';
}

/**
 * The metric an experiment is judged on and the leading metrics read beside it (§20 primary_metric,
 * leading_metrics[]): an opening is judged on whether people keep watching, an offer or proof on whether they buy,
 * an angle, format, pacing or talent on whether they click. CPA / ROAS are computed for every test (§21).
 */
export function metricsFor(primaryVariable: string): { primary: RateMetric; leading: RateMetric[] } {
  if (primaryVariable === 'hook') return { primary: 'hold_rate', leading: ['ctr', 'cvr'] };
  if (primaryVariable === 'offer' || primaryVariable === 'proof') return { primary: 'cvr', leading: ['ctr', 'hold_rate'] };
  return { primary: 'ctr', leading: ['hold_rate', 'cvr'] };
}

const RATE_METRICS: readonly RateMetric[] = ['ctr', 'hold_rate', 'cvr'];

/** The rate metrics computeResults reads for an experiment: its primary metric first, then its leading metrics. */
export function experimentMetrics(e: { primary_metric?: unknown; leading_metrics?: unknown }): RateMetric[] {
  const primary = RATE_METRICS.includes(e.primary_metric as RateMetric) ? (e.primary_metric as RateMetric) : 'ctr';
  const leading = (Array.isArray(e.leading_metrics) ? (e.leading_metrics as string[]) : []).filter((m): m is RateMetric => RATE_METRICS.includes(m as RateMetric));
  return [...new Set([primary, ...leading])];
}

export interface DesignVariant {
  id: string;
  role: string;
  changed_variables: string[] | null;
}

/**
 * The controlled-variable schema (§38 "Server validates controlled-variable schema and gates"; §20): a CONTROLLED
 * experiment holds its dimensions constant and never its own primary variable; the master changes nothing but the
 * primary variable, hook variants nothing but the opening; a control changes nothing; a named control is one of
 * the experiment's control variants. Returns the problems (empty when the design is sound).
 */
export function validateExperimentDesign(
  e: { mode: string; primary_variable: string; controlled_variables: string[] | null; control_variant_id: string | null },
  variants: readonly DesignVariant[],
): string[] {
  const problems: string[] = [];
  if (e.control_variant_id && !variants.some((v) => v.id === e.control_variant_id && v.role === 'control')) problems.push('the control variant is not one of this test’s controls');
  if (variants.some((v) => v.role === 'control' && (v.changed_variables ?? []).length)) problems.push('a control changes nothing');
  if (e.mode !== 'CONTROLLED') return problems;
  const held = e.controlled_variables ?? [];
  if (held.includes(e.primary_variable)) problems.push(`the tested variable (${e.primary_variable}) can’t also be held constant`);
  const allowed = new Set([e.primary_variable, 'hook']);
  for (const v of variants.filter((x) => x.role !== 'control')) {
    const changed = v.changed_variables ?? [];
    const bad = changed.filter((c) => !allowed.has(c) || held.includes(c));
    if (bad.length) problems.push(`a variant changes ${bad.join(', ')}, which this controlled test keeps the same`);
  }
  if (variants.filter((v) => v.role !== 'control').length < 2 && !e.control_variant_id) problems.push('a controlled test needs at least two variants to compare');
  return problems;
}

/** Validate an experiment's stored design; a CONTROLLED design that no longer holds is refused (CONFLICT). */
export async function assertExperimentDesign(tx: Tx, experimentId: string): Promise<void> {
  const [e] = await tx`select mode, primary_variable, controlled_variables, control_variant_id from experiments where id = ${experimentId}`;
  if (!e) throw new DomainError('NOT_FOUND', 'Experiment not found');
  const variants = (await tx`select id, role, changed_variables from variants where experiment_id = ${experimentId}`) as unknown as DesignVariant[];
  const problems = validateExperimentDesign(e as never, variants);
  if (problems.length) throw new DomainError('CONFLICT', `This test’s design isn’t valid: ${problems.join('; ')}.`, { problems });
}
