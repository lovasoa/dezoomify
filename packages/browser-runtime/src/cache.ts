// Bounded LRU cache for explicitly classified non-secret resources.
export type CacheSensitivity =
  | "public-non-credential"
  | "credential-bearing"
  | "auth-dependent"
  | "private"
  | "signed-url"
  | "handoff"
  | "unknown";

export interface ClassifyInput {
  url: string;
  headers?: Record<string, string>;
  sensitivity?: CacheSensitivity;
}

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

export function hasSensitiveQuery(urlString: string): boolean {
  try {
    const u = new URL(urlString);
    for (const k of u.searchParams.keys()) {
      if (SENSITIVE_QUERY_KEYS.has(k.toLowerCase())) return true;
    }
    return false;
  } catch {
    return true;
  }
}

export function classifyCacheability(input: ClassifyInput): {
  cacheable: boolean;
  reason: string;
} {
  const { url, headers, sensitivity } = input;
  if (sensitivity !== "public-non-credential") {
    const s = sensitivity ?? "unknown";
    return { cacheable: false, reason: `sensitivity-rejected:${s}` };
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { cacheable: false, reason: "invalid-url" };
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return { cacheable: false, reason: "url-userinfo-rejected" };
  }
  if (hasSensitiveQuery(url)) {
    return { cacheable: false, reason: "signed-query-rejected" };
  }
  if (headers) {
    for (const k of Object.keys(headers)) {
      const l = k.toLowerCase();
      if (l === "cookie" || l === "authorization" || l === "proxy-authorization") {
        return { cacheable: false, reason: `credential-header-rejected:${l}` };
      }
    }
  }
  const host = parsed.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    return { cacheable: false, reason: "private-host-rejected" };
  }
  return { cacheable: true, reason: "public-non-credential" };
}

/** Derive a cache key that excludes secrets (no fragment, no sensitive query). */
export function deriveCacheKey(urlString: string): string {
  const u = new URL(urlString);
  if (u.username !== "" || u.password !== "") {
    throw new Error("cannot derive cache key for credential-bearing URL");
  }
  // Drop fragment; drop sensitive query params; sort remaining for stability.
  const kept: Array<[string, string]> = [];
  for (const [k, v] of u.searchParams.entries()) {
    if (SENSITIVE_QUERY_KEYS.has(k.toLowerCase())) continue;
    kept.push([k, v]);
  }
  kept.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const q = kept.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
  const base = `${u.protocol}//${u.host}${u.pathname}`;
  return q ? `${base}?${q}` : base;
}

export interface BrowserCache {
  get(key: string): ArrayBuffer | undefined;
  set(key: string, bytes: ArrayBuffer): void;
  clear(): void;
  readonly entryCount: number;
  readonly byteSize: number;
  keys(): string[];
}

export function createBrowserCache(opts: { maxBytes: number; maxEntries: number }): BrowserCache {
  const { maxBytes, maxEntries } = opts;
  const store = new Map<string, ArrayBuffer>();
  let bytes = 0;

  function evictIfNeeded(): void {
    while ((store.size > maxEntries || bytes > maxBytes) && store.size > 0) {
      const oldest = store.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      const v = store.get(oldest);
      if (v) bytes -= v.byteLength;
      store.delete(oldest);
    }
  }

  return {
    get(key: string): ArrayBuffer | undefined {
      const v = store.get(key);
      if (v === undefined) return undefined;
      // Refresh LRU order.
      store.delete(key);
      store.set(key, v);
      return v.slice(0);
    },
    set(key: string, value: ArrayBuffer): void {
      if (store.has(key)) {
        const old = store.get(key);
        if (old) bytes -= old.byteLength;
        store.delete(key);
      }
      const copy = value.slice(0);
      // Single entry larger than quota: store it alone (evict everything else).
      if (copy.byteLength > maxBytes || maxEntries < 1) {
        store.clear();
        bytes = 0;
        if (maxEntries >= 1 && copy.byteLength <= maxBytes) {
          store.set(key, copy);
          bytes = copy.byteLength;
        }
        return;
      }
      store.set(key, copy);
      bytes += copy.byteLength;
      evictIfNeeded();
    },
    clear(): void {
      store.clear();
      bytes = 0;
    },
    get entryCount(): number {
      return store.size;
    },
    get byteSize(): number {
      return bytes;
    },
    keys(): string[] {
      return [...store.keys()];
    },
  };
}
