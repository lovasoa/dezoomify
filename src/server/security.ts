// Pure proxy security helpers (no server framework) so node:test can import them.

import { hasSignedQuery } from "../../packages/shared-ui/src/source-url.ts";

export const PROXY_MAX_REDIRECTS = 5;
export const PROXY_MAX_BYTES = 2 * 1024 * 1024;

// Signed/credential query keys deny proxying: URLs whose signature would
// break, or that carry credentials, must never be proxied. The policy lives
// once in `packages/shared-ui/src/source-url.ts` (`hasSignedQuery`) and is
// shared with the browser's proxy-fallback gate in
// `packages/browser-runtime/src/web-fetch.ts`.

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const STRIPPED_INBOUND = new Set([
  "cookie",
  "authorization",
  "proxy-authorization",
  "referer",
  "origin",
  ...HOP_BY_HOP,
]);

// Discovery reads both structured metadata (JSON/XML/YAML manifests,
// JSON-LD IIIF manifests, viewer JS, vendor metadata) and viewer HTML pages
// (a Google Arts & Culture asset page, a krpano embed, an OpenSeadragon
// page). Public images and binary image containers use the same bounded relay.
const METADATA_TYPE =
  /^(?:application\/(?:ld\+)?json|(?:application|text)\/(?:xml|(?:x-)?(?:java|ecma)script)|text\/(?:plain|html|jscript|livescript|javascript1\.[0-5]))$/;

// The client headers the relay forwards upstream. Everything else the
// client sends (cookies, authorization, referer, origin, hop-by-hop) is
// dropped by stripUpstreamHeaders below.
const FORWARDED_CLIENT_HEADERS = ["user-agent", "accept-language", "accept", "range"] as const;

export function forwardedClientHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const lower = lowerClientHeaders(headers);
  const out: Record<string, string> = {};
  for (const name of FORWARDED_CLIENT_HEADERS) {
    const found = lower[name];
    if (found !== undefined) out[name] = found;
  }
  return out;
}

function lowerClientHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const lower: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    appendClientHeader(lower, name, value);
  }
  return lower;
}

function appendClientHeader(
  lower: Record<string, string>,
  name: string,
  value: string | string[] | undefined,
): void {
  if (name.toLowerCase() === "range" && value !== undefined) {
    const ranges = Array.isArray(value) ? value.join(",") : value;
    lower.range = lower.range === undefined ? ranges : `${lower.range},${ranges}`;
    return;
  }
  const first = Array.isArray(value) ? value[0] : value;
  if (typeof first === "string" && first !== "") {
    const key = name.toLowerCase();
    if (lower[key] === undefined) lower[key] = first;
  }
}

function parseNumericPart(part: string): number | null {
  if (part.length === 0) return null;
  let base = 10;
  let digits = part;
  if (/^0[xX][0-9a-fA-F]+$/.test(part)) {
    base = 16;
    digits = part.slice(2);
  } else if (/^0[0-7]*$/.test(part) && part.length > 1) {
    // Leading-zero octal (pure 0-7 digits).
    base = 8;
  } else if (/^[0-9]+$/.test(part)) {
    // Could still be octal-looking but contains 8/9 -> treat as decimal
    // only if it does not look like hex; decimal parse will validate.
    base = 10;
  } else if (/^[0-9a-fA-F]+$/.test(part)) {
    // Bare hex without 0x is ambiguous; treat as decimal only if all decimal.
    return null;
  } else {
    return null;
  }
  const n = parseInt(digits, base);
  if (!Number.isSafeInteger(n) || n < 0) return null;
  return n;
}

/** Parse IPv4 literal (1-4 dot parts, decimal/octal/hex) to uint32, or null. */
export function parseIPv4(host: string): number | null {
  const h = host.trim();
  if (h === "") return null;
  // Reject anything with colons, letters beyond hex, etc. early except valid forms.
  if (h.includes(":")) return null;
  const parts = h.split(".");
  if (parts.length < 1 || parts.length > 4) return null;
  const nums: number[] = [];
  for (const p of parts) {
    if (p === "") return null;
    const n = parseNumericPart(p);
    if (n === null) return null;
    nums.push(n);
  }
  return packIPv4(nums);
}

function packIPv4(nums: number[]): number | null {
  if (nums.length === 1) {
    if (nums[0] > 0xffffffff) return null;
    return nums[0] >>> 0;
  }
  if (nums.length === 2) {
    if (nums[0] > 0xff || nums[1] > 0xffffff) return null;
    return (((nums[0] << 24) >>> 0) + nums[1]) >>> 0;
  }
  if (nums.length === 3) {
    if (nums[0] > 0xff || nums[1] > 0xff || nums[2] > 0xffff) return null;
    return (((nums[0] << 24) >>> 0) + (nums[1] << 16) + nums[2]) >>> 0;
  }
  for (const n of nums) if (n > 0xff) return null;
  return (((nums[0] << 24) >>> 0) + (nums[1] << 16) + (nums[2] << 8) + nums[3]) >>> 0;
}

export function isBlockedIPv4Value(n: number): boolean {
  const v = n >>> 0;
  return BLOCKED_IPV4_RANGES.some(([network, mask]) => (v & mask) >>> 0 === network);
}

const BLOCKED_IPV4_RANGES = [
  [0x00000000, 0xff000000], // 0.0.0.0/8
  [0x0a000000, 0xff000000], // 10.0.0.0/8
  [0x7f000000, 0xff000000], // 127.0.0.0/8 loopback
  [0xa9fe0000, 0xffff0000], // 169.254.0.0/16 link-local and metadata
  [0xac100000, 0xfff00000], // 172.16.0.0/12
  [0xc0a80000, 0xffff0000], // 192.168.0.0/16
  [0xc0000200, 0xffffff00], // 192.0.2.0/24 TEST-NET-1
  [0xc6336400, 0xffffff00], // 198.51.100.0/24 TEST-NET-2
  [0xcb007100, 0xffffff00], // 203.0.113.0/24 TEST-NET-3
  [0xe0000000, 0xe0000000], // 224.0.0.0/4 multicast and 240.0.0.0/4 reserved
] as const;

function normalizeIPv6(host: string): string | null {
  let h = host.toLowerCase();
  // Strip brackets if present.
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  if (!h.includes(":")) return null;
  // Handle embedded IPv4 (e.g. ::ffff:127.0.0.1 or ::ffff:7f00:1 variants).
  const lastColon = h.lastIndexOf(":");
  const tail = h.slice(lastColon + 1);
  if (tail.includes(".")) {
    const embedded = parseIPv4(tail);
    if (embedded === null) return null;
    h = `${h.slice(0, lastColon)}:${((embedded >>> 16) & 0xffff).toString(16)}:${(embedded & 0xffff).toString(16)}`;
  }
  return h;
}

function ipv6Groups(part: string): string[] {
  return part === "" ? [] : part.split(":");
}

function expandIPv6(host: string): number[] | null {
  // Returns 8 groups of 16 bits, or null if not IPv6.
  const h = normalizeIPv6(host);
  if (h === null) return null;
  const halves = h.split("::");
  if (halves.length > 2) return null;
  const head = ipv6Groups(halves[0]);
  const tailGroups = halves.length === 2 ? ipv6Groups(halves[1]) : [];
  for (const g of [...head, ...tailGroups]) {
    if (!/^[0-9a-f]{0,4}$/.test(g) || g === "") return null;
  }
  if (halves.length === 1) {
    if (head.length !== 8) return null;
    return head.map((g) => parseInt(g, 16));
  }
  const missing = 8 - (head.length + tailGroups.length);
  if (missing < 0) return null;
  const groups = [
    ...head.map((g) => parseInt(g, 16)),
    ...new Array(missing).fill(0),
    ...tailGroups.map((g) => parseInt(g, 16)),
  ];
  if (groups.length !== 8) return null;
  return groups;
}

export function isBlockedIPv6(host: string): boolean {
  const groups = expandIPv6(host);
  if (groups === null) return false;
  const allZero = groups.every((g) => g === 0);
  if (allZero) return true; // ::
  // ::1 loopback
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true;
  // fe80::/10 link-local
  if ((groups[0] & 0xffc0) === 0xfe80) return true;
  // fc00::/7 unique-local
  if ((groups[0] & 0xfe00) === 0xfc00) return true;
  // ff00::/8 multicast
  if ((groups[0] & 0xff00) === 0xff00) return true;
  // ::ffff:0:0/96 (IPv4-mapped): check embedded v4
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    const v4 = ((groups[6] << 16) + groups[7]) >>> 0;
    return isBlockedIPv4Value(v4);
  }
  // 64:ff9b::/96 translation prefix -> treat embedded conservatively as blocked
  // :: (compat) with embedded private handled via v4 check above; also block
  // any ::x with low values? Keep minimal: block ::ffff:0:0/96 already.
  return false;
}

export function isAllowedSourceContentType(contentType: string | null | undefined): boolean {
  const base = contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
  return (
    base.startsWith("image/") ||
    base === "application/octet-stream" ||
    base.startsWith("application/vnd.") ||
    METADATA_TYPE.test(base)
  );
}

export function stripUpstreamHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const l = k.toLowerCase();
    if (STRIPPED_INBOUND.has(l)) continue;
    if (l.startsWith("x-forwarded-") || l.startsWith("sec-")) continue;
    // Allow only a narrow safe set upstream.
    if (l === "accept" || l === "accept-language" || l === "user-agent" || l === "range") {
      out[l] = String(v);
    }
  }
  return out;
}

export function buildProxyCorsHeaders(
  websiteOrigin: string,
  requestOrigin?: string,
): Record<string, string> {
  if (requestOrigin !== undefined && requestOrigin !== websiteOrigin) {
    return {};
  }
  return {
    "access-control-allow-origin": websiteOrigin,
    vary: "Origin",
  };
}

export function cacheControlForProxy(): string {
  return "no-store";
}

export function createProxyRequestId(): string {
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Per-origin bucket key: origin only (`scheme://host`
 * with a non-default port). Paths, queries, fragments, userinfo, and case
 * never enter the key, so token-bucket accounting cannot retain secrets.
 * Returns null for unparseable URLs.
 */
export function proxyOriginKey(targetUrl: string): string | null {
  let u: URL;
  try {
    u = new URL(targetUrl);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (host === "") return null;
  const isDefaultPort =
    u.port === "" ||
    (u.protocol === "https:" && u.port === "443") ||
    (u.protocol === "http:" && u.port === "80");
  const hostPart = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  const authority = isDefaultPort ? hostPart : `${hostPart}:${u.port}`;
  return `${u.protocol}//${authority}`;
}

export interface TargetValidation {
  ok: boolean;
  code?: string;
  reason?: string;
}

export function validateProxyTarget(
  targetUrl: string,
  opts?: {
    allowHttp?: boolean;
    resolveHost?: (host: string) => string[] | null;
  },
): TargetValidation {
  let u: URL;
  try {
    u = new URL(targetUrl);
  } catch {
    return { ok: false, code: "PROXY_POLICY_DENIED", reason: "invalid-url" };
  }
  void opts?.allowHttp;
  const lower = u.hostname.toLowerCase().replace(/\.$/, "");
  const reason =
    proxyUrlReason(u) ?? literalHostReason(lower) ?? resolvedHostReason(lower, opts?.resolveHost);
  return reason ? { ok: false, code: "PROXY_POLICY_DENIED", reason } : { ok: true };
}

function proxyUrlReason(u: URL): string | undefined {
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    return "scheme";
  }
  if (u.username !== "" || u.password !== "") {
    return "userinfo";
  }
  if (hasSignedQuery(u)) {
    return "signed-query";
  }
  // Standard ports only unless explicitly allowlisted (not allowlisted here).
  if (u.port !== "") {
    const expected = u.protocol === "https:" ? "443" : "80";
    if (u.port !== expected) {
      return "non-standard-port";
    }
  }
  return undefined;
}

function literalHostReason(lower: string): string | undefined {
  if (lower === "localhost" || lower.endsWith(".localhost")) {
    return "loopback-host";
  }
  if (lower.endsWith(".local") || lower.endsWith(".internal") || lower.endsWith(".lan")) {
    return "private-host";
  }
  // Literal IPv4 in any notation.
  const v4 = parseIPv4(lower);
  if (v4 !== null) {
    if (isBlockedIPv4Value(v4)) {
      return "blocked-ipv4";
    }
  } else if (lower.includes(":")) {
    if (isBlockedIPv6(lower)) {
      return "blocked-ipv6";
    }
  }
  return undefined;
}

function resolvedAddressReason(address: string): string | undefined {
  const v4 = parseIPv4(address);
  if (v4 !== null && isBlockedIPv4Value(v4)) return "dns-rebinding";
  if (address.includes(":") && isBlockedIPv6(address)) return "dns-rebinding-v6";
  if (address.toLowerCase() === "localhost") return "dns-rebinding";
  return undefined;
}

function resolvedHostReason(
  lower: string,
  resolveHost?: (host: string) => string[] | null,
): string | undefined {
  // Optional DNS double-check (rebinding test doubles).
  if (resolveHost) {
    let addrs: string[] | null = null;
    try {
      addrs = resolveHost(lower);
    } catch {
      addrs = null;
    }
    if (addrs) {
      for (const a of addrs) {
        const reason = resolvedAddressReason(a);
        if (reason) return reason;
      }
    }
  }
  return undefined;
}
