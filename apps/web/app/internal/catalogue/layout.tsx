import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import type { ReactNode } from 'react';
import { env } from '@arkiv/shared';
import { catalogueEnabled } from '@/lib/catalogue';

export const metadata: Metadata = { title: 'Catalogue', robots: { index: false, follow: false } };

/** Design-system catalogue (design §3): a dev tool, not a product surface — hidden in production unless enabled. */
export default async function CatalogueLayout({ children }: { children: ReactNode }) {
  await connection(); // CATALOGUE_ENABLED is runtime configuration, not baked in at build time
  if (!catalogueEnabled(env())) notFound();
  return children;
}
