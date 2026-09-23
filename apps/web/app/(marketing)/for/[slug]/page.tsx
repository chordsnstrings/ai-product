import { Landing } from '../../landing';

export const dynamic = 'force-dynamic';

export default async function CampaignPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { slug } = await params;
  return <Landing slug={slug} searchParams={await searchParams} />;
}
