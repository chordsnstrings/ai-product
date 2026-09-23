import { z } from 'zod';
import { withTenant } from '@arkiv/db';
import { editScene, regenerateFrame, setSceneLock } from '@arkiv/core';
import { DomainError } from '@arkiv/shared';
import { body, json, route } from '@/lib/http';
import { projectAccess } from '@/lib/tenant';

/** Scene edits (plan 03 P7/A3): text edits are free and claim-checked; frame changes are limited; locks protect scenes. */
export const POST = route(async (req, { params }: { params: Promise<{ id: string; action: string }> }) => {
  const { id, action } = await params;
  const input = await body(req, z.object({ projectId: z.string().uuid(), spokenLine: z.string().max(160).nullish(), overlayText: z.string().max(70).nullish(), locked: z.boolean().optional(), instruction: z.string().max(200).optional() }));
  const a = await projectAccess(input.projectId);
  if (a.provisional) throw new DomainError('FORBIDDEN', 'Save your work to edit the storyboard.', { needsAccount: true });
  // The scene must belong to this project's storyboard (checked under RLS).
  const [owned] = await withTenant(a.ctx.workspaceId, (tx) => tx`select 1 from scenes s join storyboards sb on sb.id = s.storyboard_id where s.id = ${id} and sb.project_id = ${input.projectId}`);
  if (!owned) throw new DomainError('NOT_FOUND', 'Scene not found');
  switch (action) {
    case 'edit':
      return json(await withTenant(a.ctx.workspaceId, (tx) => editScene(tx, a.ctx, id, { spokenLine: input.spokenLine, overlayText: input.overlayText })));
    case 'lock':
      await withTenant(a.ctx.workspaceId, (tx) => setSceneLock(tx, a.ctx, id, !!input.locked));
      return json({ ok: true });
    case 'regenerate':
      if (!input.instruction?.trim()) throw new DomainError('INVALID', 'Describe the change you want.');
      return json(await regenerateFrame(a.ctx, id, input.instruction));
    default:
      throw new DomainError('NOT_FOUND', 'Unknown action');
  }
});
