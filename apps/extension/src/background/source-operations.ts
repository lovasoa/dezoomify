/**
 * Self-contained functions passed to scripting.executeScript().
 *
 * These functions deliberately have no imports, closures, listeners, or
 * document state. Firefox and Chromium receive the same operation and the
 * complete structured-cloneable result is returned before the invocation
 * ends, while fetch still returns bounded chunks for the coordinator to
 * forward to the dedicated job tab.
 */

/**
 * Take one bounded snapshot of the source document's retained resource
 * timeline. The document URL and resource entries are collected as one batch
 * so ranking can prefer viewer resources without committing to the document
 * URL merely because it was added first.
 */
type SourceRequest = { url: string; method?: string; headers: Array<{ name: string; value: string }> };
type FetchFailure = { ok: false; code: string; status?: number };
type SourceChunk = { sequence: number; bytes: number[] };

export function collectCandidates(): { ok: true; documentUrl: string; urls: string[]; overflow: number } {
  const MAX_URL_LENGTH = 2048;
  const MAX_CANDIDATES = 100;
  const documentUrl = String(globalThis.location?.href ?? "");
  const raw: unknown[] = [documentUrl];
  try {
    for (const entry of globalThis.performance?.getEntriesByType?.("resource") ?? []) {
      raw.push(typeof entry === "string" ? entry : entry?.name);
    }
  } catch {}

  const urls: string[] = [];
  const seen = new Set<string>();
  let overflow = 0;
  for (const value of raw) {
    if (typeof value !== "string" || value.length === 0 || value.length > MAX_URL_LENGTH) continue;
    let parsed;
    try { parsed = new URL(value); } catch { continue; }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
    if (seen.has(value)) continue;
    seen.add(value);
    if (urls.length >= MAX_CANDIDATES) {
      overflow += 1;
      continue;
    }
    urls.push(value);
  }
  return { ok: true, documentUrl, urls, overflow };
}

/**
 * Fetch one engine-declared source request in the source tab's origin and
 * return only bounded, structured-cloneable data. Cookies/session credentials
 * are supplied by the browser; they are never part of this result.
 */
export async function fetchSource(request: SourceRequest): Promise<FetchFailure | { ok: true; status: number; url: string; bytes: number; chunks: SourceChunk[] }> {
  const MAX_URL_LENGTH = 2048;
  const MAX_FETCH_CHUNK_BYTES = 32 * 1024;
  const MAX_SOURCE_FETCH_BYTES = 8 * 1024 * 1024;
  const validMethods = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
  const fail = (code: string, status?: number): FetchFailure => ({ ok: false, code, ...(Number.isInteger(status) ? { status } : {}) });

  if (!request || typeof request !== "object" || typeof request.url !== "string" || request.url.length === 0 || request.url.length > MAX_URL_LENGTH) {
    return fail("invalid-url");
  }
  let parsed;
  try { parsed = new URL(request.url); } catch { return fail("invalid-url"); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return fail("invalid-url");

  const method = typeof request.method === "string" && request.method.length > 0 ? request.method.toUpperCase() : "GET";
  if (!validMethods.has(method)) return fail("invalid-method");
  if (!Array.isArray(request.headers)) return fail("invalid-headers");
  const headers: Record<string, string> = {};
  for (const header of request.headers) {
    if (!header || typeof header.name !== "string" || typeof header.value !== "string" ||
      !header.name || /[\r\n]/.test(header.name) || /[\r\n]/.test(header.value)) return fail("invalid-headers");
    headers[header.name] = header.value;
  }

  const controller = typeof AbortController === "function" ? new AbortController() : null;
  try {
    const response = await fetch(parsed.href, { method, headers, credentials: "include", signal: controller?.signal });
    const responseUrl = response?.url || parsed.href;
    let responseParsed;
    try { responseParsed = new URL(responseUrl); } catch { return fail("invalid-response"); }
    if (responseParsed.protocol !== "http:" && responseParsed.protocol !== "https:") return fail("invalid-response");
    if (!response || typeof response.status !== "number") return fail("invalid-response");
    if (!response.ok) return fail("http-error", response.status);

    const chunks: SourceChunk[] = [];
    let total = 0;
    let sequence = 0;
    const append = (part: Uint8Array | ArrayBuffer | undefined) => {
      const value = part instanceof Uint8Array ? part : new Uint8Array(part ?? []);
      total += value.byteLength;
      if (total > MAX_SOURCE_FETCH_BYTES) {
        try { controller?.abort?.(); } catch {}
        throw Object.assign(new Error("source response exceeds limit"), { code: "too-large" });
      }
      for (let at = 0; at < value.byteLength; at += MAX_FETCH_CHUNK_BYTES) {
        chunks.push({ sequence: sequence++, bytes: Array.from(value.subarray(at, at + MAX_FETCH_CHUNK_BYTES)) });
      }
    };

    const declared = Number(response.headers?.get?.("content-length"));
    if (Number.isSafeInteger(declared) && declared > MAX_SOURCE_FETCH_BYTES) return fail("too-large");
    const reader = response.body?.getReader?.();
    if (reader) {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        append(part.value);
      }
    } else {
      append(new Uint8Array(await response.arrayBuffer()));
    }
    return { ok: true, status: response.status, url: responseUrl, bytes: total, chunks };
  } catch (error) {
    const caught = error as { code?: unknown; name?: unknown };
    if (caught?.code === "too-large") return fail("too-large");
    return fail(caught?.name === "AbortError" ? "cancelled" : "network");
  }
}
