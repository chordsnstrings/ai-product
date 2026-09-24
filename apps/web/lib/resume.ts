import { withTenant } from '@arkiv/db';
import { resolveProvisional } from '@arkiv/core';
import { projectRoute } from './project-route';
import { currentUser, provisionalToken } from './session';

export interface Resume {
  signedIn: boolean;
  /** "Continue with <product>" for a returning visitor with a preview in progress (plan 03 P1 / L18). */
  continue: { name: string; href: string } | null;
}

/** The latest product of a workspace and the page for its project's state, read with that workspace's own access. */
export async function latestProject(workspaceId: string): Promise<Resume['continue']> {
  const [p] = await withTenant(workspaceId, (tx) => tx`select p.id, p.state, p.entitlement_unit, s.name from projects p join skus s on s.id = p.sku_id
                                                        where s.status <> 'rejected' order by p.updated_at desc limit 1`);
  return p ? { name: p.name as string, href: projectRoute(p.state as string, p.id as string, { entitlementUnit: (p.entitlement_unit as string | null) ?? null }) } : null;
}

/**
 * What the landing hero shows this visitor (plan 03 P1 states): a signed-in user gets "Go to your archive" + "Add a
 * product"; a returning visitor whose preview cookie still opens a product gets "Continue with <product>" (P3 edge:
 * "Resume is available on return"); everyone else the upload module. Only the visitor's own preview is read.
 */
export async function resumeForVisitor(): Promise<Resume> {
  if (await currentUser()) return { signedIn: true, continue: null };
  const ws = await resolveProvisional(await provisionalToken());
  return { signedIn: false, continue: ws ? await latestProject(ws) : null };
}
