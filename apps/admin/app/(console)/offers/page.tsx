import { withAdmin } from '@arkiv/db';
import { ActButton, ActForm } from '@/components/act';
import { d, dt, money, Mono, Page, pct, Section, Table } from '@/components/ui';
import { requireStaff } from '@/lib/staff';

export const metadata = { title: 'Offers' };

/** Offer Engine (plan 05 §6): deterministic, versioned, honest anchors only. */
export default async function Offers() {
  await requireStaff('offers.manage');
  const d0 = await withAdmin(async (tx) => ({
    defs: await tx`select * from offer_definitions order by type, code`,
    issued: await tx`select o.type, o.status, count(*)::int as n from offers o join workspaces w on w.id = o.workspace_id where not w.is_test and o.created_at > now() - interval '30 days' group by 1, 2`,
    recent: await tx`select o.*, w.name from offers o join workspaces w on w.id = o.workspace_id order by o.created_at desc limit 50`,
    testimonials: await tx`select * from testimonials order by created_at desc`,
  }));
  const taste = (s: string) => Number(d0.issued.find((i) => i.type === 'TASTE' && i.status === s)?.n ?? 0);
  const tasteTotal = ['active', 'expired', 'redeemed', 'superseded'].reduce((a, s) => a + taste(s), 0);
  return (
    <Page title="Offers & pricing" sub="Prices on live offers can’t be edited — create a new code. A reference (strike-through) price must be an active price we actually charge.">
      <Table head={['Code', 'Type', 'Price', 'Reference', 'Window', 'Bonus', 'Active', '']} rows={d0.defs.map((o) => [
        <Mono key="c">{o.code as string}</Mono>, o.type as string, money(o.price_micros), (o.reference_code as string) ?? '—', o.window_minutes ? `${o.window_minutes} min` : '—', <Mono key="b">{JSON.stringify(o.bonus)}</Mono>, o.active ? 'yes' : 'no',
        <ActButton key="a" small action="offer.active" payload={{ code: o.code, active: !o.active }}>{o.active ? 'Pause' : 'Activate'}</ActButton>,
      ])} />
      <p className="ak-small" style={{ marginTop: 12 }}>Taste offers (30d): issued {tasteTotal} · redeemed {taste('redeemed')} ({pct(tasteTotal ? taste('redeemed') / tasteTotal : NaN)}) · expired {taste('expired')}</p>
      <div className="ak-grid-2" style={{ alignItems: 'start' }}>
        <Section title="New offer version">
          <div className="ak-panel">
            <ActForm action="offer.create" submit="Create" fields={[
              { name: 'code', label: 'Code', required: true, placeholder: 'TASTE_24_V2' },
              { name: 'type', label: 'Type', type: 'select', options: ['TASTE', 'STANDALONE', 'PLAN_UPGRADE', 'WIN_BACK'] },
              { name: 'price', label: 'Price $', type: 'number', required: true },
              { name: 'referenceCode', label: 'Reference price code (optional)', placeholder: 'STANDALONE_29' },
              { name: 'windowMinutes', label: 'Window (minutes)', type: 'number' },
              { name: 'bonus', label: 'Bonus (JSON)', type: 'json', defaultValue: '{}' },
              { name: 'eligibility', label: 'Eligibility (JSON logic)', type: 'json', defaultValue: '{"newWorkspace": true, "neverPurchased": true}' },
            ]} />
          </div>
        </Section>
        <Section title="Recent assignments">
          <Table head={['Issued', 'Workspace', 'Type', 'Price', 'Expires', 'Status']} rows={d0.recent.map((o) => [dt(o.created_at), o.name as string, o.type as string, money(o.price_micros), dt(o.expires_at), o.status as string])} />
        </Section>
      </div>
      <Section title="Testimonials (need a stored consent record — FTC)">
        <Table head={['Quote', 'Person', 'Consent', 'Given', 'Status', '']} rows={d0.testimonials.map((t) => [t.quote as string, `${t.person_name}${t.brand_name ? `, ${t.brand_name}` : ''}`, t.consent_document as string, d(t.consent_given_at), t.revoked_at ? 'revoked' : 'live', !t.revoked_at ? <ActButton key="r" small action="testimonial.revoke" payload={{ id: t.id }}>Revoke</ActButton> : null])} empty="No testimonials. Pages show none until real ones with consent exist." />
        <div className="ak-panel" style={{ maxWidth: 560, marginTop: 12 }}>
          <ActForm action="testimonial.create" submit="Add testimonial" fields={[
            { name: 'quote', label: 'Exact quote', type: 'textarea', required: true },
            { name: 'personName', label: 'Name', required: true },
            { name: 'brandName', label: 'Brand' },
            { name: 'consentDocument', label: 'Consent record (signed doc reference)', required: true },
            { name: 'consentGivenAt', label: 'Consent date', type: 'date', required: true },
          ]} />
        </div>
      </Section>
    </Page>
  );
}
