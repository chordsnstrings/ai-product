import { createHash } from 'node:crypto';
import { globalTx, sideTx, type Tx } from '@arkiv/db';
import { DomainError } from '@arkiv/shared';
import { allowKey, isAllowlisted } from './allowlist';

/**
 * Trust & safety (plan 05 §15). Detectors record abuse signals (an insert-only log staff read in the console);
 * staff answer with time-boxed enforcement: force the bot challenge for a key, tighten its rate limits, or block an
 * IP range. Keys follow the allowlist's normalisation (allowlist.ts) plus `device:<hash>`, `asn:<n>` and
 * `stripe:<customer>`, so an allowlisted agency is never flagged for the heuristics it is allowed to trip.
 */

export const ABUSE_SIGNAL_KINDS = {
  provisional_farm: 'Provisional-workspace farm (many previews from one network, device or ASN)',
  card_testing: 'Card testing (repeated failed payments)',
  preview_cogs_outlier: 'Free-preview COGS outlier',
  prohibited_upload: 'Non-skincare or prohibited product submitted',
  multi_sku_limit: 'Free-preview multi-SKU limit hit',
  prompt_injection: 'Prompt-injection attempt in imported text',
  disposable_email: 'Sign-up with a disposable email domain (allowed, scored)',
  cross_tenant_probe: 'Object ID from another account, or guessed (denied)',
} as const;
export type AbuseSignalKind = keyof typeof ABUSE_SIGNAL_KINDS;

export interface AbuseSignal {
  kind: AbuseSignalKind;
  key: string;
  workspaceId?: string | null;
  detail?: Record<string, unknown>;
}

/** Append one signal (insert-only table; the app, system and staff roles can all add). */
export async function recordAbuseSignal(tx: Tx, s: AbuseSignal): Promise<void> {
  await tx`insert into abuse_signals (kind, key, workspace_id, detail) values (${s.kind}, ${s.key.slice(0, 200)}, ${s.workspaceId ?? null}, ${tx.json((s.detail ?? {}) as never)})`;
}

/** Best-effort variant for request paths: a failure to log never fails the customer's request. */
export async function recordAbuseSignalSafe(s: AbuseSignal): Promise<void> {
  await sideTx((tx) => recordAbuseSignal(tx, s)).catch(() => {});
}

/** Fixed-window counter (the rate_limits table) that only counts: returns the count in the current window. */
export async function tally(tx: Tx, key: string, windowSeconds: number): Promise<number> {
  const [row] = await tx`
    insert into rate_limits (key, window_start, count)
    values (${key}, to_timestamp(floor(extract(epoch from now()) / ${windowSeconds}) * ${windowSeconds}), 1)
    on conflict (key, window_start) do update set count = rate_limits.count + 1
    returning count`;
  return Number(row!.count);
}

// ───────────── Cross-tenant object probes (standard §48) ─────────────

/** Denied object-ID lookups per user (or network, signed out) per hour at which the console shows a spike. */
export const PROBE_SPIKE_PER_HOUR = 20;
export type ProbeTarget = 'workspace' | 'project' | 'asset' | 'sku' | 'experiment';

/**
 * §48 "Cross-tenant object or API ID guessed: authorize every read/write server-side against workspace ownership.
 * Deny and log." The caller has already denied (a 404, so existence can't be probed); this logs it: one
 * `cross_tenant_probe` signal per denial (who, which network, what kind of object and a hash of its id — never the
 * id itself) and a per-user/network hourly counter the console reads as a spike. Best-effort: logging never fails
 * or slows the request's own answer.
 */
export async function noteAccessDenied(p: { userId: string | null; ip: string | null; target: ProbeTarget; targetId: string }): Promise<number> {
  const key = p.userId ? `user:${p.userId}` : (allowKey.ip(p.ip) ?? 'ip:unknown');
  const targetHash = createHash('sha256').update(p.targetId).digest('hex').slice(0, 16);
  return sideTx(async (tx) => {
    const n = await tally(tx, `probe:${key}`, 3600);
    await recordAbuseSignal(tx, { kind: 'cross_tenant_probe', key, detail: { target: p.target, targetHash, network: allowKey.ip(p.ip), thisHour: n, spike: n >= PROBE_SPIKE_PER_HOUR } });
    return n;
  }).catch(() => 0);
}

// ───────────── Client fingerprint (network, device, ASN) ─────────────

export interface ClientFingerprint {
  ip: string | null;
  userAgent?: string | null;
  acceptLanguage?: string | null;
  /** Autonomous system number, when the edge proxy supplies one (header `x-client-asn`). */
  asn?: string | null;
}

/** A coarse device hash (user agent + languages): enough to see one browser minting many workspaces, not to track. */
export function deviceKey(fp: Pick<ClientFingerprint, 'userAgent' | 'acceptLanguage'>): string | null {
  const ua = fp.userAgent?.trim();
  if (!ua) return null;
  return `device:${createHash('sha256').update(`${ua}|${fp.acceptLanguage?.trim() ?? ''}`).digest('hex').slice(0, 16)}`;
}
export const asnKey = (asn: string | null | undefined) => (asn && /^(AS)?\d{1,10}$/i.test(asn.trim()) ? `asn:${asn.trim().replace(/^AS/i, '')}` : null);

/** Provisional workspaces per key per 24 hours before the key is flagged as a farm. */
export const FARM_THRESHOLDS = { ip: 10, device: 8, asn: 60 } as const;

/**
 * A provisional workspace was just created (plan 02 §2.1): count it against its /24, device and ASN, and record a
 * `provisional_farm` signal for every key at or over its daily threshold (each further workspace adds one, so the
 * console's count is the farm's size). Allowlisted keys are skipped. Returns the flagged keys.
 */
export async function noteProvisionalCreated(tx: Tx, workspaceId: string, fp: ClientFingerprint): Promise<string[]> {
  const keys: [string | null, number][] = [
    [allowKey.ip(fp.ip), FARM_THRESHOLDS.ip],
    [deviceKey(fp), FARM_THRESHOLDS.device],
    [asnKey(fp.asn), FARM_THRESHOLDS.asn],
  ];
  const flagged: string[] = [];
  for (const [key, threshold] of keys) {
    if (!key) continue;
    const n = await tally(tx, `farm:${key}`, 86_400);
    if (n < threshold) continue;
    if (await isAllowlisted(tx, [key, allowKey.ws(workspaceId)])) continue;
    await recordAbuseSignal(tx, { kind: 'provisional_farm', key, workspaceId, detail: { workspacesToday: n, threshold } });
    flagged.push(key);
  }
  return flagged;
}

/** Failed card payments per Stripe customer per hour before it is flagged as card testing. */
export const CARD_TESTING_THRESHOLD = 3;
export const CARD_FAILURE_EVENTS = ['charge.failed', 'payment_intent.payment_failed', 'invoice.payment_failed'] as const;

/** A failed card payment (first delivery of the Stripe event). Flags the customer once it reaches the threshold. */
export async function noteFailedPayment(tx: Tx, p: { customerId: string | null; workspaceId: string | null; eventId: string; cardFingerprint?: string | null }): Promise<boolean> {
  const key = p.customerId ? `stripe:${p.customerId}` : p.workspaceId ? allowKey.ws(p.workspaceId)! : null;
  if (!key) return false;
  const n = await tally(tx, `cardfail:${key}`, 3600);
  if (n < CARD_TESTING_THRESHOLD) return false;
  await recordAbuseSignal(tx, { kind: 'card_testing', key, workspaceId: p.workspaceId, detail: { failuresThisHour: n, eventId: p.eventId, card: p.cardFingerprint ?? null } });
  return true;
}

/** Provider spend above this in 7 days, in a provisional or free workspace, is a COGS outlier (micros). */
export const PREVIEW_COGS_OUTLIER_MICROS = 1_000_000;

/**
 * Daily detector (system role, worker sweep): provisional/free workspaces whose provider spend in the last 7 days is
 * above the outlier line get one `preview_cogs_outlier` signal a day. Reads every tenant's ledger by design and
 * ties each row to its own workspace explicitly.
 */
export async function sweepPreviewCogsOutliers(tx: Tx): Promise<number> {
  const rows = await tx`
    select l.workspace_id, sum(l.amount)::bigint as spend, count(*)::int as calls
    from ledger_entries l join workspaces w on w.id = l.workspace_id
    where l.type = 'PROVIDER_COST_RECORDED' and w.state in ('PROVISIONAL', 'ACTIVE_FREE') and not w.is_test
      and l.created_at > now() - interval '7 days'
    group by l.workspace_id having sum(l.amount) > ${PREVIEW_COGS_OUTLIER_MICROS}`;
  let n = 0;
  for (const r of rows) {
    const key = allowKey.ws(r.workspace_id as string)!;
    const [seen] = await tx`select 1 from abuse_signals where kind = 'preview_cogs_outlier' and key = ${key} and at > now() - interval '24 hours' limit 1`;
    if (seen) continue;
    if (await isAllowlisted(tx, [key])) continue;
    await recordAbuseSignal(tx, { kind: 'preview_cogs_outlier', key, workspaceId: r.workspace_id as string, detail: { spendMicros: Number(r.spend), calls: r.calls, days: 7 } });
    n++;
  }
  return n;
}

// ───────────── Prompt injection in imported text ─────────────

const INJECTION_PATTERNS: [string, RegExp][] = [
  ['ignore-instructions', /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|your|the system)\b[^.\n]{0,20}\b(instructions?|prompts?|rules|directions)\b/i],
  ['new-role', /\byou are now\b[^.\n]{0,40}\b(assistant|ai|model|gpt|bot|dan|developer mode|unrestricted)\b/i],
  ['reveal-prompt', /\b(reveal|print|show|repeat|output)\b[^.\n]{0,30}\b(system prompt|hidden (prompt|instructions)|your instructions)\b/i],
  ['role-tags', /<\/?\s*(system|assistant|instructions?|im_start|im_end)\s*>|\[\/?INST\]|<\|im_(start|end)\|>/i],
  ['jailbreak', /\b(jailbreak|do anything now|developer mode enabled)\b/i],
  ['tool-hijack', /\b(call|invoke|use) the (tool|function)\b[^.\n]{0,40}\b(with|to)\b/i],
];

/** Which injection heuristics a piece of imported text trips (empty when none). Deterministic and cheap. */
export function promptInjectionHits(text: string | null | undefined): string[] {
  const t = (text ?? '').slice(0, 200_000);
  if (!t) return [];
  return INJECTION_PATTERNS.filter(([, re]) => re.test(t)).map(([name]) => name);
}

/**
 * Imported text (a product page, pasted or uploaded reviews) is always treated as data, never instructions (§48);
 * this only records the attempt for trust & safety. Returns whether a signal was recorded.
 */
export async function notePromptInjection(tx: Tx, p: { workspaceId: string; source: string; text: string | null | undefined; subject?: { type: string; id: string } }): Promise<boolean> {
  const hits = promptInjectionHits(p.text);
  if (!hits.length) return false;
  await recordAbuseSignal(tx, { kind: 'prompt_injection', key: allowKey.ws(p.workspaceId)!, workspaceId: p.workspaceId, detail: { source: p.source, patterns: hits, subject: p.subject ?? null } });
  return true;
}

// ───────────── Enforcement: IP blocks, forced challenge, tightened limits ─────────────

export interface AbuseGate {
  /** The IP falls in an active block (the request must be refused). */
  blocked: { cidr: string; until: string } | null;
  /** Staff forced the bot challenge for one of the keys. */
  forceChallenge: boolean;
  /** Smallest active rate-limit factor over the keys (1 = normal). */
  rateFactor: number;
}

/** Active enforcement for a request's IP and keys (ip:/24, domain:, ws:, device:…). */
export async function abuseGate(tx: Tx, ip: string | null | undefined, keys: (string | null | undefined)[] = []): Promise<AbuseGate> {
  const ks = [...new Set([allowKey.ip(ip), ...keys].filter((k): k is string => !!k))];
  let blocked: AbuseGate['blocked'] = null;
  if (ip && isInet(ip)) {
    const [b] = await tx`select cidr::text as cidr, until from ip_blocks where lifted_at is null and until > now() and ${ip}::inet <<= cidr order by until desc limit 1`;
    if (b) blocked = { cidr: b.cidr as string, until: new Date(b.until as string).toISOString() };
  }
  if (!ks.length) return { blocked, forceChallenge: false, rateFactor: 1 };
  const [o] = await tx`select bool_or(force_challenge) as challenge, min(rate_limit_factor)::float8 as factor from abuse_overrides where key in ${tx(ks)} and until > now()`;
  return { blocked, forceChallenge: !!o?.challenge, rateFactor: o?.factor == null ? 1 : Math.min(1, Math.max(0.01, Number(o.factor))) };
}

/** Refuse a request from a blocked IP range (FORBIDDEN, no detail about the block). */
export async function assertNotBlocked(ip: string | null | undefined, tx?: Tx): Promise<void> {
  if (!ip || !isInet(ip)) return;
  const run = async (t: Tx) => {
    const [b] = await t`select 1 from ip_blocks where lifted_at is null and until > now() and ${ip}::inet <<= cidr limit 1`;
    if (b) throw new DomainError('FORBIDDEN', 'Requests from your network are temporarily blocked. Contact support if you think this is a mistake.', { blocked: true });
  };
  await (tx ? run(tx) : globalTx(run));
}

function isInet(ip: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) || (/^[0-9a-f:]+$/i.test(ip) && ip.includes(':'));
}

/** A CIDR typed by staff, validated and bounded: IPv4 /16 or narrower, IPv6 /32 or narrower. */
export function normalizeCidr(raw: string): string {
  const v = raw.trim().toLowerCase();
  const [addr, bitsRaw] = v.split('/');
  if (!addr) throw new DomainError('INVALID', 'Enter an IP address or range like 203.0.113.0/24.');
  const v4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(addr) && addr.split('.').every((o) => Number(o) <= 255);
  const v6 = !v4 && /^[0-9a-f:]+$/.test(addr) && addr.includes(':');
  if (!v4 && !v6) throw new DomainError('INVALID', 'Enter an IP address or range like 203.0.113.0/24.');
  const bits = bitsRaw === undefined ? (v4 ? 32 : 128) : Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < (v4 ? 16 : 32) || bits > (v4 ? 32 : 128)) {
    throw new DomainError('INVALID', v4 ? 'IPv4 ranges must be /16 or narrower.' : 'IPv6 ranges must be /32 or narrower.');
  }
  if (v4) {
    const n = addr.split('.').reduce((acc, o) => acc * 256 + Number(o), 0);
    const masked = bits === 0 ? 0 : Math.floor(n / 2 ** (32 - bits)) * 2 ** (32 - bits);
    return `${[24, 16, 8, 0].map((s) => Math.floor(masked / 2 ** s) % 256).join('.')}/${bits}`;
  }
  return `${addr}/${bits}`;
}
