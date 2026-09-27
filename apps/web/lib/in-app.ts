/**
 * In-app browsers (Instagram, Facebook, TikTok) where ads land: some block the file picker (plan 03 P1 edge cases),
 * so the upload offers the link first and tells people how to open the page in their real browser.
 */
export type InApp = 'Instagram' | 'Facebook' | 'TikTok';

export const IN_APP_UA = /Instagram|FBAN|FBAV|TikTok|musical_ly|BytedanceWebview/i;

export function inAppBrowser(ua: string | null | undefined): InApp | null {
  if (!ua) return null;
  if (/Instagram/i.test(ua)) return 'Instagram';
  if (/FBAN|FBAV/i.test(ua)) return 'Facebook';
  if (/TikTok|musical_ly|BytedanceWebview/i.test(ua)) return 'TikTok';
  return null;
}

/** Where each app hides "open in browser". */
export const OPEN_IN_BROWSER: Record<InApp, string> = {
  Instagram: 'tap ••• at the top right, then “Open in external browser”',
  Facebook: 'tap ••• at the top right, then “Open in browser”',
  TikTok: 'tap ••• at the top right, then “Open in browser”',
};
