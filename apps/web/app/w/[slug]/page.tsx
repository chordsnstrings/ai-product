import { redirect } from 'next/navigation';

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  redirect(`/w/${(await params).slug}/this-week`);
}
