import { describe, expect, it } from 'vitest';
import { shouldMaskPii } from '@arkiv/core';
import { maskEmail, maskIp, maskName, maskText, maskUserAgent, piiView } from './mask';

describe('PII masking for SUPPORT (plan 05 §0.2)', () => {
  it('masks emails, IPs, devices and names', () => {
    expect(maskEmail('jane.doe@acme-labs.com')).toBe('j•••@a•••.com');
    expect(maskEmail('x@y')).toBe('x•••@y•••');
    expect(maskEmail('')).toBe('');
    expect(maskIp('203.0.113.77')).toBe('203.0.x.x');
    expect(maskIp('2001:db8:85a3::8a2e:370:7334')).toBe('2001:db8:…');
    expect(maskIp('10.0.0.1/32')).toBe('10.0.x.x');
    expect(maskUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15')).toBe('Safari · macOS');
    expect(maskUserAgent('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36')).toBe('Chrome · Android');
    expect(maskName('Jane Doe')).toBe('J.');
    expect(piiView(false).email('jane@acme.com')).toBe('jane@acme.com');
    expect(maskText('{"error":"550 mailbox jane.doe@acme.com unavailable from 203.0.113.9"}')).toBe('{"error":"550 mailbox j•••@a•••.com unavailable from 203.0.x.x"}');
    expect(piiView(true).text('to x@y.io')).toBe('to x•••@y•••.io');
  });

  it('applies when the viewer’s only tenant-reading role is SUPPORT and no break-glass is active', () => {
    expect(shouldMaskPii(['SUPPORT'])).toBe(true);
    expect(shouldMaskPii(['SUPPORT'], true)).toBe(false);
    expect(shouldMaskPii(['SUPPORT', 'OPS'])).toBe(false);
    expect(shouldMaskPii(['FINANCE'])).toBe(false);
    expect(shouldMaskPii(['SUPER_ADMIN'])).toBe(false);
    expect(shouldMaskPii(['SUPPORT', 'ANALYST'])).toBe(true);
  });
});
