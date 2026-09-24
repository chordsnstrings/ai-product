import type { NextConfig } from 'next';

const config: NextConfig = {
  transpilePackages: ['@arkiv/auth', '@arkiv/billing', '@arkiv/core', '@arkiv/db', '@arkiv/email', '@arkiv/integrations', '@arkiv/shared', '@arkiv/ui', '@arkiv/providers', '@arkiv/media'],
  serverExternalPackages: ['sharp', '@node-rs/argon2', 'postgres', 'file-type', 'heic-decode', 'libheif-js'],
  poweredByHeader: false,
  output: 'standalone',
  outputFileTracingRoot: new URL('../..', import.meta.url).pathname,
  experimental: { serverActions: { bodySizeLimit: '26mb' } },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(self), microphone=(), geolocation=()' },
          { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
        ],
      },
      // Never framed by other sites — except a campaign page's draft preview, which the staff console frames in
      // phone and desktop previews; proxy.ts limits that framing to the console's origin (frame-ancestors).
      { source: '/((?!for/).*)', headers: [{ key: 'X-Frame-Options', value: 'SAMEORIGIN' }] },
      { source: '/for/:path*', missing: [{ type: 'query', key: 'preview' }], headers: [{ key: 'X-Frame-Options', value: 'SAMEORIGIN' }] },
    ];
  },
};
export default config;
