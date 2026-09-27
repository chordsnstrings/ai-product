/**
 * Customer sign-in constants and helpers the browser needs too (client components import this module directly
 * through `@arkiv/shared/auth`, so it must stay free of server-only code).
 */

/** How long an emailed sign-in link works (plan 03 P6: "Link expired (15 min)"). Used by the link, UI and email. */
export const MAGIC_LINK_TTL_MIN = 15;

/** The ways a customer signs in (plan 03 Part C). Recorded on sessions, sign-in history and ACCOUNT_CLAIMED. */
export const SIGN_IN_METHODS = ['magic_link', 'google', 'apple', 'passkey', 'password'] as const;
export type SignInMethod = (typeof SIGN_IN_METHODS)[number];

/**
 * Versions of the Terms and Privacy Policy a new account accepts by continuing (plan 03 P6 small print: "no
 * checkbox needed for a free account; acceptance logged by the action and timestamp"). Bump on a material change.
 */
export const TERMS_VERSION = '2026-01';
export const PRIVACY_VERSION = '2026-01';

/** Customer passwords are optional (standard §34); when set they need at least this many characters. */
export const MIN_PASSWORD_LENGTH = 10;

const TYPO_DOMAINS: Record<string, string> = {
  'gmial.com': 'gmail.com',
  'gmai.com': 'gmail.com',
  'gmail.co': 'gmail.com',
  'gmaill.com': 'gmail.com',
  'gnail.com': 'gmail.com',
  'hotmial.com': 'hotmail.com',
  'hotmai.com': 'hotmail.com',
  'yaho.com': 'yahoo.com',
  'yahooo.com': 'yahoo.com',
  'outlok.com': 'outlook.com',
  'outloo.com': 'outlook.com',
  'icloud.co': 'icloud.com',
  'iclod.com': 'icloud.com',
};

/** "jo@gmial.com" → "jo@gmail.com" (plan 03 P6 "Email typo → inline suggestion"); null when nothing to suggest. */
export function emailSuggestion(email: string): string | null {
  const [local, domain] = email.trim().toLowerCase().split('@');
  const fix = domain ? TYPO_DOMAINS[domain] : undefined;
  return local && fix ? `${local}@${fix}` : null;
}

export function validEmail(email: string) {
  return /^[^@\s]{1,64}@[^@\s]+\.[^@\s]{2,}$/.test(email.trim());
}

/**
 * Throwaway-mailbox domains (plan 03 P6: "Disposable email domains → allowed for the free step but flagged for
 * abuse scoring"). The common services; a subdomain of a listed domain counts too.
 */
export const DISPOSABLE_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  '10minutemail.com', '20minutemail.com', 'discard.email', 'dispostable.com', 'emailondeck.com', 'fakeinbox.com',
  'getairmail.com', 'getnada.com', 'guerrillamail.com', 'guerrillamail.net', 'guerrillamail.org', 'guerrillamailblock.com',
  'grr.la', 'sharklasers.com', 'harakirimail.com', 'inboxkitten.com', 'maildrop.cc', 'mailinator.com', 'mailinator.net',
  'mailnesia.com', 'mintemail.com', 'moakt.com', 'mohmal.com', 'mytemp.email', 'nada.email', 'spambox.us',
  'spamgourmet.com', 'temp-mail.org', 'temp-mail.io', 'tempail.com', 'tempmail.com', 'tempmail.net', 'tempmailo.com',
  'tempr.email', 'throwawaymail.com', 'trashmail.com', 'trashmail.net', 'yopmail.com', 'yopmail.net', 'yopmail.fr',
  'mailcatch.com', 'burnermail.io', 'emailfake.com', 'fakemail.net', 'mail.tm', 'dropmail.me', 'tmpmail.org', 'tmail.ws',
]);

/** The listed disposable domain an address belongs to, or null. */
export function disposableEmailDomain(email: string): string | null {
  const domain = email.trim().toLowerCase().split('@')[1];
  if (!domain) return null;
  const parts = domain.split('.');
  for (let i = 0; i < parts.length - 1; i++) {
    const d = parts.slice(i).join('.');
    if (DISPOSABLE_EMAIL_DOMAINS.has(d)) return d;
  }
  return null;
}

export const isDisposableEmail = (email: string) => disposableEmailDomain(email) !== null;
