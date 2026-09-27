'use client';

import { useEffect } from 'react';

/**
 * Records the landing view of a static campaign page (standard §7 "Click / landing view"), once per page load and
 * after the page has shown: the page itself is cached and can't record anything per visitor. The campaign's
 * query (UTMs, ad id) is read here, from the address the visitor actually opened.
 */
export function LandingBeacon({ page, variant }: { page: string; variant: string | null }) {
  useEffect(() => {
    const body = JSON.stringify({ page, variant, search: window.location.search.slice(0, 1000) });
    const sent = typeof navigator.sendBeacon === 'function' && navigator.sendBeacon('/api/funnel/lp-view', new Blob([body], { type: 'application/json' }));
    if (!sent) fetch('/api/funnel/lp-view', { method: 'POST', keepalive: true, headers: { 'content-type': 'application/json' }, body }).catch(() => {});
  }, [page, variant]);
  return null;
}
