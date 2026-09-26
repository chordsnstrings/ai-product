import { resolveTxt } from 'node:dns/promises';
import { env } from '@arkiv/shared';

/**
 * Sending-domain health for the console (plan 05 §18 "Resend integration: domains (SPF/DKIM/DMARC status)"). With
 * a Resend key it asks Resend for each domain's verification records (SPF, DKIM) and looks up DMARC in DNS; without
 * one it returns fixture statuses for the two sending subdomains, marked as such.
 */
export type RecordStatus = 'verified' | 'pending' | 'failed' | 'missing' | 'unknown';

export interface SendingDomain {
  name: string;
  status: string;
  spf: RecordStatus;
  dkim: RecordStatus;
  dmarc: RecordStatus;
  dmarcPolicy: string | null;
  fixture: boolean;
}

const norm = (s: string | undefined | null): RecordStatus => {
  const v = (s ?? '').toLowerCase();
  if (v === 'verified' || v === 'success') return 'verified';
  if (v === 'pending' || v === 'not_started' || v === 'temporary_failure') return 'pending';
  if (v === 'failed' || v === 'failure') return 'failed';
  return v ? 'unknown' : 'missing';
};

/** DMARC for a sending subdomain: its own record, else the organisational domain's (RFC 7489 §6.6.3). */
export async function dmarcFor(domain: string, lookup: (name: string) => Promise<string[][]> = resolveTxt): Promise<{ status: RecordStatus; policy: string | null }> {
  const labels = domain.split('.');
  const candidates = [domain, ...(labels.length > 2 ? [labels.slice(-2).join('.')] : [])];
  for (const d of candidates) {
    try {
      const txt = (await lookup(`_dmarc.${d}`)).map((r) => r.join('')).find((r) => /^v=DMARC1/i.test(r));
      if (txt) return { status: 'verified', policy: /\bp=(\w+)/i.exec(txt)?.[1]?.toLowerCase() ?? null };
    } catch {
      // not found here; try the organisational domain
    }
  }
  return { status: 'missing', policy: null };
}

/** The two sending subdomains derived from EMAIL_FROM (transactional mail., marketing news.). */
export function sendingDomains(): string[] {
  const from = env().EMAIL_FROM;
  const domain = (/<([^>]+)>/.exec(from)?.[1] ?? from).split('@')[1]?.trim().toLowerCase() ?? 'mail.localhost';
  return [...new Set([domain, domain.replace(/^mail\./, 'news.')])];
}

export async function resendDomains(): Promise<SendingDomain[]> {
  if (!env().RESEND_API_KEY) {
    return sendingDomains().map((name) => ({ name, status: 'not configured (local)', spf: 'unknown', dkim: 'unknown', dmarc: 'unknown', dmarcPolicy: null, fixture: true }));
  }
  const { Resend } = await import('resend');
  const client = new Resend(env().RESEND_API_KEY);
  const list = await client.domains.list();
  if (list.error) throw new Error(`resend: ${list.error.message}`);
  const out: SendingDomain[] = [];
  for (const d of (list.data as { data?: { id: string; name: string; status: string }[] } | null)?.data ?? []) {
    const full = await client.domains.get(d.id);
    const records = ((full.data as { records?: { record: string; status: string }[] } | null)?.records ?? []);
    const worst = (kind: string) => {
      const rs = records.filter((r) => r.record.toUpperCase() === kind).map((r) => norm(r.status));
      return rs.length ? (rs.find((s) => s !== 'verified') ?? 'verified') : 'missing';
    };
    const dmarc = await dmarcFor(d.name);
    out.push({ name: d.name, status: d.status, spf: worst('SPF'), dkim: worst('DKIM'), dmarc: dmarc.status, dmarcPolicy: dmarc.policy, fixture: false });
  }
  return out;
}
