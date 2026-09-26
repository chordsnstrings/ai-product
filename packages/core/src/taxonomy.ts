import { withSystem, type Tx } from '@arkiv/db';
import { DomainError, Taxonomy } from '@arkiv/shared';
import { audit, type Staff } from './admin';

/**
 * Creative Genome taxonomy governance (plan 05 §19, standard Appendix A): values are added, renamed or deprecated
 * only through a proposal a second staff member reviews. An approved proposal becomes a new taxonomy version holding
 * the full canonical families, and its migration plan (a rename, or a deprecation into a replacement) is applied to
 * existing genomes by the worker. Free-text tags never become canonical silently.
 */

export const TAXONOMY_FAMILIES = ['angle', 'hook', 'proof', 'treatment'] as const;
export type TaxonomyFamily = (typeof TAXONOMY_FAMILIES)[number];

export interface CanonicalTaxonomy {
  version: number;
  families: Record<TaxonomyFamily, string[]>;
  /** Values no longer offered for new work (kept on history). */
  deprecated: Record<TaxonomyFamily, string[]>;
}

const base = (): CanonicalTaxonomy => ({
  version: Taxonomy.version,
  families: { angle: [...Taxonomy.angle], hook: [...Taxonomy.hook], proof: [...Taxonomy.proof], treatment: [...Taxonomy.treatment] },
  deprecated: { angle: [], hook: [], proof: [], treatment: [] },
});

/** The canonical taxonomy: the latest version that records its families, else Appendix A (packages/shared enums). */
export async function canonicalTaxonomy(tx: Tx): Promise<CanonicalTaxonomy> {
  const [v] = await tx`select version, spec from taxonomy_versions where spec ? 'families' order by version desc limit 1`;
  if (!v) return base();
  const spec = v.spec as { families?: Record<string, unknown>; deprecated?: Record<string, unknown> };
  const list = (x: unknown, fallback: string[]) => (Array.isArray(x) && x.every((y) => typeof y === 'string') ? (x as string[]) : fallback);
  const b = base();
  return {
    version: Number(v.version),
    families: Object.fromEntries(TAXONOMY_FAMILIES.map((f) => [f, list(spec.families?.[f], b.families[f])])) as CanonicalTaxonomy['families'],
    deprecated: Object.fromEntries(TAXONOMY_FAMILIES.map((f) => [f, list(spec.deprecated?.[f], [])])) as CanonicalTaxonomy['deprecated'],
  };
}

export interface TaxonomyChange {
  family: TaxonomyFamily;
  op: 'add' | 'rename' | 'deprecate';
  value: string;
  /** rename: the new name; deprecate: the replacement existing genomes move to (optional). */
  to?: string | null;
}

const VALUE = /^[A-Z][A-Z0-9_]{1,60}$/;

/** Check a change against the current canonical taxonomy and return the taxonomy after it. */
export function applyTaxonomyChange(t: CanonicalTaxonomy, c: TaxonomyChange): CanonicalTaxonomy {
  const active = t.families[c.family];
  if (!TAXONOMY_FAMILIES.includes(c.family)) throw new DomainError('INVALID', 'Unknown family.');
  if (!VALUE.test(c.value) || (c.to && !VALUE.test(c.to))) throw new DomainError('INVALID', 'Values are UPPER_SNAKE_CASE, like TEXTURE_SENSORY.');
  const next: CanonicalTaxonomy = { version: t.version, families: { ...t.families, [c.family]: [...active] }, deprecated: { ...t.deprecated, [c.family]: [...t.deprecated[c.family]] } };
  const fam = next.families[c.family];
  const dep = next.deprecated[c.family];
  if (c.op === 'add') {
    if (active.includes(c.value)) throw new DomainError('CONFLICT', `${c.value} is already a ${c.family} value.`);
    fam.push(c.value);
    next.deprecated[c.family] = dep.filter((x) => x !== c.value);
  } else if (c.op === 'rename') {
    if (!active.includes(c.value)) throw new DomainError('CONFLICT', `${c.value} is not an active ${c.family} value.`);
    if (!c.to || active.includes(c.to)) throw new DomainError('CONFLICT', `Rename ${c.value} to a new name that isn't already a ${c.family} value.`);
    fam.splice(fam.indexOf(c.value), 1, c.to);
  } else {
    if (!active.includes(c.value)) throw new DomainError('CONFLICT', `${c.value} is not an active ${c.family} value.`);
    if (c.to && (c.to === c.value || !active.includes(c.to))) throw new DomainError('CONFLICT', `The replacement must be another active ${c.family} value.`);
    if (active.length <= 1) throw new DomainError('CONFLICT', `A family needs at least one value.`);
    fam.splice(fam.indexOf(c.value), 1);
    dep.push(c.value);
  }
  return next;
}

/** Existing genomes move from → to when the change is a rename or a deprecation with a replacement. */
export const remapOf = (c: TaxonomyChange): { from: string; to: string } | null => (c.op === 'rename' || (c.op === 'deprecate' && c.to) ? { from: c.value, to: c.to! } : null);

export async function proposeTaxonomyChange(tx: Tx, s: Staff, c: TaxonomyChange & { reason: string }): Promise<string> {
  if (c.reason.trim().length < 4) throw new DomainError('INVALID', 'A reason is required.');
  applyTaxonomyChange(await canonicalTaxonomy(tx), c); // validates against today's taxonomy
  const [p] = await tx`insert into taxonomy_proposals (family, op, value, to_value, reason, proposed_by)
                       values (${c.family}, ${c.op}, ${c.value}, ${c.to ?? null}, ${c.reason}, ${s.staffId}) returning id`;
  await audit(tx, s, 'taxonomy.propose', { type: 'taxonomy_proposal', id: p!.id as string }, { reason: c.reason, after: { family: c.family, op: c.op, value: c.value, to: c.to ?? null } });
  return p!.id as string;
}

/**
 * Approve or reject a proposal (a different staff member than the proposer). Approval records the new version and,
 * when genomes must move, queues the remap (ops command run by the worker).
 */
export async function reviewTaxonomyProposal(tx: Tx, s: Staff, id: string, approve: boolean, note: string): Promise<{ version: number | null; remap: boolean }> {
  const [p] = await tx`select * from taxonomy_proposals where id = ${id} for update`;
  if (!p) throw new DomainError('NOT_FOUND', 'Proposal not found');
  if (p.status !== 'proposed') throw new DomainError('CONFLICT', `Already ${p.status as string}.`);
  if (p.proposed_by === s.staffId) throw new DomainError('FORBIDDEN', 'A second staff member must review your proposal.');
  if (!approve) {
    await tx`update taxonomy_proposals set status = 'rejected', reviewed_by = ${s.staffId}, review_note = ${note}, reviewed_at = now() where id = ${id}`;
    await audit(tx, s, 'taxonomy.reject', { type: 'taxonomy_proposal', id }, { reason: note, before: { status: 'proposed' }, after: { status: 'rejected' } });
    return { version: null, remap: false };
  }
  const change: TaxonomyChange = { family: p.family as TaxonomyFamily, op: p.op as TaxonomyChange['op'], value: p.value as string, to: (p.to_value as string | null) ?? null };
  // Serialise version numbers: the latest version row is locked while the next one is written.
  await tx`select version from taxonomy_versions order by version desc limit 1 for update`;
  const next = applyTaxonomyChange(await canonicalTaxonomy(tx), change);
  const [v] = await tx`select coalesce(max(version), 0) + 1 as v from taxonomy_versions`;
  const version = Number(v!.v);
  const remap = remapOf(change);
  await tx`insert into taxonomy_versions (version, spec) values (${version}, ${tx.json({ families: next.families, deprecated: next.deprecated, change, remap: remap ? { family: change.family, ...remap } : null, proposalId: id, reason: p.reason, reviewNote: note } as never)})`;
  await tx`update taxonomy_proposals set status = 'approved', reviewed_by = ${s.staffId}, review_note = ${note}, reviewed_at = now(), version = ${version},
             remap_status = ${remap ? 'queued' : 'none'} where id = ${id}`;
  if (remap) {
    await tx`insert into ops_commands (kind, payload, requested_by, reason) values ('taxonomy.remap', ${tx.json({ proposalId: id })}, ${s.staffId}, ${`taxonomy v${version}: ${change.family} ${remap.from} → ${remap.to}`})`;
  }
  await audit(tx, s, 'taxonomy.approve', { type: 'taxonomy', id: String(version) }, { reason: note, before: { status: 'proposed' }, after: { status: 'approved', version, change, remap } });
  return { version, remap: !!remap };
}

/** Where each family's value lives in stored genes/genomes (the plain `hook` key holds hook text, not a taxonomy value). */
const FAMILY_KEYS: Record<TaxonomyFamily, string[]> = {
  angle: ['angle', 'secondaryAngle'],
  hook: ['hookMechanism'],
  proof: ['proofMechanism'],
  treatment: ['treatment'],
};
const GENE_COLUMNS: [string, string][] = [
  ['experiments', 'genes'],
  ['variants', 'genes'],
  ['creatives', 'genome'],
  ['learnings', 'relevant_genes'],
  ['learnings', 'winner_genes'],
  ['learnings', 'loser_genes'],
];

/**
 * Apply an approved proposal's migration plan to existing genomes across all workspaces (system role, worker). Each
 * workspace is updated in its own transaction with an explicit workspace filter, so a failure leaves the others
 * done and the command can be re-run (the update is idempotent). Returns rows changed per table.
 */
export async function applyTaxonomyRemap(proposalId: string): Promise<Record<string, number>> {
  const [p] = await withSystem((tx) => tx`select family, op, value, to_value, status from taxonomy_proposals where id = ${proposalId}`);
  if (!p || p.status !== 'approved') throw new Error('proposal is not approved');
  const remap = remapOf({ family: p.family as TaxonomyFamily, op: p.op as TaxonomyChange['op'], value: p.value as string, to: p.to_value as string | null });
  if (!remap) return {};
  const keys = FAMILY_KEYS[p.family as TaxonomyFamily];
  const counts: Record<string, number> = {};
  try {
    const workspaces = await withSystem((tx) => tx`select id from workspaces`);
    for (const w of workspaces) {
      await withSystem(async (tx) => {
        for (const [table, col] of GENE_COLUMNS) {
          for (const key of keys) {
            const r = await tx`update ${tx(table)} set ${tx(col)} = jsonb_set(${tx(col)}, ${[key]}::text[], to_jsonb(${remap.to}::text))
                               where workspace_id = ${w.id as string} and ${tx(col)} ->> ${key} = ${remap.from}`;
            counts[`${table}.${col}`] = (counts[`${table}.${col}`] ?? 0) + r.count;
          }
        }
      });
    }
    await withSystem((tx) => tx`update taxonomy_proposals set remap_status = 'done', remap_result = ${tx.json(counts)} where id = ${proposalId}`);
    return counts;
  } catch (e) {
    await withSystem((tx) => tx`update taxonomy_proposals set remap_status = 'failed', remap_result = ${tx.json({ ...counts, error: (e as Error).message.slice(0, 300) })} where id = ${proposalId}`);
    throw e;
  }
}

/** Map a model's output onto the canonical taxonomy: renamed/deprecated values follow the recorded remaps. */
export async function taxonomyRemaps(tx: Tx): Promise<Record<TaxonomyFamily, Record<string, string>>> {
  const out: Record<TaxonomyFamily, Record<string, string>> = { angle: {}, hook: {}, proof: {}, treatment: {} };
  const rows = await tx`select spec->'remap' as remap from taxonomy_versions where spec->'remap' is not null and jsonb_typeof(spec->'remap') = 'object' order by version`;
  for (const r of rows) {
    const m = r.remap as { family: TaxonomyFamily; from: string; to: string };
    if (!out[m.family]) continue;
    for (const [k, v] of Object.entries(out[m.family])) if (v === m.from) out[m.family][k] = m.to; // chain earlier remaps
    out[m.family][m.from] = m.to;
  }
  return out;
}
