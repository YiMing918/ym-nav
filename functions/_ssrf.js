// Shared SSRF guard for outbound fetches (icon / probe).
//
// Why this exists: icon.js and probe.js used to fetch with
// redirect:'follow', so a public URL could 302 into 127.0.0.1 /
// 169.254.169.254 / an RFC-1918 host and the follow would happily go
// there — the entry-point blockedHost check never saw the hop target.
// Here every hop is fetched with redirect:'manual' and re-validated
// before it is requested.
//
// blockedHost below is a superset of the per-file copies it replaces:
// the original ranges (10/8, 127/8, 0/8, 172.16/12, 192.168/16,
// 169.254/16, localhost / .local / .internal) are kept verbatim, and
// the gaps are closed: IPv6 literals (::1, fc00::/7, fe80::/10,
// v4-mapped / NAT64 / 6to4 embedded IPv4), CGNAT 100.64/10,
// benchmarking 198.18/15, documentation / reserved ranges, multicast,
// and the obvious private-ish domain suffixes. WHATWG URL parsing
// already normalises integer / hex / octal / short IPv4 spellings to
// dotted quads, but a decoder for those raw forms is kept as defence
// in depth in case a hostname ever arrives un-normalised.
// NOTE: hostnames are checked as written (literal IPs / domain
// shape). No DNS resolution happens here, so a public name that
// resolves to a private address (DNS rebinding) is out of scope for
// this layer — same limitation as the original checks.

export const MAX_REDIRECTS = 5;

export class SsrfError extends Error {
  constructor(code, message, status) {
    super(message || code);
    this.name = 'SsrfError';
    this.code = code; // 'blocked' | 'too_many_redirects'
    if (status) this.status = status;
  }
}

function ipv4Blocked(a, b, c, d) {
  if ([a, b, c, d].some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  if (a === 0) return true; // 0.0.0.0/8 "this host on this network"
  if (a === 10) return true; // RFC 1918
  if (a === 127) return true; // loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 169 && b === 254) return true; // link-local (cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC 1918
  if (a === 192 && b === 168) return true; // RFC 1918
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24 IETF special
  if (a === 192 && b === 0 && c === 2) return true; // TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return true; // 6to4 relay (deprecated)
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224 && a < 240) return true; // multicast 224.0.0.0/4
  if (a >= 240) return true; // reserved 240.0.0.0/4 incl. 255.255.255.255
  return false;
}

// Decode a non-standard IPv4 spelling (single integer, 0x-hex parts,
// octal parts, fewer than 4 parts) the way WHATWG URL does. Returns
// [a,b,c,d] or null when it is not a numeric form / overflows.
function decodeNumericIpv4(h) {
  const parts = h.split('.');
  if (parts.length > 4) return null;
  const nums = [];
  for (const p of parts) {
    if (!/^(0x[0-9a-f]+|\d+)$/i.test(p)) return null;
    let n;
    if (/^0x/i.test(p)) n = parseInt(p, 16);
    else if (p.length > 1 && p[0] === '0') n = parseInt(p, 8);
    else n = parseInt(p, 10);
    if (!Number.isFinite(n)) return null;
    nums.push(n);
  }
  const last = nums[nums.length - 1];
  if (nums.slice(0, -1).some((n) => n > 255)) return null;
  if (last >= 256 ** (5 - nums.length)) return null;
  const bytes = nums.slice(0, -1);
  let rest = last;
  const tail = [];
  for (let i = 4 - bytes.length - 1; i >= 0; i--) {
    tail[i] = rest % 256;
    rest = Math.floor(rest / 256);
  }
  return [...bytes, ...tail];
}

function ipv6Blocked(host) {
  let h = host.toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  const zone = h.indexOf('%');
  if (zone >= 0) h = h.slice(0, zone); // fe80::1%eth0 — zone stripped, prefix still checked
  // Embedded dotted IPv4 tail (::ffff:127.0.0.1) -> two hex groups.
  const lastColon = h.lastIndexOf(':');
  if (lastColon >= 0 && h.slice(lastColon + 1).includes('.')) {
    const p = h.slice(lastColon + 1).split('.').map(Number);
    if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
    h = h.slice(0, lastColon + 1) + ((p[0] << 8) | p[1]).toString(16) + ':' + ((p[2] << 8) | p[3]).toString(16);
  }
  const halves = h.split('::');
  if (halves.length > 2) return true;
  const parseSide = (s) => (s === '' ? [] : s.split(':').map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN)));
  const left = parseSide(halves[0]);
  const right = halves.length === 2 ? parseSide(halves[1]) : [];
  if (left.some(Number.isNaN) || right.some(Number.isNaN)) return true;
  let g;
  if (halves.length === 2) {
    const missing = 8 - left.length - right.length;
    if (missing < 0) return true;
    g = [...left, ...Array(missing).fill(0), ...right];
  } else {
    if (left.length !== 8) return true;
    g = left;
  }
  const embeddedV4 = (hi, lo) => ipv4Blocked((hi >> 8) & 255, hi & 255, (lo >> 8) & 255, lo & 255);
  if (g.every((x) => x === 0)) return true; // :: unspecified
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1 loopback
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return embeddedV4(g[6], g[7]); // ::ffff:a.b.c.d v4-mapped
  }
  if (g.slice(0, 6).every((x) => x === 0) && !(g[6] === 0 && g[7] <= 1)) {
    return embeddedV4(g[6], g[7]); // ::a.b.c.d v4-compatible (deprecated)
  }
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((g[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // 2001:db8::/32 documentation
  if (g[0] === 0x0064 && g[1] === 0xff9b) return embeddedV4(g[6], g[7]); // 64:ff9b::/96 NAT64
  if (g[0] === 0x2002) return embeddedV4(g[1], g[2]); // 2002::/16 6to4
  return false;
}

const BLOCKED_SUFFIXES = [
  '.localhost',
  '.local', // mDNS (original rule)
  '.internal', // original rule
  '.localdomain',
  '.lan',
  '.home',
  '.home.arpa',
  '.corp',
  '.intranet',
  '.private',
];

export function isBlockedHost(host) {
  let h = (host || '').toLowerCase();
  if (h.endsWith('.')) h = h.slice(0, -1); // trailing root dot: "localhost." == "localhost"
  if (!h) return true;
  if (h === 'localhost' || h === 'localdomain') return true;
  if (BLOCKED_SUFFIXES.some((s) => h.endsWith(s))) return true;
  if (h.includes(':') || (h.startsWith('[') && h.endsWith(']'))) return ipv6Blocked(h);
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
    const p = h.split('.').map(Number);
    return ipv4Blocked(p[0], p[1], p[2], p[3]);
  }
  // Raw numeric spellings (integer / hex / octal / short) — WHATWG URL
  // normally normalises these before we see them; decode anyway so an
  // un-normalised hostname can never slip a private address past.
  if (h.split('.').every((p) => /^(0x[0-9a-f]+|\d+)$/i.test(p))) {
    const quad = decodeNumericIpv4(h);
    if (!quad) return true; // numeric-looking but undecodable: fail closed
    return ipv4Blocked(quad[0], quad[1], quad[2], quad[3]);
  }
  return false;
}

// Validate an outbound URL. Returns the URL object when it is safe to
// fetch, throws SsrfError('blocked') otherwise. Only http/https, no
// embedded credentials, host must not be loopback/private/reserved.
export function assertSafeUrl(input) {
  let u;
  try { u = input instanceof URL ? input : new URL(String(input)); } catch {
    throw new SsrfError('blocked', 'bad url');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new SsrfError('blocked', 'protocol not allowed: ' + u.protocol);
  }
  if (u.username || u.password) throw new SsrfError('blocked', 'credentials in url');
  if (isBlockedHost(u.hostname)) throw new SsrfError('blocked', 'blocked host: ' + u.hostname);
  return u;
}

function combineSignals(signals) {
  const list = signals.filter(Boolean);
  if (!list.length) return undefined;
  if (list.length === 1) return list[0];
  const ctl = new AbortController();
  for (const s of list) {
    if (s.aborted) { ctl.abort(s.reason); break; }
    s.addEventListener('abort', () => ctl.abort(s.reason), { once: true });
  }
  return ctl.signal;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

// fetch() with manual, per-hop re-validated redirects.
// - The initial URL and EVERY redirect target go through
//   assertSafeUrl() before any request is made; an unsafe hop aborts
//   the whole chain with SsrfError('blocked').
// - At most maxRedirects hops are followed; beyond that it throws
//   SsrfError('too_many_redirects') carrying the last redirect status.
// - timeoutMs, when given, is a single deadline for the whole chain
//   (matching the previous redirect:'follow' + one-signal behaviour).
// opts.fetchImpl is injectable for local dry-run tests.
export async function safeFetch(input, init = {}, opts = {}) {
  const doFetch = opts.fetchImpl || globalThis.fetch;
  const maxRedirects = opts.maxRedirects ?? MAX_REDIRECTS;
  const timeoutMs = opts.timeoutMs || 0;
  let url = assertSafeUrl(input);
  let method = String(init.method || 'GET').toUpperCase();
  let body = init.body;
  let timer = null;
  let deadline = null;
  if (timeoutMs > 0) {
    deadline = new AbortController();
    timer = setTimeout(() => deadline.abort(new Error('timeout')), timeoutMs);
  }
  const signal = combineSignals([init.signal, deadline ? deadline.signal : null]);
  try {
    for (let hop = 0; ; hop++) {
      const res = await doFetch(url.toString(), { ...init, method, body, redirect: 'manual', signal });
      const location = res.headers && typeof res.headers.get === 'function' ? res.headers.get('Location') : null;
      if (!REDIRECT_STATUSES.has(res.status) || !location) return res;
      if (hop >= maxRedirects) {
        try { if (res.body) await res.body.cancel(); } catch { /* ignore */ }
        throw new SsrfError('too_many_redirects', 'more than ' + maxRedirects + ' redirects', res.status);
      }
      let next;
      try { next = new URL(location, url); } catch {
        throw new SsrfError('blocked', 'unparseable redirect location');
      }
      assertSafeUrl(next); // re-validate EVERY hop before following it
      try { if (res.body) await res.body.cancel(); } catch { /* ignore */ }
      if (res.status === 303 && method !== 'GET' && method !== 'HEAD') {
        method = 'GET';
        body = undefined;
      }
      url = next;
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// KV rate-limit gate, isomorphic to the login limiter in
// functions/api/login.js: same KV key scheme ("rl:<scope>:<ip>"),
// same state shape (count + window start + lock-until), same 15-min
// window, same 15-min lock, same 2-day KV TTL. Only the counted event
// and the threshold differ per endpoint, because login counts
// *failures* (5) while these endpoints count *requests* — copying the
// number 5 verbatim would lock a normal nav page (dozens of icons)
// out for 15 minutes. Returns true when the caller must stop (429).
// KV errors fail open (the login state reader degrades the same way):
// a broken limiter must not take the endpoint down with it.
export async function rateLimited(env, request, { scope, limit, windowMs = 15 * 60 * 1000, lockMs = 15 * 60 * 1000 }) {
  if (!env || !env.NAV_KV) return false;
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const key = 'rl:' + scope + ':' + ip;
  try {
    let st = null;
    try { st = JSON.parse((await env.NAV_KV.get(key)) || 'null'); } catch { st = null; }
    const now = Date.now();
    if (st && st.lockUntil && st.lockUntil > now) return true;
    const r = st && st.winStart && now - st.winStart <= windowMs
      ? st
      : { hits: 0, winStart: now, lockUntil: 0 };
    r.hits = (r.hits || 0) + 1;
    if (r.hits > limit) {
      r.lockUntil = now + lockMs;
      await env.NAV_KV.put(key, JSON.stringify(r), { expirationTtl: 2 * 24 * 3600 });
      return true;
    }
    await env.NAV_KV.put(key, JSON.stringify(r), { expirationTtl: 2 * 24 * 3600 });
    return false;
  } catch {
    return false;
  }
}
