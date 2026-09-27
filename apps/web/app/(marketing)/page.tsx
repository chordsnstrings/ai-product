import { Landing } from './landing';

export const dynamic = 'force-dynamic';

export default async function Home({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return <Landing slug="default" searchParams={await searchParams} />;
}
