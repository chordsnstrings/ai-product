import type { Metadata } from 'next';
import { IBM_Plex_Mono, Instrument_Serif, Inter_Tight } from 'next/font/google';
import '@arkiv/ui/styles.css';

const sans = Inter_Tight({ subsets: ['latin'], variable: '--font-sans-loaded', display: 'swap' });
const serif = Instrument_Serif({ subsets: ['latin'], weight: '400', variable: '--font-serif-loaded', display: 'swap' });
// Design §5: preload only the two above-the-fold files (sans + serif); mono loads on use with font-display: swap.
const mono = IBM_Plex_Mono({ subsets: ['latin'], weight: ['400', '500'], variable: '--font-mono-loaded', display: 'swap', preload: false });

export const metadata: Metadata = { title: { default: 'Arkiv Admin', template: '%s · Arkiv Admin' }, robots: { index: false, follow: false } };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${serif.variable} ${mono.variable}`}>
      <head>
        <style>{`:root{--font-sans:var(--font-sans-loaded),'Inter Tight',system-ui,sans-serif;--font-serif:var(--font-serif-loaded),Georgia,serif;--font-mono:var(--font-mono-loaded),ui-monospace,monospace}`}</style>
      </head>
      <body className="ak-dense ak-admin">{children}</body>
    </html>
  );
}
