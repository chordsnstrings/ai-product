/**
 * Cloudflare Turnstile (plan 03 P1 edge cases: "bot traffic → Turnstile invisible challenge on submit only").
 * The upload form renders an invisible widget and sends its token as `cf-turnstile-response`; the preview
 * route verifies it here. Disabled entirely when no keys are configured.
 */
export const TURNSTILE_SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export async function verifyTurnstile(
  token: string | null | undefined,
  secret: string,
  remoteIp: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  if (!token) return false;
  try {
    const res = await fetchImpl(SITEVERIFY, { method: 'POST', body: new URLSearchParams({ secret, response: token, remoteip: remoteIp ?? '' }) });
    if (!res.ok) return false;
    const j = (await res.json()) as { success?: boolean };
    return j.success === true;
  } catch {
    return false;
  }
}
