import type { Permission } from '@arkiv/core';

/** Console modules (plan 05 §1–23), grouped; each is shown only to roles holding its permission. */
export const NAV: { group: string; items: { href: string; label: string; perm: Permission }[] }[] = [
  { group: 'Platform', items: [
    { href: '/', label: 'Pulse', perm: 'pulse.read' },
    { href: '/approvals', label: 'Approvals', perm: 'approvals.read' },
  ] },
  { group: 'Customers', items: [
    { href: '/tenants', label: 'Tenants', perm: 'tenant.read' },
    { href: '/users', label: 'Users', perm: 'users.read' },
    { href: '/retention', label: 'Retention', perm: 'retention.read' },
  ] },
  { group: 'Growth', items: [
    { href: '/funnel', label: 'Funnel', perm: 'analytics.read' },
    { href: '/landing-pages', label: 'Landing pages', perm: 'growth.manage' },
    { href: '/offers', label: 'Offers', perm: 'offers.manage' },
    { href: '/email', label: 'Email', perm: 'email.read' },
  ] },
  { group: 'Money', items: [
    { href: '/billing', label: 'Billing', perm: 'billing.read' },
    { href: '/ledger', label: 'Ledger & COGS', perm: 'ledger.read' },
    { href: '/rates', label: 'Rate tables', perm: 'rates.propose' },
  ] },
  { group: 'Production', items: [
    { href: '/jobs', label: 'Jobs & queues', perm: 'jobs.read' },
    { href: '/qa', label: 'QA review', perm: 'qa.review' },
    { href: '/providers', label: 'Providers & routes', perm: 'providers.read' },
    { href: '/prompts', label: 'Prompts & evals', perm: 'routes.manage' },
    { href: '/integrations', label: 'Integrations', perm: 'integrations.read' },
  ] },
  { group: 'Trust', items: [
    { href: '/claims', label: 'Claims & compliance', perm: 'claims.review' },
    { href: '/abuse', label: 'Abuse & rights', perm: 'abuse.manage' },
    { href: '/privacy', label: 'Data requests', perm: 'privacy.manage' },
    { href: '/taxonomy', label: 'Taxonomy', perm: 'taxonomy.manage' },
  ] },
  { group: 'System', items: [
    { href: '/flags', label: 'Flags & config', perm: 'flags.manage' },
    { href: '/system', label: 'System health', perm: 'system.read' },
    { href: '/staff', label: 'Staff', perm: 'staff.manage' },
    { href: '/audit', label: 'Audit log', perm: 'audit.read' },
  ] },
];
