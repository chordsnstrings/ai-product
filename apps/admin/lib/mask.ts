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

/** Pick the masked or the clear rendering of each kind of PII for one viewer. */
export function piiView(mask: boolean) {
  return {
    mask,
    email: (v: unknown) => (mask ? maskEmail(v) : String(v ?? '')),
    ip: (v: unknown) => (mask ? maskIp(v) : String(v ?? '')),
    ua: (v: unknown) => (mask ? maskUserAgent(v) : String(v ?? '')),
    name: (v: unknown) => (mask ? maskName(v) : String(v ?? '')),
  };
}
export type PiiView = ReturnType<typeof piiView>;
