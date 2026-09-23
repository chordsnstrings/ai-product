import type { Metadata, Viewport } from 'next';
import { IBM_Plex_Mono, Instrument_Serif, Inter_Tight } from 'next/font/google';
import '@arkiv/ui/styles.css';

const sans = Inter_Tight({ subsets: ['latin'], variable: '--font-sans-loaded', display: 'swap' });
const serif = Instrument_Serif({ subsets: ['latin'], weight: '400', variable: '--font-serif-loaded', display: 'swap' });
const mono = IBM_Plex_Mono({ subsets: ['latin'], weight: ['400', '500'], variable: '--font-mono-loaded', display: 'swap' });

export const metadata: Metadata = {
  title: { default: 'Arkiv — Know what skincare ad to make next', template: '%s · Arkiv' },
  description: 'Upload your skincare product. Get three test ideas and a storyboard in about a minute. Your first ad is $19.',
  applicationName: 'Arkiv',
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#F5F2EC' },
    { media: '(prefers-color-scheme: dark)', color: '#141312' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${serif.variable} ${mono.variable}`}>
      <head>
        <style>{`:root{--font-sans:var(--font-sans-loaded),'Inter Tight',Inter,system-ui,sans-serif;--font-serif:var(--font-serif-loaded),Georgia,serif;--font-mono:var(--font-mono-loaded),ui-monospace,monospace}`}</style>
      </head>
      <body>{children}</body>
    </html>
  );
}
