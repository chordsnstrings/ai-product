import type { Metadata } from 'next';
import { withTenant } from '@arkiv/db';
import { projectAccess, workspaceBySlug } from './tenant';

/**
 * Page titles that name the item on the page (WCAG 2.4.2 Page Titled; plan 06 Phase 6 #1). Next's route announcer
 * reads document.title on navigation and speaks only when it changes, so two products must not share one title.
 * The root layout adds " · Arkiv"; these never do. The lookups run with the viewer's own access (membership or
 * the preview cookie): someone without access gets the generic label, never a name.
 */
export const itemTitle = (item: string | null | undefined, label: string) => (item ? `${item} · ${label}` : label);

/** A funnel page's title: the product's name, for whoever may open the project. */
export async function projectTitle(projectId: string, label: string, extra: Metadata = {}): Promise<Metadata> {
  let name: string | null = null;
  try {
    const a = await projectAccess(projectId, { probe: false });
    const [r] = await withTenant(a.ctx.workspaceId, (tx) => tx`select s.name from projects p join skus s on s.id = p.sku_id where p.id = ${projectId}`);
    name = (r?.name as string) ?? null;
  } catch {
    /* no access: the generic title */
  }
  return { ...extra, title: itemTitle(name, label) };
}

/** A workspace page about one product (Product Brain, Claims, review). */
export async function skuTitle(slug: string, skuId: string, label: string): Promise<Metadata> {
  let name: string | null = null;
  if (/^[0-9a-f-]{36}$/i.test(skuId)) {
    try {
      const w = await workspaceBySlug(slug, { probe: false });
      const [r] = await withTenant(w.ctx.workspaceId, (tx) => tx`select name from skus where id = ${skuId}`);
      name = (r?.name as string) ?? null;
    } catch {
      /* no access */
    }
  }
  return { title: itemTitle(name, label) };
}

/** A workspace page about one experiment (Studio, results): its product and variant code prefix. */
export async function experimentTitle(slug: string, experimentId: string, label: string): Promise<Metadata> {
  let name: string | null = null;
  if (/^[0-9a-f-]{36}$/i.test(experimentId)) {
    try {
      const w = await workspaceBySlug(slug, { probe: false });
      const [r] = await withTenant(w.ctx.workspaceId, (tx) => tx`select s.name, e.hypothesis from experiments e join skus s on s.id = e.sku_id where e.id = ${experimentId}`);
      if (r) name = `${r.name as string} — ${truncate(String(r.hypothesis ?? ''), 50)}`.replace(/ — $/, '');
    } catch {
      /* no access */
    }
  }
  return { title: itemTitle(name, label) };
}

const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
