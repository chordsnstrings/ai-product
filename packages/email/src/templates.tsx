/** @jsxRuntime automatic */
/** @jsxImportSource react */
// Explicit runtime: the worker loads this file through tsx, which applies its own tsconfig only to its own
// sources and would otherwise compile JSX with the classic runtime ("React is not defined").
import { Body, Button, Container, Head, Hr, Html, Img, Preview, Section, Text } from '@react-email/components';
import type { ReactNode } from 'react';
import { MAGIC_LINK_TTL_MIN } from '@arkiv/shared/auth';

/** Arkiv email design (01-design-system §6/§7): paper background, serif headline, mono metadata, one CTA. */
const C = { paper: '#F5F2EC', raised: '#FBFAF7', ink: '#1A1917', ink2: '#4A4742', stone: '#8A857D', rule: '#D6D1C7', accent: '#7A4A32' };
const serif = "'Instrument Serif', Georgia, 'Times New Roman', serif";
const sans = "'Inter Tight', Inter, Helvetica, Arial, sans-serif";
const mono = "'IBM Plex Mono', Menlo, Consolas, monospace";

interface LayoutProps {
  preview: string;
  label: string;
  children: ReactNode;
  footer?: ReactNode;
  /** Support address (platform setting, plan 05 §20); omitted when unset. */
  support?: string | null;
  /** Marketing stream only: the visible unsubscribe link (plan 04 L20, plan 05 §18). */
  unsubscribe?: string | null;
}

function Layout({ preview, label, children, footer, support, unsubscribe }: LayoutProps) {
  return (
    <Html lang="en">
      <Head />
      <Preview>{preview}</Preview>
      <Body style={{ background: C.paper, margin: 0, padding: '32px 0', fontFamily: sans, color: C.ink }}>
        <Container style={{ maxWidth: 520, margin: '0 auto', background: C.raised, border: `1px solid ${C.rule}`, padding: '32px 28px' }}>
          <Text style={{ fontFamily: mono, fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', color: C.stone, margin: 0 }}>{label}</Text>
          <Hr style={{ borderColor: C.ink, borderWidth: 1, margin: '10px 0 22px' }} />
          {children}
          <Hr style={{ borderColor: C.rule, margin: '28px 0 12px' }} />
          <Text style={{ fontSize: 12, color: C.stone, lineHeight: '18px', margin: 0 }}>
            {footer ?? 'Arkiv · Creative testing for skincare brands.'}
            {support ? <> Questions? Write to {support}.</> : null}
          </Text>
          {unsubscribe ? (
            <Text style={{ fontSize: 12, color: C.stone, lineHeight: '18px', margin: '8px 0 0' }}>
              Don’t want these emails? <a href={unsubscribe} style={{ color: C.stone }}>Unsubscribe</a>.
            </Text>
          ) : null}
        </Container>
      </Body>
    </Html>
  );
}

const H = ({ children }: { children: ReactNode }) => <Text style={{ fontFamily: serif, fontSize: 30, lineHeight: '34px', margin: '0 0 14px', color: C.ink }}>{children}</Text>;
const P = ({ children }: { children: ReactNode }) => <Text style={{ fontSize: 15, lineHeight: '22px', color: C.ink2, margin: '0 0 14px' }}>{children}</Text>;
const Meta = ({ rows }: { rows: [string, string][] }) => (
  <Section style={{ margin: '6px 0 18px' }}>
    {rows.map(([k, v]) => (
      <Text key={k} style={{ margin: 0, padding: '6px 0', borderBottom: `1px solid ${C.rule}`, fontSize: 14 }}>
        <span style={{ fontFamily: mono, fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase', color: C.stone, display: 'inline-block', width: 140 }}>{k}</span>
        {v}
      </Text>
    ))}
  </Section>
);
const Cta = ({ href, children, accent }: { href: string; children: ReactNode; accent?: boolean }) => (
  <Button href={href} style={{ background: accent ? C.accent : C.ink, color: C.raised, padding: '14px 22px', fontSize: 15, borderRadius: 2, textDecoration: 'none', display: 'inline-block' }}>
    {children}
  </Button>
);

export interface TemplateMap {
  magic_link: { url: string; purpose: 'login' | 'claim' | 'resume' | 'step_up'; productName?: string | null };
  invite: { url: string; workspaceName: string; inviterName: string; role: string };
  receipt: { productName: string; amount: string; description: string; url: string };
  asset_ready: { productName: string; url: string; catalogueNo: string };
  offer_ending: { productName: string; url: string; endsAt: string; price: string; regular: string };
  storyboard_saved: { productName: string; url: string; standalonePrice: string };
  new_concept: { productName: string; url: string; hook: string };
  export_ready: { url: string; workspaceName: string };
  refund_issued: { amount: string; description: string; note: string | null; url: string };
  flag_expired: { flagKey: string; owner: string; expiredOn: string; url: string };
  integration_disconnected: { provider: string; url: string; workspaceName: string };
  // A connection whose access token expires soon (Meta long-lived tokens), and a request to move a Shopify store here.
  integration_expiring: { provider: string; url: string; workspaceName: string; expiresOn: string };
  shop_transfer_request: { shop: string; requester: string; url: string; workspaceName: string };
  claim_review_result: { claim: string; outcome: string; url: string };
  // Plan 05 §14 compliance queues: more evidence for a restricted claim; a SKU confirmed out of V1 scope; guidance
  // after repeated blocked claims; the outcome of a before/after or possible-minor media review.
  claim_evidence_request: { claim: string; productName: string; note: string; url: string };
  sku_out_of_scope: { productName: string; reason: string; url: string };
  claims_guidance: { workspaceName: string; blocked: number; examples: string[]; url: string };
  media_review_result: { productName: string; outcome: 'approved' | 'rejected'; note: string; url: string };
  cancellation_confirmed: { planName: string; endsOn: string; exportUrl: string };
  // A plan Stripe ended because its payment kept failing (dunning over): not "you cancelled".
  plan_ended_payment_failed: { planName: string; deletesOn: string; reactivateUrl: string; exportUrl: string };
  subscription_started: { planName: string; tests: number; price: string; renewsOn: string; url: string };
  price_change_notice: { planName: string; oldPrice: string; newPrice: string; effectiveOn: string; url: string };
  payment_failed: { url: string; workspaceName: string };
  security_alert: { event: string; when: string; url: string };
  weekly_brief: { workspaceName: string; week: string; recommendations: { hypothesis: string; slot: string }[]; url: string };
  friday_summary: { workspaceName: string; lines: string[]; url: string };
  signal_update: { workspaceName: string; changes: { test: string; from: string; to: string }[]; url: string };
  day30_review: { productName: string; tested: number; actionable: number; url: string };
  // Standard §48: creator usage rights on footage ended — not used for new ads; history and results are kept.
  rights_expired: { productName: string; files: number; expiredOn: string; url: string };
  // Plan 03 P9 edge: a production running past 20 minutes (still working on it; nothing extra to pay).
  production_delayed: { productName: string; minutes: number; url: string };
  staff_break_glass: { staffName: string; reason: string; when: string; url: string };
  // Plan 05 §23: a single-use link to join the staff console (password + authenticator set by the invitee).
  staff_invite: { name: string; inviterName: string; url: string; expiresIn: string };
  // Plan 05 §21: staff deleted a person's review text from the workspace on a privacy request (tenant notice).
  review_text_erased: { workspaceName: string; deleted: number; reference: string; url: string };
  ownership_transfer_confirm: { workspaceName: string; newOwner: string; reason: string; url: string; expiresIn: string };
  intervention: { label: string; headline: string; body: string; cta: string; url: string };
}

export type TemplateName = keyof TemplateMap;

type Built = { subject: string; element: ReactNode; stream: 'transactional' | 'marketing' };

/** Templates on the marketing stream (List-Unsubscribe header, visible unsubscribe link, frequency cap). */
export const MARKETING_TEMPLATES: ReadonlySet<TemplateName> = new Set(['storyboard_saved', 'new_concept']);

export interface BuildOptions {
  /** Footer support address (platform setting `support.email`). */
  supportEmail?: string | null;
  /** The recipient's signed unsubscribe link; shown on marketing-stream emails only. */
  unsubscribeUrl?: string | null;
}

export function build<T extends TemplateName>(name: T, d: TemplateMap[T], opts: BuildOptions = {}): Built {
  const built = buildTemplate(name, d, opts);
  // The unsubscribe link is decided before the template runs, so the stream list must agree with the template.
  if ((built.stream === 'marketing') !== MARKETING_TEMPLATES.has(name)) throw new Error(`${name}: stream ${built.stream} disagrees with MARKETING_TEMPLATES`);
  return built;
}

function buildTemplate<T extends TemplateName>(name: T, d: TemplateMap[T], opts: BuildOptions): Built {
  const L = (p: Omit<LayoutProps, 'support' | 'unsubscribe'>) => <Layout {...p} support={opts.supportEmail ?? null} unsubscribe={MARKETING_TEMPLATES.has(name) ? (opts.unsubscribeUrl ?? null) : null} />;
  const x = d as never as Record<string, unknown> & TemplateMap[TemplateName];
  switch (name) {
    case 'magic_link': {
      const m = d as TemplateMap['magic_link'];
      const title = m.purpose === 'claim' ? `Save ${m.productName ?? 'your product'}` : m.purpose === 'step_up' ? 'Confirm it’s you' : 'Sign in to Arkiv';
      return {
        subject: title,
        stream: 'transactional',
        element: (
          <L preview={`${title}. This link works for ${MAGIC_LINK_TTL_MIN} minutes.`} label="Sign in">
            <H>{title}</H>
            <P>{m.purpose === 'claim' ? `Your ${m.productName ?? 'product'} catalogue and 3 ad ideas are saved. Tap below to sign in and build the storyboard. This link works once, for ${MAGIC_LINK_TTL_MIN} minutes.` : `Tap the button to continue. This link works once, for ${MAGIC_LINK_TTL_MIN} minutes.`}</P>
            <Cta href={m.url}>{m.purpose === 'claim' ? 'Save and continue' : 'Continue'}</Cta>
            <P>{' '}</P>
            <P>If you didn’t ask for this, you can ignore this email.</P>
          </L>
        ),
      };
    }
    case 'invite': {
      const m = d as TemplateMap['invite'];
      return {
        subject: `${m.inviterName} invited you to ${m.workspaceName}`,
        stream: 'transactional',
        element: (
          <L preview={`Join ${m.workspaceName} on Arkiv`} label="Invitation">
            <H>Join {m.workspaceName}</H>
            <Meta rows={[['Invited by', m.inviterName], ['Role', m.role.toLowerCase()], ['Expires', 'in 7 days']]} />
            <Cta href={m.url}>Accept invitation</Cta>
          </L>
        ),
      };
    }
    case 'receipt': {
      const m = d as TemplateMap['receipt'];
      return {
        subject: `Receipt · ${m.description}`,
        stream: 'transactional',
        element: (
          <L preview={`${m.amount} · ${m.description}`} label="Receipt">
            <H>Thank you</H>
            <Meta rows={[['Item', m.description], ['Product', m.productName], ['Total', m.amount], ['Billing', 'One-time · no subscription']]} />
            <Cta href={m.url}>Follow production</Cta>
          </L>
        ),
      };
    }
    case 'asset_ready': {
      const m = d as TemplateMap['asset_ready'];
      return {
        subject: `Your ${m.productName} ad is ready`,
        stream: 'transactional',
        element: (
          <L preview="Product accuracy and claims checked. Exports for TikTok, Reels and Feed." label={`Archived · ${m.catalogueNo}`}>
            <H>Your ad is ready</H>
            <P>We checked product accuracy and every claim before it reached you. Exports are sized for TikTok, Reels and Feed.</P>
            <Cta href={m.url} accent>Watch your ad</Cta>
          </L>
        ),
      };
    }
    case 'offer_ending': {
      const m = d as TemplateMap['offer_ending'];
      return {
        subject: `Your intro price for ${m.productName} ends at ${m.endsAt}`,
        stream: 'transactional',
        element: (
          <L preview={`${m.price} until ${m.endsAt}, then ${m.regular}.`} label="Storyboard saved">
            <H>Your storyboard is saved</H>
            <Meta rows={[['Product', m.productName], ['Intro price', `${m.price} until ${m.endsAt}`], ['After that', `${m.regular} (standard price)`]]} />
            <Cta href={m.url} accent>Produce my ad</Cta>
          </L>
        ),
      };
    }
    case 'storyboard_saved': {
      const m = d as TemplateMap['storyboard_saved'];
      return {
        subject: `${m.productName} · your storyboard is saved`,
        stream: 'marketing',
        element: (
          <L preview="Pick up where you left off." label="Your archive">
            <H>Pick up where you left off</H>
            <P>Your storyboard for {m.productName} is saved. You can produce it any time for {m.standalonePrice}.</P>
            <Cta href={m.url}>Open storyboard</Cta>
          </L>
        ),
      };
    }
    case 'new_concept': {
      const m = d as TemplateMap['new_concept'];
      return {
        subject: `A new test idea for ${m.productName}`,
        stream: 'marketing',
        element: (
          <L preview={m.hook} label="New idea">
            <H>“{m.hook}”</H>
            <P>We drafted another direction for {m.productName}, based on what your customers say.</P>
            <Cta href={m.url}>See the idea</Cta>
          </L>
        ),
      };
    }
    case 'export_ready': {
      const m = d as TemplateMap['export_ready'];
      return { subject: `Your ${m.workspaceName} export is ready`, stream: 'transactional', element: (<L preview="Download link valid for 24 hours." label="Export"><H>Your export is ready</H><P>This link works for 24 hours.</P><Cta href={m.url}>Download export</Cta></L>) };
    }
    case 'refund_issued': {
      const m = d as TemplateMap['refund_issued'];
      return {
        subject: `Refund issued · ${m.amount}`,
        stream: 'transactional',
        element: (
          <L preview={`${m.amount} is on its way back to your card.`} label="Refund">
            <H>Your refund is on its way</H>
            <Meta rows={[['Amount', m.amount], ['For', m.description], ['Arrives', 'in 5–10 business days, depending on your bank']]} />
            {m.note ? <P>{m.note}</P> : null}
            <Cta href={m.url}>View billing</Cta>
          </L>
        ),
      };
    }
    case 'flag_expired': {
      const m = d as TemplateMap['flag_expired'];
      return {
        subject: `Feature flag past expiry: ${m.flagKey}`,
        stream: 'transactional',
        element: (
          <L preview={`${m.flagKey} expired on ${m.expiredOn}. It now evaluates as off.`} label="Staff · Feature flags">
            <H>A flag you own has expired</H>
            <Meta rows={[['Flag', m.flagKey], ['Owner', m.owner], ['Expired', m.expiredOn]]} />
            <P>Expired flags evaluate as off. Remove the flag from code, or extend its expiry if it is still needed.</P>
            <Cta href={m.url}>Open flags</Cta>
          </L>
        ),
      };
    }
    case 'integration_disconnected': {
      const m = d as TemplateMap['integration_disconnected'];
      return { subject: `${m.provider} disconnected from ${m.workspaceName}`, stream: 'transactional', element: (<L preview="Recommendations are now context-limited until you reconnect." label="Integration"><H>{m.provider} disconnected</H><P>Until you reconnect, recommendations use your product and customer language only — not performance.</P><Cta href={m.url}>Reconnect</Cta></L>) };
    }
    case 'integration_expiring': {
      const m = d as TemplateMap['integration_expiring'];
      return { subject: `Reconnect ${m.provider} before ${m.expiresOn}`, stream: 'transactional', element: (<L preview={`${m.provider} access for ${m.workspaceName} ends on ${m.expiresOn}.`} label="Integration"><H>{m.provider} access ends on {m.expiresOn}</H><P>{m.provider} access tokens expire. Reconnect before then and your results keep syncing without a gap.</P><Cta href={m.url}>Reconnect now</Cta></L>) };
    }
    case 'shop_transfer_request': {
      const m = d as TemplateMap['shop_transfer_request'];
      return { subject: `Transfer request for ${m.shop}`, stream: 'transactional', element: (<L preview="Nothing changes unless you approve." label="Integration · your decision needed"><H>Someone asked to move {m.shop}</H><P>{m.requester} signed in to {m.shop} through Shopify and asked to connect it to another Arkiv workspace. It is connected to {m.workspaceName} now. If you approve, {m.workspaceName} disconnects the store; its past data stays with you.</P><Cta href={m.url}>Review the request</Cta></L>) };
    }
    case 'claim_review_result': {
      const m = d as TemplateMap['claim_review_result'];
      return { subject: `Claim review: ${m.outcome}`, stream: 'transactional', element: (<L preview={m.claim} label="Claims Vault"><H>{m.outcome}</H><Meta rows={[['Claim', m.claim], ['Outcome', m.outcome]]} /><Cta href={m.url}>Open Claims Vault</Cta></L>) };
    }
    case 'claim_evidence_request': {
      const m = d as TemplateMap['claim_evidence_request'];
      return {
        subject: `More evidence needed: ${m.claim}`,
        stream: 'transactional',
        element: (
          <L preview={`Our compliance team needs more support for this claim on ${m.productName}.`} label="Claims Vault">
            <H>More evidence needed</H>
            <Meta rows={[['Claim', m.claim], ['Product', m.productName]]} />
            <P>{m.note}</P>
            <P>Until then the claim stays restricted: ads use neutral wording instead. Attach a study, test report or certificate to the claim and we’ll review it again.</P>
            <Cta href={m.url}>Add evidence</Cta>
          </L>
        ),
      };
    }
    case 'sku_out_of_scope': {
      const m = d as TemplateMap['sku_out_of_scope'];
      return {
        subject: `${m.productName} is outside what Arkiv can advertise today`,
        stream: 'transactional',
        element: (
          <L preview="Sunscreens, acne treatments and other drug or OTC products are out of scope for now." label="Products">
            <H>We can’t make ads for this product yet</H>
            <Meta rows={[['Product', m.productName], ['Why', m.reason]]} />
            <P>Arkiv V1 makes ads for cosmetic skincare only. Products regulated as drugs or over-the-counter medicines (sunscreens, acne treatments and similar) need claims review we don’t offer yet. Nothing was charged for this product.</P>
            <Cta href={m.url}>See your products</Cta>
          </L>
        ),
      };
    }
    case 'claims_guidance': {
      const m = d as TemplateMap['claims_guidance'];
      return {
        subject: 'A few claims we can’t use in ads — and what works instead',
        stream: 'transactional',
        element: (
          <L preview="Why some claims are blocked, and wording that still sells." label="Claims Vault">
            <H>About the claims we couldn’t use</H>
            <P>{`${m.blocked} claims added to ${m.workspaceName} recently describe treating a condition or changing how skin works. Ad platforms and US rules treat those as drug claims, so we never put them in ads.`}</P>
            {m.examples.length ? <Meta rows={m.examples.slice(0, 3).map((e, i) => [`Example ${i + 1}`, e])} /> : null}
            <P>Wording about how the product looks, feels and is used — with the evidence you have — is what we can use. Your Claims Vault suggests alternatives next to each blocked claim.</P>
            <Cta href={m.url}>Open Claims Vault</Cta>
          </L>
        ),
      };
    }
    case 'media_review_result': {
      const m = d as TemplateMap['media_review_result'];
      return {
        subject: m.outcome === 'approved' ? `A photo of ${m.productName} is cleared for ads` : `A photo of ${m.productName} won’t be used in ads`,
        stream: 'transactional',
        element: (
          <L preview={m.note} label="Products">
            <H>{m.outcome === 'approved' ? 'Photo cleared' : 'Photo not used'}</H>
            <Meta rows={[['Product', m.productName], ['Outcome', m.outcome === 'approved' ? 'Cleared for ads' : 'Not used in ads']]} />
            <P>{m.note}</P>
            <Cta href={m.url}>See the product</Cta>
          </L>
        ),
      };
    }
    case 'cancellation_confirmed': {
      const m = d as TemplateMap['cancellation_confirmed'];
      return { subject: 'Your plan is cancelled', stream: 'transactional', element: (<L preview={`Access until ${m.endsOn}.`} label="Billing"><H>Cancelled</H><Meta rows={[['Plan', m.planName], ['Access until', m.endsOn], ['Your archive', 'Kept for 90 days, then deleted']]} /><Cta href={m.exportUrl}>Export your data</Cta></L>) };
    }
    case 'plan_ended_payment_failed': {
      const m = d as TemplateMap['plan_ended_payment_failed'];
      return { subject: 'Your plan ended: the payment didn’t go through', stream: 'transactional', element: (<L preview={`Your archive is kept until ${m.deletesOn}.`} label="Billing"><H>Your plan has ended</H><P>We couldn’t take the payment for {m.planName} after several tries, so the plan has ended and nothing more will be charged.</P><Meta rows={[['Plan', m.planName], ['Your archive', `Kept until ${m.deletesOn}, then deleted`]]} /><P>Choose a plan again anytime to pick up where you left off, or export everything first.</P><Cta href={m.reactivateUrl}>Reactivate</Cta><P><a href={m.exportUrl}>Export your data</a></P></L>) };
    }
    case 'subscription_started': {
      const m = d as TemplateMap['subscription_started'];
      return { subject: `Welcome to ${m.planName}`, stream: 'transactional', element: (<L preview={`${m.tests} Creative Tests a month.`} label="Billing"><H>{m.planName} is active</H><Meta rows={[['Creative Tests', `${m.tests} per month`], ['Price', `${m.price} per month`], ['Renews', m.renewsOn], ['Cancel', 'Online anytime in Settings → Billing']]} /><Cta href={m.url}>See this week’s tests</Cta></L>) };
    }
    case 'price_change_notice': {
      const m = d as TemplateMap['price_change_notice'];
      return { subject: `Upcoming price change for ${m.planName}`, stream: 'transactional', element: (<L preview={`${m.oldPrice} → ${m.newPrice} from ${m.effectiveOn}`} label="Billing"><H>A change to your plan price</H><Meta rows={[['Plan', m.planName], ['Current', m.oldPrice], ['New', m.newPrice], ['From', m.effectiveOn]]} /><P>You can cancel online anytime before then.</P><Cta href={m.url}>Manage plan</Cta></L>) };
    }
    case 'payment_failed': {
      const m = d as TemplateMap['payment_failed'];
      return { subject: 'Payment didn’t go through', stream: 'transactional', element: (<L preview="Update your card to keep producing tests." label="Billing"><H>Payment didn’t go through</H><P>Your archive and exports are safe. New production is paused until the card is updated.</P><Cta href={m.url}>Update payment method</Cta></L>) };
    }
    case 'security_alert': {
      const m = d as TemplateMap['security_alert'];
      return { subject: `Security: ${m.event}`, stream: 'transactional', element: (<L preview={m.event} label="Security"><H>{m.event}</H><Meta rows={[['When', m.when]]} /><P>If this wasn’t you, sign out other sessions now.</P><Cta href={m.url}>Review sessions</Cta></L>) };
    }
    case 'weekly_brief': {
      const m = d as TemplateMap['weekly_brief'];
      return {
        subject: `${m.workspaceName} · What to test this week`,
        stream: 'transactional',
        element: (
          <L preview={m.recommendations[0]?.hypothesis ?? 'Your weekly tests'} label={`Week of ${m.week}`}>
            <H>What to test this week</H>
            {m.recommendations.map((r, i) => (
              <Text key={i} style={{ fontSize: 15, lineHeight: '22px', borderBottom: `1px solid ${C.rule}`, padding: '8px 0', margin: 0 }}>
                <span style={{ fontFamily: mono, fontSize: 11, color: C.stone }}>{String(i + 1).padStart(2, '0')} · {r.slot}</span>
                <br />
                {r.hypothesis}
              </Text>
            ))}
            <P>{' '}</P>
            <Cta href={m.url}>Review and approve</Cta>
          </L>
        ),
      };
    }
    case 'friday_summary': {
      const m = d as TemplateMap['friday_summary'];
      return { subject: `${m.workspaceName} · This week’s learning`, stream: 'transactional', element: (<L preview={m.lines[0] ?? 'Weekly summary'} label="Friday summary"><H>What we learned</H>{m.lines.map((l, i) => <P key={i}>{l}</P>)}<Cta href={m.url}>Open results</Cta></L>) };
    }
    case 'signal_update': {
      const m = d as TemplateMap['signal_update'];
      const label = (st: string) => st.toLowerCase().replace(/_/g, ' ');
      return {
        subject: `${m.workspaceName} · ${m.changes.length === 1 ? 'A test crossed a threshold' : `${m.changes.length} tests crossed a threshold`}`,
        stream: 'transactional',
        element: (
          <L preview={m.changes[0] ? `${m.changes[0].test}: now ${label(m.changes[0].to)}` : 'Signal update'} label="Midweek signal update">
            <H>Where your tests stand</H>
            <P>Only tests whose confidence crossed a threshold since last week are listed.</P>
            {m.changes.map((c, i) => (
              <Text key={i} style={{ fontSize: 15, lineHeight: '22px', borderBottom: `1px solid ${C.rule}`, padding: '8px 0', margin: 0 }}>
                <span style={{ fontFamily: mono, fontSize: 11, color: C.stone }}>{label(c.from)} → {label(c.to)}</span>
                <br />
                {c.test}
              </Text>
            ))}
            <P>{' '}</P>
            <Cta href={m.url}>Open results</Cta>
          </L>
        ),
      };
    }
    case 'day30_review': {
      const m = d as TemplateMap['day30_review'];
      return { subject: `${m.productName} · 30-day creative review`, stream: 'transactional', element: (<L preview={`${m.tested} tests, ${m.actionable} actionable learnings`} label="SKU review"><H>Your first 30 days</H><Meta rows={[['Tests run', String(m.tested)], ['Actionable learnings', String(m.actionable)]]} /><Cta href={m.url}>Read the review</Cta></L>) };
    }
    case 'rights_expired': {
      const m = d as TemplateMap['rights_expired'];
      return {
        subject: `${m.productName} · creator rights ended on ${m.files} file${m.files === 1 ? '' : 's'}`,
        stream: 'transactional',
        element: (
          <L preview="We won’t use this footage in new ads. Past ads and their results stay in your archive." label="Usage rights">
            <H>Creator rights have ended</H>
            <P>The usage rights on {m.files === 1 ? 'one file' : `${m.files} files`} for {m.productName} ended on {m.expiredOn}. We won’t use {m.files === 1 ? 'it' : 'them'} in new ads, and tests that would reuse {m.files === 1 ? 'it' : 'them'} ask for replacement footage first. Ads already made, and what they taught you, stay in your archive.</P>
            <Cta href={m.url}>Add replacement footage</Cta>
          </L>
        ),
      };
    }
    case 'production_delayed': {
      const m = d as TemplateMap['production_delayed'];
      return {
        subject: `Your ${m.productName} ad is taking longer than usual`,
        stream: 'transactional',
        element: (
          <L preview="We’re still working on it. Nothing extra to pay." label="Production">
            <H>Still working on your ad</H>
            <P>Your {m.productName} ad has been in production for {m.minutes} minutes, longer than usual. Our team has been alerted and is watching it. You don’t need to do anything, and you won’t be charged more; if we can’t finish it, your credit or payment comes back to you.</P>
            <Cta href={m.url}>See progress</Cta>
          </L>
        ),
      };
    }
    case 'ownership_transfer_confirm': {
      const m = d as TemplateMap['ownership_transfer_confirm'];
      return {
        subject: `Confirm: make ${m.newOwner} the owner of ${m.workspaceName}?`,
        stream: 'transactional',
        element: (
          <L preview="Nothing changes unless you confirm." label="Ownership · your confirmation needed">
            <H>Confirm the new owner</H>
            <P>Arkiv support was asked to make {m.newOwner} the owner of {m.workspaceName}. You would become an admin. Nothing changes unless you confirm.</P>
            <Meta rows={[['Workspace', m.workspaceName], ['New owner', m.newOwner], ['Reason given', m.reason], ['Link expires', `in ${m.expiresIn}`]]} />
            <Cta href={m.url}>Review and confirm</Cta>
            <P>{' '}</P>
            <P>If you didn’t ask for this, decline on that page or ignore this email.</P>
          </L>
        ),
      };
    }
    case 'intervention': {
      const m = d as TemplateMap['intervention'];
      return { subject: m.headline, stream: 'transactional', element: (<L preview={m.body.slice(0, 90)} label={m.label}><H>{m.headline}</H><P>{m.body}</P><Cta href={m.url}>{m.cta}</Cta></L>) };
    }
    case 'staff_invite': {
      const m = d as TemplateMap['staff_invite'];
      return { subject: 'You’re invited to the Arkiv staff console', stream: 'transactional', element: (<L preview={`${m.inviterName} invited you. The link works for ${m.expiresIn}.`} label="Staff console"><H>Join the Arkiv staff console</H><P>{m.inviterName} invited you, {m.name}. Open the link to set your own password and enrol your authenticator app. It works once, for {m.expiresIn}.</P><Cta href={m.url}>Accept invite</Cta><P>Your roles take effect once a second administrator approves them. If you weren’t expecting this, ignore this email.</P></L>) };
    }
    case 'review_text_erased': {
      const m = d as TemplateMap['review_text_erased'];
      return { subject: 'We removed review text from your workspace', stream: 'transactional', element: (<L preview={`${m.deleted} review snippet${m.deleted === 1 ? '' : 's'} removed on a privacy request.`} label="Privacy"><H>Review text removed</H><P>A person asked us to delete their personal information. Our team removed the review text that identified them from {m.workspaceName}. Nothing else in your workspace changed; customer themes refresh on the next analysis.</P><Meta rows={[['Snippets removed', String(m.deleted)], ['Request reference', m.reference]]} /><Cta href={m.url}>View access log</Cta></L>) };
    }
    case 'staff_break_glass': {
      const m = d as TemplateMap['staff_break_glass'];
      return { subject: 'Our support team accessed your workspace', stream: 'transactional', element: (<L preview={m.reason} label="Access log"><H>Support access</H><Meta rows={[['Who', m.staffName], ['Why', m.reason], ['When', m.when]]} /><Cta href={m.url}>View access log</Cta></L>) };
    }
  }
  void x;
  throw new Error(`unknown template ${String(name)}`);
}
