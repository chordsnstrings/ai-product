import { describe, expect, it } from 'vitest';
import { formatDate, formatDateTime, formatTime, tzLabel } from './format';

describe('house date/time format (design §6)', () => {
  const at = '2026-09-23T18:02:09Z'; // 14:02:09 in New York (EDT)

  it('formats dates as "23 Sep 2026" in Eastern time by default', () => {
    expect(formatDate(at)).toBe('23 Sep 2026');
    expect(formatDate(new Date(at))).toBe('23 Sep 2026');
    expect(formatDate(at, { year: false })).toBe('23 Sep');
    // Late UTC evening is still the previous day in New York.
    expect(formatDate('2026-09-24T02:00:00Z')).toBe('23 Sep 2026');
    expect(formatDate('2026-09-24T02:00:00Z', { timeZone: 'UTC' })).toBe('24 Sep 2026');
  });

  it('uses "Sep", never the en-GB "Sept"', () => {
    expect(formatDate('2026-09-05T12:00:00Z')).toBe('5 Sep 2026');
  });

  it('formats times as "14:02 ET" on a 24-hour clock', () => {
    expect(formatTime(at)).toBe('14:02 ET');
    expect(formatTime(at, { seconds: true })).toBe('14:02:09 ET');
    expect(formatTime(at, { zone: false })).toBe('14:02');
    expect(formatTime('2026-09-23T04:05:00Z')).toBe('00:05 ET');
    expect(formatTime(at, { timeZone: 'America/Los_Angeles' })).toBe('11:02 PT');
    expect(formatTime(at, { timeZone: 'UTC' })).toBe('18:02 UTC');
  });

  it('combines date and time', () => {
    expect(formatDateTime(at)).toBe('23 Sep 2026 14:02 ET');
  });

  it('returns an empty string for missing or invalid input', () => {
    expect(formatDate(null)).toBe('');
    expect(formatTime(undefined)).toBe('');
    expect(formatDate('not a date')).toBe('');
  });

  it('labels unknown zones with the platform short name', () => {
    expect(tzLabel('America/New_York')).toBe('ET');
    expect(tzLabel('Asia/Tokyo')).toMatch(/GMT\+9|JST/);
  });
});
