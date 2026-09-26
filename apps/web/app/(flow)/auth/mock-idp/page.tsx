import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { MOCK_IDENTITIES, mockIdpEnabled } from '@arkiv/auth';

export const metadata: Metadata = { title: 'Mock sign-in', robots: { index: false } };

/**
 * The mock Google/Apple consent screen (PROVIDERS_MODE=mock only): pick a test identity — including the Apple
 * "Hide my email" relay and a Google account with the same email — type any address, or cancel.
 */
export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  if (!mockIdpEnabled()) notFound();
  const sp = await searchParams;
  const provider = sp.provider === 'apple' ? 'apple' : 'google';
  const hidden = (['provider', 'client_id', 'redirect_uri', 'state', 'nonce', 'code_challenge'] as const).map((k) => <input key={k} type="hidden" name={k} value={k === 'provider' ? provider : (sp[k] ?? '')} />);
  const label = provider === 'google' ? 'Google' : 'Apple';
  return (
    <div className="ak-wrap ak-section" style={{ maxWidth: 440 }}>
      <p className="ak-label">Test mode</p>
      <h1 className="ak-h1">Continue with {label}</h1>
      <p className="ak-muted">This stands in for {label} while the app runs with mock providers. Choose who to sign in as.</p>
      <div className="ak-stack" style={{ marginTop: 24 }}>
        {MOCK_IDENTITIES[provider].map((m, i) => (
          <form key={m.identity.sub} method="post" action="/api/auth/mock-idp/authorize">
            {hidden}
            <input type="hidden" name="identity" value={i} />
            <button type="submit" className="ak-btn ak-btn--secondary ak-btn--block">
              {m.label} · {m.identity.email}
            </button>
          </form>
        ))}
        <form method="post" action="/api/auth/mock-idp/authorize" className="ak-stack">
          {hidden}
          <label className="ak-field">
            <span className="ak-label">Or any verified address</span>
            <input className="ak-input" type="email" name="email" required autoComplete="off" />
          </label>
          <button type="submit" className="ak-btn ak-btn--secondary ak-btn--block">Sign in as this address</button>
        </form>
        <form method="post" action="/api/auth/mock-idp/authorize">
          {hidden}
          <input type="hidden" name="cancel" value="1" />
          <button type="submit" className="ak-textbtn">Cancel</button>
        </form>
      </div>
    </div>
  );
}
