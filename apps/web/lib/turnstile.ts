/**
 * Cloudflare Turnstile widget script (plan 03 P1 edge cases: "bot traffic → Turnstile invisible challenge on submit
 * only"; plan 03 Part C: sign-in past the per-IP limit). Tokens are verified server-side by @arkiv/auth.
 */
export const TURNSTILE_SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
