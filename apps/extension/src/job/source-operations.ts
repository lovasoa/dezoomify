/**
 * Source-page functions passed to scripting.executeScript() by the job page.
 *
 * These functions deliberately have no imports, closures, listeners, or
 * document state. Firefox and Chromium receive the same operation and the
 * complete structured-cloneable result is returned before the invocation
 * ends, while fetch returns a single bounded payload to the privileged job
 * page that invoked it.
 */

/**
 * Take one bounded snapshot of rendered document roots followed by retained
 * resource URLs. Same-origin iframe DOM is readable here; cross-origin frames
 * throw on access and are skipped.
 */
import type { FetchFailure, FetchFailureCode } from "@dezoomify/wasm-bindings";

type SourceRequest = {
  url: string;
  method?: string;
  headers: Array<{ name: string; value: string }>;
  operationId?: string;
};

export function collectCandidates(): {
  ok: true;
  documentUrl: string;
  inputs: Array<{ url: string; contents?: string }>;
  overflow: number;
} {
  const MAX_URL_LENGTH = 2048;
  const MAX_CANDIDATES = 100;
  const MAX_DOM_BYTES = 8 * 1024 * 1024;
  const documentUrl = String(globalThis.location?.href ?? "");
  const inputs: Array<{ url: string; contents?: string }> = [];
  const seen = new Set<string>();
  let overflow = 0;
  const append = (value: unknown, contents?: unknown) => {
    if (typeof value !== "string" || value.length === 0 || value.length > MAX_URL_LENGTH) return;
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      return;
    }
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || seen.has(value)) return;
    seen.add(value);
    if (inputs.length >= MAX_CANDIDATES) {
      overflow += 1;
      return;
    }
    let readableContents: string | undefined;
    if (typeof contents === "string" && contents.length > 0) {
      try {
        if (new TextEncoder().encode(contents).byteLength <= MAX_DOM_BYTES)
          readableContents = contents;
      } catch {}
    }
    inputs.push({
      url: value,
      ...(readableContents !== undefined ? { contents: readableContents } : {}),
    });
  };

  const visit = (doc: Document, url: string) => {
    let html = "";
    try {
      html = String(doc.documentElement?.outerHTML ?? "");
    } catch {}
    append(url, html);
    let frames: Element[] = [];
    try {
      frames = Array.from(doc.querySelectorAll?.("iframe") ?? []);
    } catch {}
    for (const element of frames) {
      try {
        const frame = element as HTMLIFrameElement;
        const child = frame.contentDocument;
        if (child) visit(child, String(child.location?.href ?? frame.src ?? ""));
      } catch {}
    }
  };
  try {
    visit(globalThis.document, documentUrl);
  } catch {
    append(documentUrl);
  }

  try {
    for (const entry of globalThis.performance?.getEntriesByType?.("resource") ?? []) {
      append(typeof entry === "string" ? entry : entry?.name);
    }
  } catch {}
  return { ok: true, documentUrl, inputs, overflow };
}

/**
 * Fetch one source request in the source tab's origin and return only
 * bounded, structured-cloneable data. The job page validates URL, method,
 * and headers before injection; this function performs tab-side I/O.
 * Credentials default to
 * same-origin: the page's session applies to its own origin, while public
 * cross-origin metadata uses ordinary CORS instead of credentialed CORS.
 * The body travels as one base64 payload via the native codec (the
 * extension minimums guarantee it): execution results must stay
 * JSON-serializable in Chrome, so typed arrays are not used. The
 * job page retries an eligible source failure through the extension-origin
 * transport. Cookies/session credentials are never part of this result.
 */
export async function fetchSource(request: SourceRequest): Promise<
  | { ok: false; error: FetchFailure; documentUrl: string }
  | {
      ok: true;
      status: number;
      url: string;
      bytes: number;
      data: string;
      documentUrl: string;
      contentType?: string;
    }
> {
  const MAX_SOURCE_FETCH_BYTES = 8 * 1024 * 1024;
  const documentUrl = String(globalThis.location?.href ?? "");
  const world = globalThis as typeof globalThis & {
    __dezoomifySourceFetches?: Map<string, AbortController>;
  };
  let controllers = world.__dezoomifySourceFetches;
  if (!controllers) {
    controllers = new Map();
    world.__dezoomifySourceFetches = controllers;
  }
  const fail = (code: FetchFailureCode, message: string, http?: number) => ({
    ok: false as const,
    error: {
      code,
      message,
      recovery: [],
      transport: "browser-session",
      retryable:
        http !== undefined
          ? [408, 425, 429].includes(http) || http >= 500
          : code === "TRANSPORT_NETWORK_ERROR",
      ...(http === undefined ? {} : { http }),
      ...(http === 401 || http === 403 ? { blocked_reason: "forbidden" as const } : {}),
    } satisfies FetchFailure,
    documentUrl,
  });

  const headers: Record<string, string> = {};
  for (const header of request.headers) headers[header.name] = header.value;

  const controller = typeof AbortController === "function" ? new AbortController() : null;
  if (controller && request.operationId) controllers.set(request.operationId, controller);
  try {
    const response = await fetch(request.url, {
      method: request.method ?? "GET",
      headers,
      signal: controller?.signal,
    });
    if (!response || typeof response.status !== "number")
      return fail("TRANSPORT_NETWORK_ERROR", "The source returned an invalid response.");
    if (!response.ok) {
      const result = fail(
        "TRANSPORT_HTTP_ERROR",
        "The website refused this file.",
        response.status,
      );
      const raw = response.headers?.get?.("retry-after");
      if (raw) {
        const seconds = Number(raw);
        const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(raw) - Date.now();
        if (Number.isFinite(delay) && delay >= 0)
          Object.assign(result.error, { retry_after_ms: Math.min(300000, Math.floor(delay)) });
      }
      // Error bodies are local diagnostic signals, never full retained pages.
      const reader = response.body?.getReader?.();
      if (reader) {
        const decoder = new TextDecoder();
        let text = "";
        let remaining = 4096;
        try {
          while (remaining > 0) {
            const part = await reader.read();
            if (part.done) break;
            const bytes = part.value.subarray(0, remaining);
            text += decoder.decode(bytes, { stream: true });
            remaining -= bytes.byteLength;
          }
          text += decoder.decode();
          const preview = text
            .replace(/<[^>]*>/g, " ")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 300);
          if (preview) Object.assign(result.error, { preview });
        } catch {
          // The HTTP refusal remains authoritative if its body is unreadable.
        } finally {
          void reader.cancel().catch(() => {});
        }
      }
      return result;
    }
    const responseUrl =
      typeof response.url === "string" && response.url !== "" ? response.url : request.url;

    const parts: Uint8Array[] = [];
    let total = 0;
    const append = (part: Uint8Array | ArrayBuffer | undefined) => {
      const value = part instanceof Uint8Array ? part : new Uint8Array(part ?? []);
      total += value.byteLength;
      if (total > MAX_SOURCE_FETCH_BYTES) {
        try {
          controller?.abort?.();
        } catch {}
        throw Object.assign(new Error("source response exceeds limit"), { code: "too-large" });
      }
      parts.push(value);
    };

    const declared = Number(response.headers?.get?.("content-length"));
    if (Number.isSafeInteger(declared) && declared > MAX_SOURCE_FETCH_BYTES)
      return fail("TRANSPORT_SIZE_LIMIT", "The source response exceeds the byte limit.");
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
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.byteLength;
    }
    return {
      ok: true,
      status: response.status,
      contentType: String(response.headers?.get?.("content-type") ?? "").slice(0, 256),
      url: responseUrl,
      bytes: total,
      data: bytes.toBase64(),
      documentUrl,
    };
  } catch (error) {
    const caught = error as { code?: unknown; name?: unknown };
    if (caught?.code === "too-large")
      return fail("TRANSPORT_SIZE_LIMIT", "The source response exceeds the byte limit.");
    return caught?.name === "AbortError"
      ? fail("TRANSPORT_CANCELLED", "The source fetch was cancelled.")
      : fail(
          "TRANSPORT_NETWORK_ERROR",
          error instanceof Error ? error.message.slice(0, 4096) : "The source fetch failed.",
        );
  } finally {
    if (request.operationId) controllers.delete(request.operationId);
  }
}

/** Cancel a live fetch in this extension's isolated world for this document. */
export function cancelSourceFetch(operationId: string): void {
  const world = globalThis as typeof globalThis & {
    __dezoomifySourceFetches?: Map<string, AbortController>;
  };
  world.__dezoomifySourceFetches?.get(operationId)?.abort();
}
