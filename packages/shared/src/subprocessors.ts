/**
 * Data inventory of third parties that receive customer or visitor data (standard §40 "maintain a data
 * inventory"). Rendered on /legal/subprocessors and referenced by the privacy policy. A test fails when code
 * talks to an external host that is not listed here, so the public list cannot silently drift from reality.
 *
 * kind:
 *  - subprocessor: processes data on our behalf to run the service;
 *  - sign_in: an identity provider the user chooses to sign in with;
 *  - connected: a platform the merchant chooses to connect (we hold their OAuth token and sync their data).
 */
export interface DataRecipient {
  name: string;
  kind: 'subprocessor' | 'sign_in' | 'connected';
  purpose: string;
  data: string;
  region: string;
  /** Hostnames we call; `*.` matches any subdomain. */
  hosts: string[];
}

export const DATA_RECIPIENTS: readonly DataRecipient[] = [
  {
    name: 'DigitalOcean',
    kind: 'subprocessor',
    purpose: 'Application hosting, database and file storage',
    data: 'All service data: account details, product data, uploads, generated ads, performance data',
    region: 'United States (New York)',
    hosts: ['*.digitaloceanspaces.com'],
  },
  {
    name: 'Stripe',
    kind: 'subprocessor',
    purpose: 'Payments, subscriptions and refunds',
    data: 'Name, email, billing details and payment method (card data stays with Stripe)',
    region: 'United States',
    hosts: ['api.stripe.com', 'checkout.stripe.com', 'js.stripe.com', 'dashboard.stripe.com'],
  },
  {
    name: 'Resend',
    kind: 'subprocessor',
    purpose: 'Transactional and product email',
    data: 'Email address, name and email content',
    region: 'United States',
    hosts: ['api.resend.com'],
  },
  {
    name: 'Cloudflare',
    kind: 'subprocessor',
    purpose: 'Bot protection on the free preview (Turnstile)',
    data: 'IP address and browser signals of visitors who submit the upload form',
    region: 'Global network',
    hosts: ['challenges.cloudflare.com'],
  },
  {
    name: 'Anthropic',
    kind: 'subprocessor',
    purpose: 'AI analysis of product pages and photos, ad concepts, storyboards and quality checks',
    data: 'Product data and photos, claims, customer-review excerpts, brand guidelines',
    region: 'United States',
    hosts: ['api.anthropic.com'],
  },
  {
    name: 'BytePlus (ModelArk)',
    kind: 'subprocessor',
    purpose: 'AI image and video generation for storyboards and ads',
    data: 'Product photos and scene descriptions',
    region: 'Asia-Pacific (Southeast Asia)',
    hosts: ['ark.ap-southeast.bytepluses.com'],
  },
  {
    name: 'BytePlus (Speech)',
    kind: 'subprocessor',
    purpose: 'Voice-over generation (backup provider)',
    data: 'Voice-over script text',
    region: 'Asia-Pacific (Southeast Asia)',
    hosts: ['voice.ap-southeast-1.bytepluses.com'],
  },
  {
    name: 'MiniMax',
    kind: 'subprocessor',
    purpose: 'Voice-over generation',
    data: 'Voice-over script text',
    region: 'Outside the United States (MiniMax international service)',
    hosts: ['api.minimax.io'],
  },
  {
    name: 'Google',
    kind: 'sign_in',
    purpose: 'Sign in with Google, if you choose it',
    data: 'Name, email address and account identifier',
    region: 'United States',
    hosts: ['accounts.google.com', 'oauth2.googleapis.com', 'www.googleapis.com'],
  },
  {
    name: 'Apple',
    kind: 'sign_in',
    purpose: 'Sign in with Apple, if you choose it',
    data: 'Name, email address (or relay address) and account identifier',
    region: 'United States',
    hosts: ['appleid.apple.com'],
  },
  {
    name: 'Shopify',
    kind: 'connected',
    purpose: 'Product catalogue and order sync for a store you connect',
    data: 'Store access token, products, prices, orders (aggregated for results)',
    region: 'Per your Shopify store',
    hosts: ['*.myshopify.com'],
  },
  {
    name: 'Meta (Facebook, Instagram)',
    kind: 'connected',
    purpose: 'Ad performance sync for an ad account you connect',
    data: 'Ad account access token, ad names and IDs, spend and performance metrics',
    region: 'United States',
    hosts: ['graph.facebook.com', 'www.facebook.com'],
  },
  {
    name: 'TikTok',
    kind: 'connected',
    purpose: 'Ad performance sync for an ad account you connect',
    data: 'Ad account access token, ad names and IDs, spend and performance metrics',
    region: 'Per TikTok for Business',
    hosts: ['business-api.tiktok.com'],
  },
];

/** Is `host` covered by the inventory? */
export function isListedHost(host: string): boolean {
  const h = host.toLowerCase();
  return DATA_RECIPIENTS.some((r) => r.hosts.some((p) => (p.startsWith('*.') ? h.endsWith(p.slice(1)) : h === p)));
}
