import type { Metadata } from 'next';
import Link from 'next/link';
import { withTenant } from '@arkiv/db';
import { Empty, SignalChip } from '@arkiv/ui';
import { formatDate } from '@arkiv/shared/format';
import { workspacePage } from '@/lib/tenant';

export const metadata: Metadata = { title: 'Studio' };

/** Tests the Studio works on (standard §12 "Studio", plan 03 A3): approved and producing, ready to run, and live. */
const STUDIO_STATES = ['APPROVED', 'PRODUCING', 'READY_TO_RUN', 'GATHERING_SIGNAL', 'DIRECTIONAL'] as const;
const STATE_WORDS: Record<string, string> = {
  APPROVED: 'Approved · storyboard',
  PRODUCING: 'Producing',
  READY_TO_RUN: 'Ready to launch',
  GATHERING_SIGNAL: 'Live · gathering signal',
  DIRECTIONAL: 'Live · directional',
};

export default async function StudioIndex({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const w = await workspacePage(slug);
  const exps = await withTenant(w.ctx.workspaceId, (tx) => tx`
    select e.id, e.hypothesis, e.state, e.mode, e.updated_at, s.name, s.catalogue_no,
           (select count(*)::int from variants v where v.experiment_id = e.id and v.workspace_id = e.workspace_id) as variants
    from experiments e join skus s on s.id = e.sku_id
    where e.state in ${tx([...STUDIO_STATES])}
    order by array_position(${[...STUDIO_STATES]}::text[], e.state::text), e.updated_at desc
    limit 100`);
  return (
    <>
      <h1 className="ak-h1">Studio</h1>
      <p className="ak-small ak-muted" style={{ maxWidth: 640 }}>Tests you’ve approved: storyboards to finish, ads in production, variants ready to launch and tests running now.</p>
      {exps.length === 0 ? (
        <Empty title="Nothing in the Studio yet" body="Approve a recommendation on This Week and its storyboard opens here." />
      ) : (
        <div style={{ marginTop: 24 }}>
          {exps.map((e) => (
            <Link key={e.id as string} href={`/w/${slug}/studio/${e.id}`} className="ak-index-row">
              <span>
                {e.hypothesis as string}
                <span className="ak-small ak-muted" style={{ display: 'block' }}>
                  No. {String(e.catalogue_no).padStart(3, '0')} {e.name as string} · {e.mode === 'EXPLORATORY' ? 'Exploratory' : 'Controlled'} · {e.variants as number} variant{e.variants === 1 ? '' : 's'} · updated {formatDate(e.updated_at as string)}
                </span>
              </span>
              <span className="ak-index">
                {['GATHERING_SIGNAL', 'DIRECTIONAL'].includes(e.state as string) ? <SignalChip state={String(e.state)} /> : STATE_WORDS[e.state as string]}
              </span>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
