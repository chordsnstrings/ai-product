import { json, route } from '@/lib/http';
import { resumeForVisitor } from '@/lib/resume';

/**
 * The landing hero's per-visitor state (plan 03 P1): the campaign page itself is static and CDN-cached, so the
 * returning-visitor and signed-in hero is filled in by the browser from here. Never cached.
 */
export const GET = route(async () => json(await resumeForVisitor(), { headers: { 'Cache-Control': 'private, no-store' } }));
