import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { loginChallengeSiteKey, providerEnabled, safeRedirect } from '@arkiv/auth';
import { MAGIC_LINK_TTL_MIN } from '@arkiv/shared';
import { currentUser } from '@/lib/session';
import { LoginForm } from './login-form';

export const metadata: Metadata = { title: 'Log in · Arkiv', robots: { index: false } };

export default async function Page({ searchParams }: { searchParams: Promise<{ next?: string; error?: string; challenge?: string }> }) {
  const sp = await searchParams;
  const next = safeRedirect(sp.next);
  if (await currentUser()) redirect(next ?? '/app');
  return (
    <div className="ak-wrap ak-section" style={{ maxWidth: 440 }}>
      <h1 className="ak-h1">Log in</h1>
      <p className="ak-muted">We’ll email you a link — or use Google, Apple, a passkey, or your password if you’ve set one.</p>
      <LoginForm
        next={next}
        error={sp.error ? sp.error.slice(0, 200) : null}
        challenge={sp.challenge ? loginChallengeSiteKey() : null}
        google={providerEnabled('google')}
        apple={providerEnabled('apple')}
        ttlMinutes={MAGIC_LINK_TTL_MIN}
      />
    </div>
  );
}
