import type { Metadata } from 'next';
import { connection } from 'next/server';
import { env } from '@arkiv/shared';
import { UploadModule } from '@/components/upload-module';
import { noJsReturn } from '@/lib/preview-nojs';
import { resumeForVisitor } from '@/lib/resume';

export const metadata: Metadata = { title: 'Start' };

export default async function Page({ searchParams }: { searchParams: Promise<{ error?: string | string[]; url?: string | string[] }> }) {
  await connection(); // the Turnstile site key is runtime configuration, not baked in at build time
  // A plain-form (no JavaScript) post that was refused comes back here with its reason and link (plan 03 P1).
  const back = noJsReturn(await searchParams);
  // A returning visitor's preview in progress (plan 03 P3 edge: "Resume is available on return").
  const resume = await resumeForVisitor().catch(() => null);
  return (
    <div className="ak-wrap ak-section" style={{ maxWidth: 640 }}>
      {resume?.continue ? (
        <p className="ak-panel" style={{ marginBottom: 24 }}>
          <a className="ak-btn ak-btn--secondary ak-btn--block" href={resume.continue.href}>Continue with {resume.continue.name}</a>
        </p>
      ) : null}
      <h1 className="ak-h1">Show us your product</h1>
      <p className="ak-body-l ak-muted">Paste your product page or add a photo. You’ll see three test-ready ad ideas in about a minute — free, no card.</p>
      <UploadModule page="start" turnstileSiteKey={env().TURNSTILE_SITE_KEY ?? null} initialError={back.error} initialUrl={back.url} />
    </div>
  );
}
