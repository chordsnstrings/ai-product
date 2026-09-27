import type { Metadata } from 'next';
import { withTenant } from '@arkiv/db';
import { Empty, IndexRow, LinkButton } from '@arkiv/ui';
import { workspacePage } from '@/lib/tenant';

export const metadata: Metadata = { title: 'Products' };

export default async function Products({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const w = await workspacePage(slug);
  const skus = await withTenant(w.ctx.workspaceId, (tx) => tx`
    select s.id, s.name, s.catalogue_no, s.status, s.maturity,
      (select count(*) from experiments e where e.sku_id = s.id)::int as tests,
      (select count(*) from claims c where c.sku_id = s.id and c.status in ('VERIFIED','VERIFIED_WITH_QUALIFIER'))::int as claims
    from skus s order by s.catalogue_no`);
  return (
    <>
      <div className="ak-between"><h1 className="ak-h1" style={{ margin: 0 }}>Products</h1><LinkButton href="/start" size="sm">Add a product</LinkButton></div>
      {skus.length === 0 ? (
        <Empty title="No products yet" body="Paste a product link or add a photo to catalogue your first product." action={<LinkButton href="/start">Add a product</LinkButton>} />
      ) : (
        <div style={{ marginTop: 24 }}>
          {skus.map((s) => (
            <IndexRow
              key={s.id as string}
              index={`No. ${String(s.catalogue_no).padStart(3, '0')}`}
              title={s.name as string}
              meta={s.status === 'active' ? `${s.tests} tests · ${s.claims} approved claims · ${String(s.maturity ?? 'COLD').toLowerCase()}` : String(s.status)}
              href={`/w/${slug}/products/${s.id}`}
            />
          ))}
        </div>
      )}
    </>
  );
}
