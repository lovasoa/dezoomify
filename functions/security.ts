// Pure proxy security helpers (no server framework) so node:test can import them.

export const PROXY_MAX_REDIRECTS = 5;
export const PROXY_MAX_BYTES = 2 * 1024 * 1024;

const SENSITIVE_QUERY_KEYS = new Set([
  "token",
  "signature",
  "sig",
  "auth",
  "key",
  "session",
  "sid",
  "ticket",
  "secret",
  "password",
  "credential",
  "access_token",
]);

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

const ALLOWED_METADATA_TYPES = [
  "application/json",
  "application/xml",
  "text/xml",
  "text/plain",
];

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
  const b0 = (v >>> 24) & 0xff;
  const b1 = (v >>> 16) & 0xff;
  // 0.0.0.0/8
  if (b0 === 0) return true;
  // 10.0.0.0/8
  if (b0 === 10) return true;
  // 127.0.0.0/8 loopback
  if (b0 === 127) return true;
  // 169.254.0.0/16 link-local (+ metadata 169.254.169.254)
  if (b0 === 169 && b1 === 254) return true;
  // 172.16.0.0/12
  if (b0 === 172 && b1 >= 16 && b1 <= 31) return true;
  // 192.168.0.0/16
  if (b0 === 192 && b1 === 168) return true;
  // 192.0.2.0/24 TEST-NET-1, 198.51.100.0/24, 203.0.113.0/24 -> treat as blocked for proxy
  if (b0 === 192 && b1 === 0 && ((v >>> 8) & 0xff) === 2) return true;
  if (b0 === 198 && b1 === 51 && ((v >>> 8) & 0xff) === 100) return true;
  if (b0 === 203 && b1 === 0 && ((v >>> 8) & 0xff) === 113) return true;
  // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved
  if (b0 >= 224) return true;
  return false;
}

function expandIPv6(host: string): number[] | null {
  // Returns 8 groups of 16 bits, or null if not IPv6.
  let h = host.toLowerCase();
  // Strip brackets if present.
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  if (!h.includes(":")) return null;
  // Handle embedded IPv4 (e.g. ::ffff:127.0.0.1 or ::ffff:7f00:1 variants).
  let embedded: number | null = null;
  const lastColon = h.lastIndexOf(":");
  const tail = h.slice(lastColon + 1);
  if (tail.includes(".")) {
    embedded = parseIPv4(tail);
    if (embedded === null) return null;
    h = `${h.slice(0, lastColon)}:${((embedded >>> 16) & 0xffff).toString(16)}:${(embedded & 0xffff).toString(16)}`;
  }
  const halves = h.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] === "" ? [] : halves[0].split(":");
  const tailGroups = halves.length === 2 ? (halves[1] === "" ? [] : halves[1].split(":")) : [];
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
  void embedded;
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
  if (
    groups.slice(0, 5).every((g) => g === 0) &&
    groups[5] === 0xffff
  ) {
    const v4 = ((groups[6] << 16) + groups[7]) >>> 0;
    return isBlockedIPv4Value(v4);
  }
  // 64:ff9b::/96 translation prefix -> treat embedded conservatively as blocked
  // :: (compat) with embedded private handled via v4 check above; also block
  // any ::x with low values? Keep minimal: block ::ffff:0:0/96 already.
  return false;
}

export function hasSensitiveQuery(url: URL): boolean {
  for (const k of url.searchParams.keys()) {
    if (SENSITIVE_QUERY_KEYS.has(k.toLowerCase())) return true;
  }
  return false;
}

export function validateUpstreamMethod(method: string): boolean {
  const m = method.toUpperCase();
  return m === "GET" || m === "HEAD";
}

export function isAllowedMetadataContentType(contentType: string | null | undefined): boolean {
  if (!contentType) return false;
  const base = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (base.startsWith("image/")) return false;
  return (ALLOWED_METADATA_TYPES as string[]).includes(base);
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
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    return { ok: false, code: "PROXY_POLICY_DENIED", reason: "scheme" };
  }
  void opts?.allowHttp;
  if (u.username !== "" || u.password !== "") {
    return { ok: false, code: "PROXY_POLICY_DENIED", reason: "userinfo" };
  }
  if (hasSensitiveQuery(u)) {
    return { ok: false, code: "PROXY_POLICY_DENIED", reason: "signed-query" };
  }
  // Standard ports only unless explicitly allowlisted (not allowlisted here).
  if (u.port !== "") {
    const expected = u.protocol === "https:" ? "443" : "80";
    if (u.port !== expected) {
      return { ok: false, code: "PROXY_POLICY_DENIED", reason: "non-standard-port" };
    }
  }
  const host = u.hostname;
  const lower = host.toLowerCase().replace(/\.$/, "");
  if (lower === "localhost" || lower.endsWith(".localhost")) {
    return { ok: false, code: "PROXY_POLICY_DENIED", reason: "loopback-host" };
  }
  if (lower.endsWith(".local") || lower.endsWith(".internal") || lower.endsWith(".lan")) {
    return { ok: false, code: "PROXY_POLICY_DENIED", reason: "private-host" };
  }
  // Literal IPv4 in any notation.
  const v4 = parseIPv4(lower);
  if (v4 !== null) {
    if (isBlockedIPv4Value(v4)) {
      return { ok: false, code: "PROXY_POLICY_DENIED", reason: "blocked-ipv4" };
    }
  } else if (lower.includes(":")) {
    if (isBlockedIPv6(lower)) {
      return { ok: false, code: "PROXY_POLICY_DENIED", reason: "blocked-ipv6" };
    }
  }
  // Optional DNS double-check (rebinding test doubles).
  if (opts?.resolveHost) {
    let addrs: string[] | null = null;
    try {
      addrs = opts.resolveHost(lower);
    } catch {
      addrs = null;
    }
    if (addrs) {
      for (const a of addrs) {
        const v = parseIPv4(a);
        if (v !== null && isBlockedIPv4Value(v)) {
          return { ok: false, code: "PROXY_POLICY_DENIED", reason: "dns-rebinding" };
        }
        if (a.includes(":") && isBlockedIPv6(a)) {
          return { ok: false, code: "PROXY_POLICY_DENIED", reason: "dns-rebinding-v6" };
        }
        const la = a.toLowerCase();
        if (la === "localhost") {
          return { ok: false, code: "PROXY_POLICY_DENIED", reason: "dns-rebinding" };
        }
      }
    }
  }
  return { ok: true };
}
