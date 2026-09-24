import { DomainError, PLANS, type PlanCode } from '@arkiv/shared';

/**
 * Incident banner (plan 05 §22 "publish an incident banner to all tenants or a subset, e.g. 'TikTok sync
 * delayed'"). Stored in platform setting `status.banner`; each app page decides whether it applies to the workspace
 * being viewed.
 */
export type BannerAudience =
  | { kind: 'all' }
  | { kind: 'plans'; plans: (PlanCode | 'FREE')[] }
  | { kind: 'integration'; provider: 'shopify' | 'meta' | 'tiktok' }
  | { kind: 'workspaces'; ids: string[] };

export interface StatusBannerValue {
  text: string;
  tone: 'info' | 'warn' | 'risk';
  at?: string;
  /** Missing = everyone (banners published before audiences existed). */
  audience?: BannerAudience;
}

export interface BannerViewer {
  workspaceId: string;
  planCode: string | null;
  /** Connected providers (not disconnected). */
  providers: string[];
}

/** Does the banner show here? Pages outside a workspace (the funnel) only show banners for everyone. */
export function bannerApplies(b: StatusBannerValue | null | undefined, viewer: BannerViewer | null): boolean {
  if (!b?.text) return false;
  const a = b.audience ?? { kind: 'all' };
  if (a.kind === 'all') return true;
  if (!viewer) return false;
  if (a.kind === 'plans') return a.plans.includes((viewer.planCode ?? 'FREE') as PlanCode | 'FREE');
  if (a.kind === 'integration') return viewer.providers.includes(a.provider);
  return a.ids.includes(viewer.workspaceId);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Build the audience from the console form's fields (comma lists), validating each value. */
export function parseBannerAudience(input: { audience: 'all' | 'plans' | 'integration' | 'workspaces'; plans?: string; provider?: string; workspaceIds?: string }): BannerAudience {
  const list = (s: string | undefined) => (s ?? '').split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
  switch (input.audience) {
    case 'all':
      return { kind: 'all' };
    case 'plans': {
      const plans = [...new Set(list(input.plans).map((p) => p.toUpperCase()))];
      const known = [...Object.keys(PLANS), 'FREE'];
      const bad = plans.filter((p) => !known.includes(p));
      if (!plans.length || bad.length) throw new DomainError('INVALID', `Plans must be some of ${known.join(', ')}.`);
      return { kind: 'plans', plans: plans as (PlanCode | 'FREE')[] };
    }
    case 'integration': {
      const p = (input.provider ?? '').toLowerCase();
      if (p !== 'shopify' && p !== 'meta' && p !== 'tiktok') throw new DomainError('INVALID', 'Choose shopify, meta or tiktok.');
      return { kind: 'integration', provider: p };
    }
    case 'workspaces': {
      const ids = [...new Set(list(input.workspaceIds))];
      if (!ids.length || ids.some((x) => !UUID.test(x))) throw new DomainError('INVALID', 'List workspace ids (UUIDs), separated by commas.');
      if (ids.length > 500) throw new DomainError('INVALID', 'At most 500 workspaces.');
      return { kind: 'workspaces', ids };
    }
  }
}

export function describeAudience(a: BannerAudience | undefined): string {
  if (!a || a.kind === 'all') return 'all tenants';
  if (a.kind === 'plans') return `plans ${a.plans.join(', ')}`;
  if (a.kind === 'integration') return `workspaces with ${a.provider} connected`;
  return `${a.ids.length} workspace${a.ids.length === 1 ? '' : 's'}`;
}
