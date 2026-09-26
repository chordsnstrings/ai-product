import type { NextConfig } from 'next';

/** Staff console (plan 05). Separate origin, never framed, never indexed. */
const config: NextConfig = {
  transpilePackages: ['@arkiv/auth', '@arkiv/billing', '@arkiv/core', '@arkiv/db', '@arkiv/email', '@arkiv/integrations', '@arkiv/shared', '@arkiv/ui', '@arkiv/providers', '@arkiv/media'],
  serverExternalPackages: ['sharp', '@node-rs/argon2', 'postgres', 'file-type'],
  poweredByHeader: false,
  output: 'standalone',
  outputFileTracingRoot: new URL('../..', import.meta.url).pathname,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
          { key: 'Cache-Control', value: 'no-store' },
          { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
        ],
      },
    ];
  },
};
export default config;
