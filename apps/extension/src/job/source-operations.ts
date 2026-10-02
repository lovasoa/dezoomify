/**
 * Source-page functions passed to scripting.executeScript() by the job page.
 *
 * These functions have no runtime imports or closures. Firefox and Chromium receive the same operation and the
 * complete structured-cloneable result is returned before the invocation
 * ends, while fetch returns a single bounded payload to the privileged job
 * page that invoked it.
 */

import type { DiscoveryInputKind, Error as JobError, JobInput } from "@dezoomify/wasm-bindings";

type SourceRequest = {
  url: string;
  method?: string;
  headers: Array<{ name: string; value: string }>;
  operationId?: string;
  timeoutMs?: number;
  deadlineAt?: number;
};

type SourceFetch = { controller: AbortController; finished: Promise<void> };

/**
 * Take one bounded snapshot of rendered document roots followed by retained
 * resource URLs. Same-origin iframe DOM is readable here; cross-origin frames
 * throw on access and are skipped.
 */
export function collectCandidates(): {
  ok: true;
  documentUrl: string;
  inputs: JobInput[];
  overflow: number;
} {
  const MAX_URL_LENGTH = 2048;
  const MAX_CANDIDATES = 100;
  const MAX_DOM_BYTES = 8 * 1024 * 1024;
  const documentUrl = String(globalThis.location?.href ?? "");
  const inputs: JobInput[] = [];
  const seen = new Set<string>();
  let overflow = 0;
  const append = (value: unknown, kind: DiscoveryInputKind, contents?: unknown) => {
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
      kind,
      ...(readableContents !== undefined ? { contents: readableContents } : {}),
    });
  };

  const visit = (doc: Document, url: string, kind: DiscoveryInputKind) => {
    let html = "";
    try {
      html = String(doc.documentElement?.outerHTML ?? "");
    } catch {}
    append(url, kind, html);
    let frames: Element[] = [];
    try {
      frames = Array.from(doc.querySelectorAll?.("iframe") ?? []);
    } catch {}
    for (const element of frames) {
      try {
        const frame = element as HTMLIFrameElement;
        const child = frame.contentDocument;
        if (child)
          visit(child, String(child.location?.href ?? frame.src ?? ""), "observed-document");
      } catch {}
    }
  };
  try {
    visit(globalThis.document, documentUrl, "source");
  } catch {
    append(documentUrl, "source");
  }

  try {
    for (const entry of globalThis.performance?.getEntriesByType?.("resource") ?? []) {
      append(typeof entry === "string" ? entry : entry?.name, "observed-resource");
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
  | { ok: false; error: JobError; documentUrl: string }
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
    __dezoomifySourceFetches?: Map<string, SourceFetch | null>;
  };
  let controllers = world.__dezoomifySourceFetches;
  if (!controllers) {
    controllers = new Map();
    world.__dezoomifySourceFetches = controllers;
  }
  const fail = (error: JobError) => ({ ok: false as const, error, documentUrl });

  const headers: Record<string, string> = {};
  for (const header of request.headers) headers[header.name] = header.value;

  const deadlineAt = request.deadlineAt ?? Date.now() + (request.timeoutMs ?? 30_000);
  if (Date.now() >= deadlineAt)
    return fail({
      kind: "timeout",
      transport: "browser-session",
      detail: "the source request timed out",
    });
  if (request.operationId && controllers.get(request.operationId) === null) {
    controllers.delete(request.operationId);
    return fail({ kind: "cancelled" });
  }
  const controller = new AbortController();
  let finish = () => {};
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let timedOut = false;
  const timer = setTimeout(
    () => {
      timedOut = true;
      controller.abort();
    },
    Math.max(0, deadlineAt - Date.now()),
  );
  if (request.operationId) controllers.set(request.operationId, { controller, finished });
  try {
    const response = await fetch(request.url, {
      method: request.method ?? "GET",
      headers,
      signal: controller?.signal,
    });
    if (!response || typeof response.status !== "number")
      return fail({
        kind: "network-failure",
        transport: "browser-session",
        detail: "the source returned an invalid response",
      });
    if (!response.ok) {
      const result = fail({
        kind: "http-error",
        status: response.status,
        request: request.url,
        transport: "browser-session",
      });
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
        throw { kind: "size-limit", max_bytes: MAX_SOURCE_FETCH_BYTES };
      }
      parts.push(value);
    };

    const declared = Number(response.headers?.get?.("content-length"));
    if (Number.isSafeInteger(declared) && declared > MAX_SOURCE_FETCH_BYTES)
      return fail({ kind: "size-limit", max_bytes: MAX_SOURCE_FETCH_BYTES });
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
    const caught = error as { kind?: unknown; name?: unknown };
    if (timedOut) {
      return fail({
        kind: "timeout",
        transport: "browser-session",
        detail: "the source request timed out",
      });
    }
    if (caught?.kind === "size-limit")
      return fail({ kind: "size-limit", max_bytes: MAX_SOURCE_FETCH_BYTES });
    return caught?.name === "AbortError"
      ? fail({ kind: "cancelled" })
      : fail({
          kind: "network-failure",
          transport: "browser-session",
          detail: error instanceof Error ? error.message.slice(0, 4096) : "the source fetch failed",
        });
  } finally {
    controller.abort();
    clearTimeout(timer);
    if (request.operationId) controllers.delete(request.operationId);
    finish();
  }
}

/** Cancel a live fetch in this extension's isolated world for this document. */
export async function cancelSourceFetch(operationId: string, deadlineAt: number): Promise<void> {
  const world = globalThis as typeof globalThis & {
    __dezoomifySourceFetches?: Map<string, SourceFetch | null>;
  };
  world.__dezoomifySourceFetches ??= new Map();
  const requests = world.__dezoomifySourceFetches;
  const running = requests.get(operationId);
  if (running) {
    running.controller.abort();
    await running.finished;
  } else if (running === undefined && Date.now() < deadlineAt) {
    // executeScript may deliver cancellation before the original fetch starts.
    requests.set(operationId, null);
    setTimeout(
      () => {
        if (requests.get(operationId) === null) requests.delete(operationId);
      },
      Math.max(0, deadlineAt - Date.now()),
    );
  }
}
