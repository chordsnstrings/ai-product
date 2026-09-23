import type { Metadata } from 'next';
import { UploadModule } from '@/components/upload-module';

export const metadata: Metadata = { title: 'Start · Arkiv' };

export default function Page() {
  return (
    <div className="ak-wrap ak-section" style={{ maxWidth: 640 }}>
      <h1 className="ak-h1">Show us your product</h1>
      <p className="ak-body-l ak-muted">Paste your product page or add a photo. You’ll see three test-ready ad ideas in about a minute — free, no card.</p>
      <UploadModule page="start" />
    </div>
  );
}
