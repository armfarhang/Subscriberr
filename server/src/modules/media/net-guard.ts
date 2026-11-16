import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

// Outbound-request guard for media servers (SSRF hardening). A media server's address is typed by
// an operator, and the app then sends that server's admin token to it. Media servers normally
// live on the LAN, so private ranges must stay reachable; what is refused is everything that is
// never a media server and is a classic SSRF target:
//   - non-http(s) schemes and URLs with embedded credentials,
//   - link-local addresses (169.254.0.0/16 — cloud metadata — and fe80::/10),
//   - the unspecified address (0.0.0.0, ::),
//   - loopback (the container itself), unless explicitly allowed for local development,
//   - HTTP redirects (a redirect would forward the token to a host the operator never entered).

export class BlockedAddressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlockedAddressError';
  }
}

export interface NetGuardOptions {
  /** Allow 127.0.0.0/8, ::1 and "localhost" (development outside Docker only). */
  allowLoopback?: boolean;
}

function ipv4Octets(ip: string): number[] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  return nums.every((n) => n >= 0 && n <= 255) ? nums : null;
}

/** Why an IP literal may not be contacted, or null when it is fine. */
export function blockedIpReason(ip: string, opts: NetGuardOptions = {}): string | null {
  let addr = ip.toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  // IPv4-mapped IPv6 (::ffff:a.b.c.d or ::ffff:hhhh:hhhh) is judged as the IPv4 address.
  const mapped = /^::ffff:(.+)$/.exec(addr);
  if (mapped) {
    const tail = mapped[1]!;
    if (tail.includes('.')) addr = tail;
    else {
      const hex = tail.split(':').map((h) => parseInt(h, 16));
      if (hex.length === 2 && hex.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff)) addr = `${hex[0]! >> 8}.${hex[0]! & 255}.${hex[1]! >> 8}.${hex[1]! & 255}`;
    }
  }
  const v4 = ipv4Octets(addr);
  if (v4) {
    const [a, b] = v4 as [number, number, number, number];
    if (a === 0) return 'the unspecified address (0.0.0.0/8)';
    if (a === 169 && b === 254) return 'a link-local address (169.254.0.0/16)';
    if (a === 127 && !opts.allowLoopback) return 'a loopback address';
    return null;
  }
  if (isIP(addr) === 6) {
    if (/^[0:]+$/.test(addr)) return 'the unspecified address (::)';
    if (/^[0:]*:0*1$/.test(addr)) return opts.allowLoopback ? null : 'a loopback address';
    if (/^fe[89ab][0-9a-f]:/.test(addr)) return 'a link-local address (fe80::/10)';
    return null;
  }
  return null;
}

/** Static checks on a media-server URL (no DNS). Returns a problem description or null. */
export function mediaUrlProblem(raw: string, opts: NetGuardOptions = {}): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'not a valid URL';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'only http:// and https:// addresses are allowed';
  if (url.username || url.password) return 'addresses with an embedded user name or password are not allowed';
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!host) return 'the address has no host';
  if ((host === 'localhost' || host.endsWith('.localhost')) && !opts.allowLoopback) return 'it points at a loopback address';
  if (isIP(host.replace(/^\[|\]$/g, ''))) {
    const reason = blockedIpReason(host, opts);
    if (reason) return `it points at ${reason}`;
  }
  return null;
}

export type Resolver = (host: string) => Promise<string[]>;

const systemResolver: Resolver = async (host) => (await lookup(host, { all: true })).map((a) => a.address);

/**
 * Wraps `fetch` for media-server calls: validates the URL, optionally resolves the host name and
 * refuses blocked addresses, and never follows redirects. Pass `resolve: null` to skip DNS (tests
 * with a mocked fetch never touch the network).
 */
export function guardedFetch(http: typeof fetch, opts: NetGuardOptions & { resolve?: Resolver | null } = {}): typeof fetch {
  const resolve = opts.resolve === undefined ? systemResolver : opts.resolve;
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const problem = mediaUrlProblem(raw, opts);
    if (problem) throw new BlockedAddressError(`Refusing to contact this address: ${problem}.`);
    const host = new URL(raw).hostname.replace(/^\[|\]$/g, '');
    if (resolve && !isIP(host)) {
      let addresses: string[];
      try {
        addresses = await resolve(host);
      } catch {
        throw new Error(`The host name ${host} could not be resolved`);
      }
      for (const address of addresses) {
        const reason = blockedIpReason(address, opts);
        if (reason) throw new BlockedAddressError(`Refusing to contact ${host}: it resolves to ${reason}.`);
      }
    }
    const res = await http(input, { ...init, redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) {
      throw new BlockedAddressError(`The server answered with a redirect (${res.status}); redirects are not followed. Enter the server's final address (for example https:// instead of http://).`);
    }
    return res;
  }) as typeof fetch;
}
