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
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'Permissions-Policy', value: 'camera=(self), microphone=(), geolocation=()' },
          { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
        ],
      },
    ];
  },
};
export default config;
