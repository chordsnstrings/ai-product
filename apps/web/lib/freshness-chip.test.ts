import { describe, expect, it } from 'vitest';
import { freshnessChip, freshnessChips } from './freshness-chip';

describe('header freshness chip (plan 03 Part B)', () => {
  it('reads like “Meta synced 2h ago”', () => {
    expect(freshnessChip({ provider: 'meta', label: 'Synced 2h ago' })).toBe('Meta synced 2h ago');
    expect(freshnessChip({ provider: 'shopify', label: 'Synced just now' })).toBe('Shopify synced just now');
    expect(freshnessChip({ provider: 'tiktok', label: 'Access revoked — reconnect' })).toBe('TikTok: access revoked — reconnect');
    expect(freshnessChip({ provider: 'meta', label: 'Waiting for first sync' })).toBe('Meta: waiting for first sync');
  });

  it('shows one chip per platform, the least fresh account', () => {
    const rows = [
      { provider: 'meta', label: 'Synced 2h ago', stale: false, lastSuccessAt: '2026-09-26T10:00:00Z' },
      { provider: 'meta', label: 'Synced 9d ago', stale: true, lastSuccessAt: '2026-09-17T10:00:00Z' },
      { provider: 'shopify', label: 'Synced just now', stale: false, lastSuccessAt: '2026-09-26T12:00:00Z' },
    ];
    expect(freshnessChips(rows)).toEqual([
      { key: 'meta', text: 'Meta synced 9d ago', stale: true },
      { key: 'shopify', text: 'Shopify synced just now', stale: false },
    ]);
  });
});
