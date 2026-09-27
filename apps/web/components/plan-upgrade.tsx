'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Banner, Button } from '@arkiv/ui';
import { api, Sheet, toast, useSubmissionKey } from '@arkiv/ui/client';

/**
 * Upgrade with express consent to the new recurring charge (plan 04 §3): the exact new monthly terms next to an
 * unchecked box, the same as the first subscription. The server records the text and refuses an upgrade without it.
 */
export function PlanUpgrade({ slug, plan, planName, terms }: { slug: string; plan: 'LAUNCH' | 'GROWTH' | 'SCALE'; planName: string; terms: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submission = useSubmissionKey();
  async function go() {
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/w/${slug}/change-plan`, { plan, agreed }, 'POST', { idempotencyKey: submission.key() });
      submission.next();
      setOpen(false);
      toast(`You’re on ${planName} now.`);
      router.refresh();
    } catch (e) {
      setErr((e as Error).message);
    }
    setBusy(false);
  }
  return (
    <>
      <Button variant="secondary" onClick={() => { setAgreed(false); setErr(null); setOpen(true); }}>Upgrade now</Button>
      <Sheet open={open} onOpenChange={setOpen} title={`Upgrade to ${planName}`} description="You get the extra Creative Tests for the rest of this period right away.">
        <div className="ak-stack">
          <div className="ak-sealed">
            <p style={{ margin: 0 }}>{terms}</p>
            <label className="ak-check" style={{ marginTop: 12 }}>
              <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
              <span>I agree to the new recurring charge above.</span>
            </label>
          </div>
          {err ? <Banner tone="risk">{err}</Banner> : null}
          <Button disabled={!agreed || busy} onClick={go}>{busy ? 'Upgrading…' : `Upgrade to ${planName}`}</Button>
        </div>
      </Sheet>
    </>
  );
}
