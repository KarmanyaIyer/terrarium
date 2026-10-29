// Network policy engine shared by VM and simulated envs. Pure decisions plus a DNS-resolving helper.
// Modes: off (deny all), registries (GET/HEAD to an exact host list), web (public HTTP/HTTPS).
// Non-public addresses are denied in every mode, checked on literals and on every resolved IP.

import dns from "node:dns";
import net from "node:net";
import type { NetworkMode } from "@terrarium/shared";

export const REGISTRY_HOSTS: readonly string[] = Object.freeze([
  "pypi.org",
  "files.pythonhosted.org",
  "registry.npmjs.org",
  "github.com",
  "codeload.github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "raw.githubusercontent.com",
  "dl-cdn.alpinelinux.org",
]);

const REGISTRY_PORTS = new Set([80, 443]);

// git smart-HTTP fetch (clone/pull) is GET info/refs + POST git-upload-pack. Push (receive-pack) stays denied.
const GIT_UPLOAD_PACK = /^\/[^/]+\/[^/]+\/git-upload-pack$/;

// Cloud metadata endpoints that are not covered by the range checks below (or worth naming).
const METADATA_IPS = new Set(["169.254.169.254", "169.254.170.2", "168.63.129.16", "100.100.100.200", "fd00:ec2::254"]);

const INTERNAL_SUFFIXES = [".localhost", ".local", ".localdomain", ".internal", ".home.arpa", ".lan", ".intranet"];
const INTERNAL_NAMES = new Set(["localhost", "localhost.localdomain", "ip6-localhost", "ip6-loopback", "broadcasthost"]);

export interface PolicyRequest {
  method: string;
  url: string;
  /** Every address the host resolved for the URL's hostname. Omitted = only pre-DNS checks. */
  resolvedIps?: string[];
}

export interface PolicyDecision {
  allow: boolean;
  reason: string;
  /** Lowercased hostname without brackets or trailing dot ("" if the URL did not parse). */
  host: string;
}

// ---------- addresses ----------

type V4Range = [base: number, bits: number, label: string];

const V4_RANGES: V4Range[] = [
  [ip4("0.0.0.0"), 8, "unspecified"],
  [ip4("10.0.0.0"), 8, "private"],
  [ip4("100.64.0.0"), 10, "CGNAT"],
  [ip4("127.0.0.0"), 8, "loopback"],
  [ip4("169.254.0.0"), 16, "link-local"],
  [ip4("172.16.0.0"), 12, "private"],
  [ip4("192.0.0.0"), 24, "IETF protocol"],
  [ip4("192.0.2.0"), 24, "documentation"],
  [ip4("192.88.99.0"), 24, "6to4 relay"],
  [ip4("192.168.0.0"), 16, "private"],
  [ip4("198.18.0.0"), 15, "benchmarking"],
  [ip4("198.51.100.0"), 24, "documentation"],
  [ip4("203.0.113.0"), 24, "documentation"],
  [ip4("224.0.0.0"), 4, "multicast"],
  [ip4("240.0.0.0"), 4, "reserved"], // includes 255.255.255.255 broadcast
];

function ip4(s: string): number {
  const p = s.split(".").map(Number);
  return ((p[0]! << 24) | (p[1]! << 16) | (p[2]! << 8) | p[3]!) >>> 0;
}

function v4Category(ip: string): string | null {
  const n = ip4(ip);
  for (const [base, bits, label] of V4_RANGES) {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    if ((n & mask) >>> 0 === base) return label;
  }
  return null;
}

/** 8 hextets, or null if not a valid IPv6 literal. */
function v6Hextets(ip: string): number[] | null {
  if (net.isIPv6(ip) === false) return null;
  let s = ip.toLowerCase();
  const zone = s.indexOf("%");
  if (zone !== -1) s = s.slice(0, zone);
  // Embedded dotted IPv4 tail (::ffff:1.2.3.4) -> two hextets.
  const dot = s.lastIndexOf(".");
  if (dot !== -1) {
    const colon = s.lastIndexOf(":");
    const v4 = ip4(s.slice(colon + 1));
    s = `${s.slice(0, colon + 1)}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const [left, right] = s.includes("::") ? s.split("::") : [s, undefined];
  const l = left ? left.split(":") : [];
  const r = right ? right.split(":") : [];
  const fill = right === undefined ? 0 : 8 - l.length - r.length;
  const parts = [...l, ...Array(fill).fill("0"), ...r].map((h) => parseInt(h, 16));
  return parts.length === 8 && parts.every((h) => h >= 0 && h <= 0xffff) ? parts : null;
}

function hextetsToV4(h: number[], i: number): string {
  return `${h[i]! >> 8}.${h[i]! & 0xff}.${h[i + 1]! >> 8}.${h[i + 1]! & 0xff}`;
}

/** Why an address is not public, or null when it is a public unicast address. */
export function addressCategory(ip: string): string | null {
  const family = net.isIP(ip.split("%")[0]!);
  if (family === 4) return v4Category(ip);
  if (family !== 6) return "invalid";
  const h = v6Hextets(ip);
  if (!h) return "invalid";
  const zeros = (from: number, to: number) => h.slice(from, to).every((x) => x === 0);
  if (zeros(0, 8)) return "unspecified";
  if (zeros(0, 7) && h[7] === 1) return "loopback";
  if (zeros(0, 5) && h[5] === 0xffff) return v4Category(hextetsToV4(h, 6)) ?? "IPv4-mapped"; // ::ffff:a.b.c.d
  if (zeros(0, 4) && h[4] === 0xffff && h[5] === 0) return "IPv4-translated"; // ::ffff:0:a.b.c.d
  if (zeros(0, 6)) return "IPv4-compatible"; // ::a.b.c.d (deprecated)
  if (h[0] === 0x64 && h[1] === 0xff9b) return "NAT64"; // 64:ff9b::/96 and 64:ff9b:1::/48 embed IPv4
  if (h[0] === 0x100 && zeros(1, 4)) return "discard-only";
  if (h[0] === 0x2001 && h[1]! < 0x200) return "IETF protocol"; // 2001::/23 (Teredo, ORCHIDv2, ...)
  if (h[0] === 0x2001 && h[1] === 0xdb8) return "documentation";
  if (h[0] === 0x3fff && h[1]! < 0x1000) return "documentation"; // 3fff::/20
  if (h[0] === 0x2002) return "6to4"; // embeds an arbitrary IPv4, including private ones
  if ((h[0]! & 0xfe00) === 0xfc00) return "ULA";
  if ((h[0]! & 0xffc0) === 0xfe80) return "link-local";
  if ((h[0]! & 0xffc0) === 0xfec0) return "site-local";
  if ((h[0]! & 0xff00) === 0xff00) return "multicast";
  if ((h[0]! & 0xe000) !== 0x2000) return "reserved"; // only 2000::/3 is global unicast
  return null;
}

/** Canonical form for set lookups: IPv4 as-is, IPv6 as 8 full hextets. */
function canonicalIp(ip: string): string {
  const h = net.isIPv6(ip) ? v6Hextets(ip) : null;
  return h ? h.map((x) => x.toString(16)).join(":") : ip;
}

const METADATA_CANON = new Set([...METADATA_IPS].map(canonicalIp));

export function isPublicIp(ip: string): boolean {
  return addressReason(ip) === null;
}

function addressReason(ip: string): string | null {
  if (METADATA_CANON.has(canonicalIp(ip))) return `metadata address ${ip}`;
  const cat = addressCategory(ip);
  return cat === null ? null : `${cat} address ${ip}`;
}

// ---------- requests ----------

function normalizeHost(hostname: string): string {
  let h = hostname.toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  if (h.endsWith(".")) h = h.slice(0, -1);
  return h;
}

function hostnameReason(host: string): string | null {
  if (host === "") return "empty host";
  if (INTERNAL_NAMES.has(host) || INTERNAL_SUFFIXES.some((s) => host.endsWith(s))) return `internal hostname ${host}`;
  if (!host.includes(".") && net.isIP(host) === 0) return `single-label hostname ${host}`;
  return null;
}

/**
 * Decide one HTTP(S) request. Synchronous and pure: callers that have DNS answers pass them in
 * `resolvedIps`; every one of them must be public. Use `resolveAndCheck` to resolve first.
 */
export function checkRequest(mode: NetworkMode, req: PolicyRequest): PolicyDecision {
  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return { allow: false, reason: "invalid URL", host: "" };
  }
  const host = normalizeHost(url.hostname);
  const deny = (reason: string): PolicyDecision => ({ allow: false, reason, host });

  if (mode === "off") return deny("mode off");
  if (url.protocol !== "http:" && url.protocol !== "https:") return deny(`scheme ${url.protocol.slice(0, -1)} not allowed`);
  if (url.username || url.password) return deny("credentials in URL");

  // Address checks first in every mode: the reason then names the internal target.
  if (net.isIP(host)) {
    const r = addressReason(host);
    if (r) return deny(r);
  } else {
    const r = hostnameReason(host);
    if (r) return deny(r);
  }
  for (const ip of req.resolvedIps ?? []) {
    const r = addressReason(ip);
    if (r) return deny(`${host} resolves to ${r}`);
  }
  if (req.resolvedIps && req.resolvedIps.length === 0) return deny(`${host} did not resolve`);

  const method = req.method.toUpperCase();
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;

  if (mode === "registries") {
    if (!REGISTRY_HOSTS.includes(host)) return deny("host not in registries list");
    if (!REGISTRY_PORTS.has(port)) return deny(`port ${port} not allowed in registries mode`);
    if (method === "GET" || method === "HEAD") return { allow: true, reason: "allowed: registries", host };
    if (method === "POST" && host === "github.com" && GIT_UPLOAD_PACK.test(url.pathname)) {
      return { allow: true, reason: "allowed: registries (git fetch)", host };
    }
    return deny(`method ${method} not allowed in registries mode`);
  }

  if (mode === "web") return { allow: true, reason: "allowed: web", host };
  return deny(`unknown mode ${String(mode)}`);
}

export type LookupAll = (hostname: string) => Promise<string[]>;

const defaultLookup: LookupAll = async (hostname) =>
  (await dns.promises.lookup(hostname, { all: true, verbatim: true })).map((a) => a.address);

/**
 * Full decision with DNS: pre-DNS checks, then resolve the hostname and require every address to be
 * public. Returns the resolved IPs so the caller can pin its connection to them (DNS rebinding).
 */
export async function resolveAndCheck(
  mode: NetworkMode,
  req: { method: string; url: string },
  lookup: LookupAll = defaultLookup,
): Promise<PolicyDecision & { ips: string[] }> {
  const pre = checkRequest(mode, req);
  if (!pre.allow) return { ...pre, ips: [] };
  if (net.isIP(pre.host)) return { ...pre, ips: [pre.host] };
  let ips: string[];
  try {
    ips = await lookup(pre.host);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code ?? "lookup error";
    return { allow: false, reason: `DNS lookup failed (${code})`, host: pre.host, ips: [] };
  }
  return { ...checkRequest(mode, { ...req, resolvedIps: ips }), ips };
}

/**
 * `lookup` for node:net / node:http(s) agents that only ever connects to public addresses, so a
 * connection can't be steered to an internal address between the policy check and connect.
 */
export function publicOnlyLookup(lookup: LookupAll = defaultLookup) {
  return (
    hostname: string,
    options: { all?: boolean } | number | ((...a: unknown[]) => void),
    callback?: (err: NodeJS.ErrnoException | null, address: string | { address: string; family: number }[], family?: number) => void,
  ): void => {
    const cb = (typeof options === "function" ? options : callback) as NonNullable<typeof callback>;
    const all = typeof options === "object" && options !== null && options.all === true;
    lookup(hostname).then(
      (ips) => {
        const bad = ips.map(addressReason).find((r) => r !== null) ?? (ips.length === 0 ? "no addresses" : null);
        if (bad) {
          const err: NodeJS.ErrnoException = new Error(`blocked by policy: ${hostname} resolves to ${bad}`);
          err.code = "EPOLICY";
          cb(err, all ? [] : "", 4);
          return;
        }
        const entries = ips.map((address) => ({ address, family: net.isIPv6(address) ? 6 : 4 }));
        if (all) cb(null, entries);
        else cb(null, entries[0]!.address, entries[0]!.family);
      },
      (err: NodeJS.ErrnoException) => cb(err, all ? [] : "", 4),
    );
  };
}
