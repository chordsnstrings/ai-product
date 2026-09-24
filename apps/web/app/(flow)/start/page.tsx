import type { Metadata } from 'next';
import { connection } from 'next/server';
import { env } from '@arkiv/shared';
import { UploadModule } from '@/components/upload-module';

export const metadata: Metadata = { title: 'Start' };

export default async function Page() {
  await connection(); // the Turnstile site key is runtime configuration, not baked in at build time
  return (
    <div className="ak-wrap ak-section" style={{ maxWidth: 640 }}>
      <h1 className="ak-h1">Show us your product</h1>
      <p className="ak-body-l ak-muted">Paste your product page or add a photo. You’ll see three test-ready ad ideas in about a minute — free, no card.</p>
      <UploadModule page="start" turnstileSiteKey={env().TURNSTILE_SITE_KEY ?? null} />
    </div>
  );
}
