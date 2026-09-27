import type { Tx } from '@arkiv/db';
import { DomainError } from '@arkiv/shared';
import { hit } from './rate-limit';
import { setting } from './settings';

/**
 * Takedown / rights complaints intake (plan 05 §15 "form + email → case → freeze asset → resolve"). Complaints from
 * the public form and from email to the rights address become open rights cases for compliance staff; staff freeze
 * the asset (unavailable for new production) and resolve. Nobody outside staff can read cases.
 */

const EMAIL_RE = /^[^@\s]{1,64}@[^@\s]+\.[^@\s]{2,}$/;

export interface RightsComplaint {
  name: string;
  email: string;
  detail: string;
  /** Where the content appears (an ad, a page); optional. */
  url?: string | null;
  ip?: string | null;
}

/** The public form (apps/web /rights): validated, rate-limited per IP and address, filed through a definer function. */
export async function submitRightsComplaint(tx: Tx, c: RightsComplaint): Promise<string> {
  const email = c.email.trim().toLowerCase();
  const name = c.name.trim();
  const detail = c.detail.trim();
  if (name.length < 2) throw new DomainError('INVALID', 'Tell us who you are (or who you represent).');
  if (!EMAIL_RE.test(email)) throw new DomainError('INVALID', 'Enter a valid email address so we can reply.');
  if (detail.length < 10) throw new DomainError('INVALID', 'Describe the content and the rights you hold.');
  if (c.ip) await hit(`rights:ip:${c.ip}`, 5, 3600);
  await hit(`rights:email:${email}`, 5, 86_400);
  const url = c.url?.trim() ? c.url.trim().slice(0, 500) : null;
  const [r] = await tx`select rights_complaint_submit(${name.slice(0, 200)}, ${email}, ${detail.slice(0, 3500)}, ${url}) as id`;
  return r!.id as string;
}

/** Local parts that always reach the rights intake, plus the configured address (setting `rights.intake_address`). */
const INTAKE_LOCAL_PARTS = new Set(['rights', 'takedown', 'copyright', 'dmca', 'legal']);

export function isRightsIntakeAddress(to: string, configured: string | null | undefined): boolean {
  const addr = (/<([^>]+)>/.exec(to)?.[1] ?? to).trim().toLowerCase();
  if (configured && addr === configured.trim().toLowerCase()) return true;
  return INTAKE_LOCAL_PARTS.has(addr.split('@')[0] ?? '');
}

export interface InboundEmail {
  email_id?: string;
  from?: string;
  to?: string[];
  subject?: string;
  text?: string;
}

/**
 * A received email (Resend inbound, `email.received`) addressed to the rights intake becomes an open case, once per
 * email id. System role (worker). Returns the case id, or null when the email isn't for the rights intake.
 */
export async function rightsCaseFromEmail(tx: Tx, e: InboundEmail): Promise<string | null> {
  const configured = await setting(tx, 'rights.intake_address');
  if (!(e.to ?? []).some((t) => isRightsIntakeAddress(t, configured))) return null;
  const from = (e.from ?? '').trim();
  const address = (/<([^>]+)>/.exec(from)?.[1] ?? from).trim().toLowerCase();
  const name = from.replace(/<[^>]+>/, '').replace(/"/g, '').trim() || address || 'unknown sender';
  const ref = e.email_id ? `[email ${e.email_id}]` : null;
  if (ref) {
    const [dup] = await tx`select id from rights_cases where origin = 'email' and detail like ${`%${ref}`} limit 1`;
    if (dup) return dup.id as string;
  }
  const body = (e.text ?? '').trim() || '(no text body; open the email in the inbound mailbox)';
  const detail = `${(e.subject ?? '(no subject)').trim()}\n\n${body}`.slice(0, 3800) + (ref ? `\n\n${ref}` : '');
  const [r] = await tx`insert into rights_cases (complainant, complainant_email, detail, origin)
                       values (${name.slice(0, 200)}, ${EMAIL_RE.test(address) ? address : null}, ${detail}, 'email') returning id`;
  return r!.id as string;
}
