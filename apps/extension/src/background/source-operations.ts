/**
 * Self-contained functions passed to scripting.executeScript().
 *
 * These functions deliberately have no imports, closures, listeners, or
 * document state. Firefox and Chromium receive the same operation and the
 * complete structured-cloneable result is returned before the invocation
 * ends, while fetch still returns a single bounded payload for the
 * coordinator to forward to the dedicated job tab.
 */

/**
 * Take one bounded snapshot of rendered document roots followed by retained
 * resource URLs. Same-origin iframe DOM is readable here; cross-origin frames
 * throw on access and are skipped.
 */
type SourceRequest = {
  url: string;
  method?: string;
  headers: Array<{ name: string; value: string }>;
};
type FetchFailure = { ok: false; code: string; status?: number };

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
 * Fetch one coordinator-approved source request in the source tab's origin
 * and return only bounded, structured-cloneable data. The caller owns all
 * validation (url, method, headers); this unit performs only tab-side I/O,
 * so it stays free of validation branches. Credentials default to
 * same-origin: the page's session applies to its own origin, while public
 * cross-origin metadata uses ordinary CORS instead of credentialed CORS.
 * The body travels as one base64 payload via the native codec (the
 * extension minimums guarantee it): execution results must stay
 * JSON-serializable in Chrome, so typed arrays are not used. The
 * coordinator retries a failed source request through the extension-origin
 * transport. Cookies/session credentials are never part of this result.
 */
export async function fetchSource(
  request: SourceRequest,
): Promise<FetchFailure | { ok: true; status: number; url: string; bytes: number; data: string }> {
  const MAX_SOURCE_FETCH_BYTES = 8 * 1024 * 1024;
  const fail = (code: string, status?: number): FetchFailure => ({
    ok: false,
    code,
    ...(Number.isInteger(status) ? { status } : {}),
  });

  const headers: Record<string, string> = {};
  for (const header of request.headers) headers[header.name] = header.value;

  const controller = typeof AbortController === "function" ? new AbortController() : null;
  try {
    const response = await fetch(request.url, {
      method: request.method ?? "GET",
      headers,
      signal: controller?.signal,
    });
    if (!response || typeof response.status !== "number") return fail("invalid-response");
    if (!response.ok) return fail("http-error", response.status);
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
      return fail("too-large");
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
      url: responseUrl,
      bytes: total,
      data: bytes.toBase64(),
    };
  } catch (error) {
    const caught = error as { code?: unknown; name?: unknown };
    if (caught?.code === "too-large") return fail("too-large");
    return fail(caught?.name === "AbortError" ? "cancelled" : "network");
  }
}
