import { describe, expect, it } from 'vitest';
import { catalogueEnabled, catalogueTheme } from './catalogue';

describe('design-system catalogue gate', () => {
  it('is on in development and test', () => {
    expect(catalogueEnabled({ NODE_ENV: 'development' })).toBe(true);
    expect(catalogueEnabled({ NODE_ENV: 'test', CATALOGUE_ENABLED: '0' })).toBe(true);
  });

  it('is off in production unless explicitly enabled', () => {
    expect(catalogueEnabled({ NODE_ENV: 'production' })).toBe(false);
    expect(catalogueEnabled({ NODE_ENV: 'production', CATALOGUE_ENABLED: '0' })).toBe(false);
    expect(catalogueEnabled({ NODE_ENV: 'production', CATALOGUE_ENABLED: '1' })).toBe(true);
  });

  it('pins only light or dark', () => {
    expect(catalogueTheme('dark')).toBe('dark');
    expect(catalogueTheme('light')).toBe('light');
    expect(catalogueTheme('sepia')).toBeNull();
    expect(catalogueTheme(['dark'])).toBeNull();
    expect(catalogueTheme(undefined)).toBeNull();
  });
});
