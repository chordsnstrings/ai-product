/**
 * PII masking for SUPPORT (plan 05 §0.2 "Tenant read (masked PII)"): enough to recognise a record on a support
 * call ("the j… address at acme"), not enough to copy or contact it. Masked values never reach the browser:
 * pages mask on the server and send ids, not emails, to actions.
 */
export function maskEmail(email: unknown): string {
  const s = String(email ?? '');
  const at = s.lastIndexOf('@');
  if (at < 1) return s ? '•••' : '';
  const local = s.slice(0, at);
  const domain = s.slice(at + 1);
  const dot = domain.lastIndexOf('.');
  const host = dot > 0 ? domain.slice(0, dot) : domain;
  const tld = dot > 0 ? domain.slice(dot) : '';
  return `${local[0]}•••@${host[0] ?? ''}•••${tld}`;
}

export function maskIp(ip: unknown): string {
  const s = String(ip ?? '').replace(/\/\d+$/, '');
  if (!s) return '';
  if (/^\d+\.\d+\.\d+\.\d+$/.test(s)) return `${s.split('.').slice(0, 2).join('.')}.x.x`;
  if (s.includes(':')) return `${s.split(':').slice(0, 2).join(':')}:…`;
  return '•••';
}

/** A device summary (browser · OS) instead of the full user-agent string. */
export function maskUserAgent(ua: unknown): string {
  const s = String(ua ?? '');
  if (!s) return '';
  const browser = /Edg\//.test(s) ? 'Edge' : /Firefox\//.test(s) ? 'Firefox' : /Chrome\//.test(s) ? 'Chrome' : /Safari\//.test(s) ? 'Safari' : 'Other browser';
  const os = /iPhone|iPad/.test(s) ? 'iOS' : /Android/.test(s) ? 'Android' : /Mac OS X/.test(s) ? 'macOS' : /Windows/.test(s) ? 'Windows' : /Linux/.test(s) ? 'Linux' : 'other OS';
  return `${browser} · ${os}`;
}

export function maskName(name: unknown): string {
  const s = String(name ?? '').trim();
  return s ? `${s[0]}.` : '';
}

/** Free text (job errors, payloads): mask any email addresses and IPv4 addresses it contains. */
export function maskText(text: unknown): string {
  return String(text ?? '')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, (m) => maskEmail(m))
    .replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, (m) => maskIp(m));
}

/** Payload keys whose values are secrets or personal data: never shown on a job detail page (plan 05 §12). */
const SECRET_KEY = /(secret|token|password|passw|api[_-]?key|authorization|cookie|signature|credential|session)/i;
const PII_KEY = /(email|phone|address|^ip$|ipAddress|userAgent|firstName|lastName|fullName|customerName)/i;

/**
 * A job payload for display: secret-looking keys are always redacted; personal-data keys are masked, and for
 * masked viewers every remaining string is PII-masked too. Ids, queues and flags stay readable.
 */
export function maskJobPayload(data: unknown, maskPii: boolean, depth = 0): unknown {
  if (depth > 6) return '…';
  if (Array.isArray(data)) return data.slice(0, 50).map((v) => maskJobPayload(v, maskPii, depth + 1));
  if (data && typeof data === 'object') {
    return Object.fromEntries(
      Object.entries(data as Record<string, unknown>).map(([k, v]) => {
        if (SECRET_KEY.test(k)) return [k, '[redacted]'];
        if (PII_KEY.test(k)) return [k, typeof v === 'string' ? (/@/.test(v) ? maskEmail(v) : maskText(v).replace(/\S(?=\S{2})/g, '•')) : '[masked]'];
        return [k, maskJobPayload(v, maskPii, depth + 1)];
      }),
    );
  }
  if (typeof data === 'string') return maskPii ? maskText(data) : data.length > 500 ? `${data.slice(0, 500)}…` : data;
  return data;
}

/** Pick the masked or the clear rendering of each kind of PII for one viewer. */
export function piiView(mask: boolean) {
  return {
    mask,
    email: (v: unknown) => (mask ? maskEmail(v) : String(v ?? '')),
    ip: (v: unknown) => (mask ? maskIp(v) : String(v ?? '')),
    ua: (v: unknown) => (mask ? maskUserAgent(v) : String(v ?? '')),
    name: (v: unknown) => (mask ? maskName(v) : String(v ?? '')),
    text: (v: unknown) => (mask ? maskText(v) : String(v ?? '')),
  };
}
export type PiiView = ReturnType<typeof piiView>;
