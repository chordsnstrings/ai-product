/** @jsxRuntime automatic */
/** @jsxImportSource react */
// Explicit runtime: the worker loads this file through tsx, which applies its own tsconfig only to its own
// sources and would otherwise compile JSX with the classic runtime ("React is not defined").
import { Body, Button, Container, Head, Hr, Html, Img, Preview, Section, Text } from '@react-email/components';
import type { ReactNode } from 'react';

/** Arkiv email design (01-design-system §6/§7): paper background, serif headline, mono metadata, one CTA. */
const C = { paper: '#F5F2EC', raised: '#FBFAF7', ink: '#1A1917', ink2: '#4A4742', stone: '#8A857D', rule: '#D6D1C7', accent: '#7A4A32' };
const serif = "'Instrument Serif', Georgia, 'Times New Roman', serif";
const sans = "'Inter Tight', Inter, Helvetica, Arial, sans-serif";
const mono = "'IBM Plex Mono', Menlo, Consolas, monospace";

function Layout({ preview, label, children, footer }: { preview: string; label: string; children: ReactNode; footer?: ReactNode }) {
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
          </Text>
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
  refund_issued: { productName: string; amount: string; url: string };
  asset_ready: { productName: string; url: string; catalogueNo: string };
  offer_ending: { productName: string; url: string; endsAt: string; price: string; regular: string };
  storyboard_saved: { productName: string; url: string; standalonePrice: string };
  new_concept: { productName: string; url: string; hook: string };
  export_ready: { url: string; workspaceName: string };
  integration_disconnected: { provider: string; url: string; workspaceName: string };
  claim_review_result: { claim: string; outcome: string; url: string };
  cancellation_confirmed: { planName: string; endsOn: string; exportUrl: string };
  subscription_started: { planName: string; tests: number; price: string; renewsOn: string; url: string };
  price_change_notice: { planName: string; oldPrice: string; newPrice: string; effectiveOn: string; url: string };
  payment_failed: { url: string; workspaceName: string };
  security_alert: { event: string; when: string; url: string };
  weekly_brief: { workspaceName: string; week: string; recommendations: { hypothesis: string; slot: string }[]; url: string };
  friday_summary: { workspaceName: string; lines: string[]; url: string };
  day30_review: { productName: string; tested: number; actionable: number; url: string };
  staff_break_glass: { staffName: string; reason: string; when: string; url: string };
}

export type TemplateName = keyof TemplateMap;

type Built = { subject: string; element: ReactNode; stream: 'transactional' | 'marketing' };

export function build<T extends TemplateName>(name: T, d: TemplateMap[T]): Built {
  const x = d as never as Record<string, unknown> & TemplateMap[TemplateName];
  switch (name) {
    case 'magic_link': {
      const m = d as TemplateMap['magic_link'];
      const title = m.purpose === 'claim' ? `Save ${m.productName ?? 'your product'}` : m.purpose === 'step_up' ? 'Confirm it’s you' : 'Sign in to Arkiv';
      return {
        subject: title,
        stream: 'transactional',
        element: (
          <Layout preview={`${title}. This link works for 15 minutes.`} label="Sign in">
            <H>{title}</H>
            <P>{m.purpose === 'claim' ? 'Your storyboard is being prepared. Tap below to save your work and continue.' : 'Tap the button to continue. This link works once, for 15 minutes.'}</P>
            <Cta href={m.url}>{m.purpose === 'claim' ? 'Save and continue' : 'Continue'}</Cta>
            <P>{' '}</P>
            <P>If you didn’t ask for this, you can ignore this email.</P>
          </Layout>
        ),
      };
    }
    case 'invite': {
      const m = d as TemplateMap['invite'];
      return {
        subject: `${m.inviterName} invited you to ${m.workspaceName}`,
        stream: 'transactional',
        element: (
          <Layout preview={`Join ${m.workspaceName} on Arkiv`} label="Invitation">
            <H>Join {m.workspaceName}</H>
            <Meta rows={[['Invited by', m.inviterName], ['Role', m.role.toLowerCase()], ['Expires', 'in 7 days']]} />
            <Cta href={m.url}>Accept invitation</Cta>
          </Layout>
        ),
      };
    }
    case 'receipt': {
      const m = d as TemplateMap['receipt'];
      return {
        subject: `Receipt · ${m.description}`,
        stream: 'transactional',
        element: (
          <Layout preview={`${m.amount} · ${m.description}`} label="Receipt">
            <H>Thank you</H>
            <Meta rows={[['Item', m.description], ['Product', m.productName], ['Total', m.amount], ['Billing', 'One-time · no subscription']]} />
            <Cta href={m.url}>Follow production</Cta>
          </Layout>
        ),
      };
    }
    case 'refund_issued': {
      const m = d as TemplateMap['refund_issued'];
      return {
        subject: `Refund issued · ${m.productName}`,
        stream: 'transactional',
        element: (
          <Layout preview={`${m.amount} is on its way back to you.`} label="Refund">
            <H>You’ve been refunded</H>
            <P>We couldn’t produce your {m.productName} ad to our quality standard, so as promised you don’t pay for it. The full amount is on its way back to your card; it can take 5–10 days to appear.</P>
            <Meta rows={[['Product', m.productName], ['Refunded', m.amount], ['Why', 'Didn’t pass our quality checks']]} />
            <Cta href={m.url}>See your storyboard</Cta>
          </Layout>
        ),
      };
    }
    case 'asset_ready': {
      const m = d as TemplateMap['asset_ready'];
      return {
        subject: `Your ${m.productName} ad is ready`,
        stream: 'transactional',
        element: (
          <Layout preview="Product accuracy and claims checked. Exports for TikTok, Reels and Feed." label={`Archived · ${m.catalogueNo}`}>
            <H>Your ad is ready</H>
            <P>We checked product accuracy and every claim before it reached you. Exports are sized for TikTok, Reels and Feed.</P>
            <Cta href={m.url} accent>Watch your ad</Cta>
          </Layout>
        ),
      };
    }
    case 'offer_ending': {
      const m = d as TemplateMap['offer_ending'];
      return {
        subject: `Your intro price for ${m.productName} ends at ${m.endsAt}`,
        stream: 'transactional',
        element: (
          <Layout preview={`${m.price} until ${m.endsAt}, then ${m.regular}.`} label="Storyboard saved">
            <H>Your storyboard is saved</H>
            <Meta rows={[['Product', m.productName], ['Intro price', `${m.price} until ${m.endsAt}`], ['After that', `${m.regular} (standard price)`]]} />
            <Cta href={m.url} accent>Produce my ad</Cta>
          </Layout>
        ),
      };
    }
    case 'storyboard_saved': {
      const m = d as TemplateMap['storyboard_saved'];
      return {
        subject: `${m.productName} · your storyboard is saved`,
        stream: 'marketing',
        element: (
          <Layout preview="Pick up where you left off." label="Your archive">
            <H>Pick up where you left off</H>
            <P>Your storyboard for {m.productName} is saved. You can produce it any time for {m.standalonePrice}.</P>
            <Cta href={m.url}>Open storyboard</Cta>
          </Layout>
        ),
      };
    }
    case 'new_concept': {
      const m = d as TemplateMap['new_concept'];
      return {
        subject: `A new test idea for ${m.productName}`,
        stream: 'marketing',
        element: (
          <Layout preview={m.hook} label="New idea">
            <H>“{m.hook}”</H>
            <P>We drafted another direction for {m.productName}, based on what your customers say.</P>
            <Cta href={m.url}>See the idea</Cta>
          </Layout>
        ),
      };
    }
    case 'export_ready': {
      const m = d as TemplateMap['export_ready'];
      return { subject: `Your ${m.workspaceName} export is ready`, stream: 'transactional', element: (<Layout preview="Download link valid for 24 hours." label="Export"><H>Your export is ready</H><P>This link works for 24 hours.</P><Cta href={m.url}>Download export</Cta></Layout>) };
    }
    case 'integration_disconnected': {
      const m = d as TemplateMap['integration_disconnected'];
      return { subject: `${m.provider} disconnected from ${m.workspaceName}`, stream: 'transactional', element: (<Layout preview="Recommendations are now context-limited until you reconnect." label="Integration"><H>{m.provider} disconnected</H><P>Until you reconnect, recommendations use your product and customer language only — not performance.</P><Cta href={m.url}>Reconnect</Cta></Layout>) };
    }
    case 'claim_review_result': {
      const m = d as TemplateMap['claim_review_result'];
      return { subject: `Claim review: ${m.outcome}`, stream: 'transactional', element: (<Layout preview={m.claim} label="Claims Vault"><H>{m.outcome}</H><Meta rows={[['Claim', m.claim], ['Outcome', m.outcome]]} /><Cta href={m.url}>Open Claims Vault</Cta></Layout>) };
    }
    case 'cancellation_confirmed': {
      const m = d as TemplateMap['cancellation_confirmed'];
      return { subject: 'Your plan is cancelled', stream: 'transactional', element: (<Layout preview={`Access until ${m.endsOn}.`} label="Billing"><H>Cancelled</H><Meta rows={[['Plan', m.planName], ['Access until', m.endsOn], ['Your archive', 'Kept for 90 days, then deleted']]} /><Cta href={m.exportUrl}>Export your data</Cta></Layout>) };
    }
    case 'subscription_started': {
      const m = d as TemplateMap['subscription_started'];
      return { subject: `Welcome to ${m.planName}`, stream: 'transactional', element: (<Layout preview={`${m.tests} Creative Tests a month.`} label="Billing"><H>{m.planName} is active</H><Meta rows={[['Creative Tests', `${m.tests} per month`], ['Price', `${m.price} per month`], ['Renews', m.renewsOn], ['Cancel', 'Online anytime in Settings → Billing']]} /><Cta href={m.url}>See this week’s tests</Cta></Layout>) };
    }
    case 'price_change_notice': {
      const m = d as TemplateMap['price_change_notice'];
      return { subject: `Upcoming price change for ${m.planName}`, stream: 'transactional', element: (<Layout preview={`${m.oldPrice} → ${m.newPrice} from ${m.effectiveOn}`} label="Billing"><H>A change to your plan price</H><Meta rows={[['Plan', m.planName], ['Current', m.oldPrice], ['New', m.newPrice], ['From', m.effectiveOn]]} /><P>You can cancel online anytime before then.</P><Cta href={m.url}>Manage plan</Cta></Layout>) };
    }
    case 'payment_failed': {
      const m = d as TemplateMap['payment_failed'];
      return { subject: 'Payment didn’t go through', stream: 'transactional', element: (<Layout preview="Update your card to keep producing tests." label="Billing"><H>Payment didn’t go through</H><P>Your archive and exports are safe. New production is paused until the card is updated.</P><Cta href={m.url}>Update payment method</Cta></Layout>) };
    }
    case 'security_alert': {
      const m = d as TemplateMap['security_alert'];
      return { subject: `Security: ${m.event}`, stream: 'transactional', element: (<Layout preview={m.event} label="Security"><H>{m.event}</H><Meta rows={[['When', m.when]]} /><P>If this wasn’t you, sign out other sessions now.</P><Cta href={m.url}>Review sessions</Cta></Layout>) };
    }
    case 'weekly_brief': {
      const m = d as TemplateMap['weekly_brief'];
      return {
        subject: `${m.workspaceName} · What to test this week`,
        stream: 'transactional',
        element: (
          <Layout preview={m.recommendations[0]?.hypothesis ?? 'Your weekly tests'} label={`Week of ${m.week}`}>
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
          </Layout>
        ),
      };
    }
    case 'friday_summary': {
      const m = d as TemplateMap['friday_summary'];
      return { subject: `${m.workspaceName} · This week’s learning`, stream: 'transactional', element: (<Layout preview={m.lines[0] ?? 'Weekly summary'} label="Friday summary"><H>What we learned</H>{m.lines.map((l, i) => <P key={i}>{l}</P>)}<Cta href={m.url}>Open results</Cta></Layout>) };
    }
    case 'day30_review': {
      const m = d as TemplateMap['day30_review'];
      return { subject: `${m.productName} · 30-day creative review`, stream: 'transactional', element: (<Layout preview={`${m.tested} tests, ${m.actionable} actionable learnings`} label="SKU review"><H>Your first 30 days</H><Meta rows={[['Tests run', String(m.tested)], ['Actionable learnings', String(m.actionable)]]} /><Cta href={m.url}>Read the review</Cta></Layout>) };
    }
    case 'staff_break_glass': {
      const m = d as TemplateMap['staff_break_glass'];
      return { subject: 'Our support team accessed your workspace', stream: 'transactional', element: (<Layout preview={m.reason} label="Access log"><H>Support access</H><Meta rows={[['Who', m.staffName], ['Why', m.reason], ['When', m.when]]} /><Cta href={m.url}>View access log</Cta></Layout>) };
    }
  }
  void x;
  throw new Error(`unknown template ${String(name)}`);
}
