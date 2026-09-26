import type { Tx } from '@arkiv/db';
import { DomainError } from '@arkiv/shared';
import { recordFunnel } from './funnel';
import { hit } from './rate-limit';

export type WaitlistCategory = 'non_skincare' | 'excluded_category';

/** Why a product was refused, as a waitlist category: not skincare at all, or skincare outside V1 (SPF, OTC drugs). */
export const waitlistCategory = (rejectReason: string | null | undefined): WaitlistCategory =>
  /built for skincare|doesn.t look like skincare/i.test(rejectReason ?? '') ? 'non_skincare' : 'excluded_category';

const EMAIL_RE = /^[^@\s]{1,64}@[^@\s]+\.[^@\s]{2,}$/;

/**
 * Plan 03 P2 edge cases: a non-skincare product, or a sunscreen/drug product, gets "we're built for skincare" plus
 * a waitlist email — no generation spend. One row per address and category (a repeat is a no-op); the visitor
 * gave explicit consent to be emailed when we support it. Rate-limited per IP and visitor.
 */
export async function addToWaitlist(
  tx: Tx,
  input: { email: string; consent: boolean; category: WaitlistCategory; reason?: string | null; productName?: string | null; visitorId?: string | null; ip?: string | null },
): Promise<{ joined: boolean }> {
  const email = input.email.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw new DomainError('INVALID', 'Enter a valid email address.');
  if (!input.consent) throw new DomainError('INVALID', 'Tick the box so we can email you when we support this product.');
  if (input.ip) await hit(`waitlist:ip:${input.ip}`, 10, 3600);
  if (input.visitorId) await hit(`waitlist:visitor:${input.visitorId}`, 5, 3600);
  const [r] = await tx`select waitlist_join(${email}, ${input.category}, ${input.reason?.slice(0, 300) ?? null}, ${input.productName?.slice(0, 200) ?? null}, ${input.visitorId ?? null}) as joined`;
  const joined = !!r?.joined;
  if (joined) await recordFunnel('WAITLIST_JOINED', { visitorId: input.visitorId ?? null, props: { category: input.category } }, tx);
  return { joined };
}
