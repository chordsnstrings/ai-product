import { lookup as dnsLookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net, { type LookupFunction } from 'node:net';
import zlib from 'node:zlib';
import { DomainError } from '@arkiv/shared';

/**
 * Outbound fetches of merchant-supplied URLs (plan 06 Phase 1 #4: "SSRF protection: public IPs only, no redirects
 * to private ranges, size cap"). Every hop is checked before it is requested, and the connection itself resolves
 * through a guarded lookup, so a name that re-resolves to a private address after the check (DNS rebinding) is
 * refused at connect time. Bodies are read as a stream and cut off at the byte cap, after decompression.
 */

// ───────────── Address policy ─────────────

const v4Int = (o: number[]) => ((o[0]! << 24) | (o[1]! << 16) | (o[2]! << 8) | o[3]!) >>> 0;

/** IPv4 special-purpose ranges (IANA registry) that are never a merchant's public web server. */
const V4_BLOCKED: [number[], number][] = [
  [[0, 0, 0, 0], 8], // "this network"
  [[10, 0, 0, 0], 8], // private
  [[100, 64, 0, 0], 10], // carrier-grade NAT
  [[127, 0, 0, 0], 8], // loopback
  [[169, 254, 0, 0], 16], // link-local (cloud metadata)
  [[172, 16, 0, 0], 12], // private
  [[192, 0, 0, 0], 24], // IETF protocol assignments
  [[192, 0, 2, 0], 24], // documentation (TEST-NET-1)
  [[192, 88, 99, 0], 24], // 6to4 relay anycast
  [[192, 168, 0, 0], 16], // private
  [[198, 18, 0, 0], 15], // benchmarking
  [[198, 51, 100, 0], 24], // documentation (TEST-NET-2)
  [[203, 0, 113, 0], 24], // documentation (TEST-NET-3)
  [[224, 0, 0, 0], 4], // multicast
  [[240, 0, 0, 0], 4], // reserved + broadcast
];
const V4_RANGES = V4_BLOCKED.map(([o, bits]) => ({ base: v4Int(o), mask: bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0 }));

function isPublicV4(octets: number[]): boolean {
  const n = v4Int(octets);
  return !V4_RANGES.some((r) => ((n & r.mask) >>> 0) === r.base);
}

/** An IPv6 literal as eight 16-bit groups (a trailing dotted quad is folded in); null when not IPv6. */
function v6Groups(ip: string): number[] | null {
  let s = ip.split('%')[0]!.toLowerCase();
  if (!net.isIPv6(s)) return null;
  const quad = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (quad) {
    const o = quad.slice(1).map(Number);
    s = `${s.slice(0, -quad[0].length)}${((o[0]! << 8) | o[1]!).toString(16)}:${((o[2]! << 8) | o[3]!).toString(16)}`;
  }
  const [head, tail] = s.split('::') as [string, string | undefined];
  const h = head ? head.split(':') : [];
  const t = tail === undefined ? null : tail ? tail.split(':') : [];
  const groups = t === null ? h : [...h, ...Array<string>(8 - h.length - t.length).fill('0'), ...t];
  if (groups.length !== 8) return null;
  return groups.map((g) => parseInt(g, 16));
}

function isPublicV6(g: number[]): boolean {
  const embedded = (hi: number, lo: number) => isPublicV4([hi >> 8, hi & 255, lo >> 8, lo & 255]);
  const zero = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  // Forms that carry an IPv4 address are judged by that address.
  if (zero(0, 5) && g[5] === 0xffff) return embedded(g[6]!, g[7]!); // ::ffff:a.b.c.d (IPv4-mapped)
  if (zero(0, 4) && g[4] === 0xffff && g[5] === 0) return embedded(g[6]!, g[7]!); // ::ffff:0:a.b.c.d (IPv4-translated)
  if (g[0] === 0x64 && g[1] === 0xff9b && zero(2, 6)) return embedded(g[6]!, g[7]!); // 64:ff9b::/96 (NAT64)
  if (g[0] === 0x2002) return embedded(g[1]!, g[2]!); // 2002::/16 (6to4)
  // Otherwise only global unicast 2000::/3 — this drops ::, ::1, IPv4-compatible ::a.b.c.d, 64:ff9b:1::/48,
  // 100::/64, unique-local fc00::/7, link-local fe80::/10, site-local fec0::/10 and multicast ff00::/8.
  if ((g[0]! & 0xe000) !== 0x2000) return false;
  if (g[0] === 0x2001 && g[1]! < 0x0200) return false; // 2001::/23 IETF assignments (Teredo, benchmarking, ORCHID)
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false; // documentation
  if (g[0] === 0x3fff && g[1]! < 0x1000) return false; // 3fff::/20 documentation
  return true;
}

/** Is this IP literal a public unicast address? Anything unparseable is treated as not public (fail closed). */
export function isPublicAddress(ip: string): boolean {
  const s = ip.replace(/^\[|\]$/g, '');
  if (net.isIPv4(s)) return isPublicV4(s.split('.').map(Number));
  const g = v6Groups(s);
  return g ? isPublicV6(g) : false;
}

// ───────────── The guard ─────────────

export interface NetGuard {
  /** Resolve a host name to all of its addresses. */
  resolve(host: string): Promise<{ address: string; family: number }[]>;
  /** May a connection to this address (for this host name) be made? */
  allowAddress(address: string, host: string): boolean;
  allowPort(port: string): boolean;
}

/** Production policy: public unicast addresses on the standard web ports. */
export const publicInternet: NetGuard = {
  resolve: (host) => dnsLookup(host, { all: true, verbatim: true }),
  allowAddress: (address) => isPublicAddress(address),
  allowPort: (port) => port === '' || port === '80' || port === '443',
};

const unreachable = () => new DomainError('INVALID', 'That address is not reachable.');

/** SSRF guard: only http(s) to public addresses (checked for every redirect hop, and again when connecting). */
export async function assertPublicUrl(raw: string, guard: NetGuard = publicInternet): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new DomainError('INVALID', 'That doesn’t look like a web address.');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new DomainError('INVALID', 'Only http(s) links are supported.');
  if (url.username || url.password) throw new DomainError('INVALID', 'Links with credentials are not supported.');
  if (!guard.allowPort(url.port)) throw new DomainError('INVALID', 'Unsupported port.');
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (/^(localhost|.*\.localhost|.*\.local|.*\.internal)$/i.test(host)) throw unreachable();
  const addrs = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await guard.resolve(host).catch(() => []);
  if (!addrs.length) throw new DomainError('INVALID', 'We couldn’t reach that site.');
  if (addrs.some((a) => !guard.allowAddress(a.address, host))) throw unreachable();
  return url;
}

class BlockedAddress extends Error {}

/**
 * The lookup the socket itself uses: resolves through the guard and refuses a private answer, so the address that
 * is connected to is always one that passed the check (no time-of-check/time-of-use gap).
 */
function guardedLookup(guard: NetGuard): LookupFunction {
  return (hostname, options, callback) => {
    guard.resolve(hostname).then(
      (all) => {
        const family = options.family === 'IPv4' ? 4 : options.family === 'IPv6' ? 6 : options.family;
        const addrs = family === 4 || family === 6 ? all.filter((a) => a.family === family) : all;
        if (!addrs.length) return callback(Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' }), '', 0);
        if (all.some((a) => !guard.allowAddress(a.address, hostname))) return callback(new BlockedAddress(hostname), '', 0);
        if (options.all) return callback(null, addrs.map((a) => ({ address: a.address, family: a.family })));
        callback(null, addrs[0]!.address, addrs[0]!.family);
      },
      (e: NodeJS.ErrnoException) => callback(e, '', 0),
    );
  };
}

export interface GuardedResponse {
  finalUrl: string;
  status: number;
  contentType: string;
  body: Buffer;
  /** The body went past the byte cap and was cut off there. */
  truncated: boolean;
}

export interface GuardedRequestOptions {
  accept: string;
  maxBytes: number;
  timeoutMs?: number;
  maxRedirects?: number;
  guard?: NetGuard;
}

const USER_AGENT = 'ArkivBot/1.0 (+product import; merchant-initiated)';

type Hop = { redirect: string } | { status: number; contentType: string; body: Buffer; truncated: boolean };

function requestOnce(url: URL, o: Required<GuardedRequestOptions>): Promise<Hop> {
  return new Promise<Hop>((resolve, reject) => {
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(
      url,
      {
        method: 'GET',
        agent: false,
        lookup: guardedLookup(o.guard),
        headers: { Accept: o.accept, 'Accept-Encoding': 'gzip, deflate, br', 'User-Agent': USER_AGENT },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = res.headers.location;
        if (status >= 300 && status < 400 && location) {
          res.destroy();
          return done(() => resolve({ redirect: new URL(location, url).toString() }));
        }
        const enc = String(res.headers['content-encoding'] ?? '').toLowerCase().trim();
        const decoder = enc === 'gzip' || enc === 'x-gzip' ? zlib.createGunzip() : enc === 'deflate' ? zlib.createInflate() : enc === 'br' ? zlib.createBrotliDecompress() : null;
        const stream = decoder ? res.pipe(decoder) : res;
        const chunks: Buffer[] = [];
        let size = 0;
        const finish = (truncated: boolean) =>
          done(() => resolve({ status, contentType: String(res.headers['content-type'] ?? ''), body: Buffer.concat(chunks), truncated }));
        stream.on('data', (c: Buffer) => {
          if (settled) return;
          if (size + c.length > o.maxBytes) {
            chunks.push(c.subarray(0, o.maxBytes - size));
            size = o.maxBytes;
            finish(true);
            decoder?.destroy();
            res.destroy();
            req.destroy();
            return;
          }
          size += c.length;
          chunks.push(c);
        });
        stream.on('end', () => finish(false));
        stream.on('error', (e) => done(() => reject(e)));
        res.on('error', (e) => done(() => reject(e)));
      },
    );
    const timer = setTimeout(() => {
      done(() => reject(Object.assign(new Error('timeout'), { name: 'AbortError' })));
      req.destroy();
    }, o.timeoutMs);
    req.on('error', (e) => done(() => reject(e)));
    req.end();
  });
}

/**
 * GET a merchant-supplied URL under the SSRF guard: redirects are followed by hand (each hop re-checked, at most
 * `maxRedirects`), the connection resolves through the guard, and the (decompressed) body stops at `maxBytes`.
 */
export async function guardedRequest(raw: string, opts: GuardedRequestOptions): Promise<GuardedResponse> {
  const o: Required<GuardedRequestOptions> = {
    accept: opts.accept,
    maxBytes: opts.maxBytes,
    timeoutMs: opts.timeoutMs ?? 10_000,
    maxRedirects: opts.maxRedirects ?? 4,
    guard: opts.guard ?? publicInternet,
  };
  let url = await assertPublicUrl(raw, o.guard);
  for (let hop = 0; hop <= o.maxRedirects; hop++) {
    let r: Hop;
    try {
      r = await requestOnce(url, o);
    } catch (e) {
      if (e instanceof BlockedAddress) throw unreachable();
      throw new DomainError('UNAVAILABLE', (e as Error).name === 'AbortError' ? 'The page took too long to respond.' : 'We couldn’t reach that page.');
    }
    if ('redirect' in r) {
      url = await assertPublicUrl(r.redirect, o.guard);
      continue;
    }
    return { finalUrl: url.toString(), ...r };
  }
  throw new DomainError('UNAVAILABLE', 'Too many redirects.');
}
