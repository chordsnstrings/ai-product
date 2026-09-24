import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { MAGIC_LINK_TTL_MIN, providerEnabled } from '@arkiv/auth';
import { currentUser } from '@/lib/session';
import { LoginForm } from './login-form';

export const metadata: Metadata = { title: 'Log in · Arkiv', robots: { index: false } };

export default async function Page({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  const sp = await searchParams;
  const next = sp.next && sp.next.startsWith('/') && !sp.next.startsWith('//') ? sp.next : null;
  if (await currentUser()) redirect(next ?? '/app');
  return (
    <div className="ak-wrap ak-section" style={{ maxWidth: 440 }}>
      <h1 className="ak-h1">Log in</h1>
      <p className="ak-muted">No password. We’ll email you a link, or use Google, Apple or a passkey.</p>
      <LoginForm next={next} error={sp.error ?? null} google={providerEnabled('google')} apple={providerEnabled('apple')} ttlMinutes={MAGIC_LINK_TTL_MIN} />
    </div>
  );
}
