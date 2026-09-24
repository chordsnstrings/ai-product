import Link from 'next/link';
import { notFound } from 'next/navigation';
import { withAdmin } from '@arkiv/db';
import { isTemplateName, MARKETING_TEMPLATES, renderEmail, templateSamples, unsubscribeLink, type TemplateName } from '@arkiv/email';
import { env } from '@arkiv/shared';
import { ActButton } from '@/components/act';
import { Mono, Page, Section } from '@/components/ui';
import { requireStaff } from '@/lib/staff';

export const metadata = { title: 'Email preview' };

/**
 * Plan 05 §18: a template rendered with sample data (no tenant content), exactly as the recipient would see it,
 * with a test send to the staff member viewing it. Templates themselves are versioned in git.
 */
export default async function EmailPreview({ params }: { params: Promise<{ template: string }> }) {
  const s = await requireStaff('email.read');
  const { template } = await params;
  if (!isTemplateName(template)) notFound();
  const t = template as TemplateName;
  const [support] = await withAdmin((tx) => tx`select value from platform_settings where key = 'support.email'`);
  const sample = templateSamples(env().APP_URL)[t];
  const marketing = MARKETING_TEMPLATES.has(t);
  // Marketing email carries the recipient's unsubscribe link; the preview shows the staff member's own.
  const r = await renderEmail(t, sample as never, { supportEmail: typeof support?.value === 'string' ? support.value : null, unsubscribeUrl: marketing ? unsubscribeLink(s.email) : null });
  return (
    <Page
      title={r.subject}
      sub={<><Link href="/email">Email</Link> · <Mono>{t}</Mono> · {r.stream} stream</>}
      actions={<ActButton action="email.test" payload={{ template: t }}>Send test to {s.email}</ActButton>}
    >
      <Section title="Rendered with sample data">
        {/* Sandboxed with no permissions: no scripts, no same-origin access, links don't navigate the console. */}
        <iframe title={`Preview of ${t}`} sandbox="" srcDoc={r.html} style={{ width: '100%', maxWidth: 640, height: 760, border: '1px solid var(--rule)', background: '#fff' }} />
      </Section>
      <Section title="Sample data">
        <pre className="ak-mono ak-small" style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(sample, null, 2)}</pre>
      </Section>
    </Page>
  );
}
