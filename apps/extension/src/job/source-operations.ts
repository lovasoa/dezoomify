/**
 * Source-page functions passed to scripting.executeScript() by the job page.
 *
 * These functions have no runtime imports or closures. Firefox and Chromium receive the same operation and the
 * complete structured-cloneable result is returned before the invocation
 * ends, while fetch returns a single bounded payload to the privileged job
 * page that invoked it.
 */

import type { Error as JobError } from "@dezoomify/wasm-bindings";

type SourceRequest = {
  url: string;
  headers: Array<{ name: string; value: string }>;
  operationId: string;
  deadlineAt: number;
  documentToken: string;
  rangeBytes?: number;
};

type SourceFetch = { controller: AbortController; finished: Promise<void> };

/** A finite permission-filtered probe, also used to bind Firefox 133 documents. */
export function inspectSourceDocument(includeFrames = false) {
  const world = globalThis as typeof globalThis & { __dezoomifyDocumentToken?: string };
  // getRandomValues also works on ordinary HTTP pages, unlike randomUUID.
  world.__dezoomifyDocumentToken ??= crypto.getRandomValues(new Uint32Array(4)).join("-");
  const frames = new Set<string>();
  const append = (value: unknown) => {
    if (frames.size >= 16 || typeof value !== "string" || value.length > 2048) return;
    try {
      const url = new URL(value);
      if (url.protocol === "http:" || url.protocol === "https:") frames.add(url.href);
    } catch {}
  };
  if (includeFrames) {
    collectFrameElements();
    collectFrameResources();
  }
  return {
    documentUrl: String(globalThis.location?.href ?? ""),
    token: world.__dezoomifyDocumentToken,
    frames: [...frames],
  };
  function collectFrameElements(): void {
    const roots: (Document | ShadowRoot)[] = [document];
    const dom = (
      globalThis as { chrome?: { dom?: { openOrClosedShadowRoot(e: Element): ShadowRoot | null } } }
    ).chrome?.dom;
    function shadowRootOf(
      element: Element & { openOrClosedShadowRoot?: ShadowRoot | null },
    ): ShadowRoot | null {
      let shadow = element.shadowRoot;
      try {
        // Chromium's extension DOM API rejects SVG elements. One such
        // element must not discard this document's entire inventory reply.
        shadow = dom?.openOrClosedShadowRoot(element) ?? element.openOrClosedShadowRoot ?? shadow;
      } catch {}
      return shadow;
    }
    let visited = 0;
    while (roots.length > 0 && visited < 2048 && frames.size < 16) {
      const root = roots.shift();
      if (!root) break;
      visitRoot(root);
    }
    function visitRoot(root: Document | ShadowRoot): void {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      for (let node = walker.nextNode(); node && visited++ < 2048; node = walker.nextNode()) {
        visitElement(node);
        if (frames.size >= 16) break;
      }
    }
    function visitElement(node: Node): void {
      const element = node as Element & {
        src?: string;
        openOrClosedShadowRoot?: ShadowRoot | null;
      };
      if (element.localName === "iframe" || element.localName === "frame") append(element.src);
      const shadow = shadowRootOf(element);
      if (shadow) roots.push(shadow);
    }
  }

  function collectFrameResources(): void {
    let entries = 0;
    for (const entry of performance.getEntriesByType("resource")) {
      if (entries++ >= 2048 || frames.size >= 16) break;
      if ((entry as PerformanceResourceTiming).initiatorType === "iframe") append(entry.name);
    }
  }
}

/**
 * Fetch one source request in the source tab's origin and return only
 * bounded, structured-cloneable data. The job page validates URL
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
      contentRange?: string;
      contentLength?: string;
    }
> {
  const MAX_SOURCE_FETCH_BYTES = 8 * 1024 * 1024;
  const maxBytes = Math.min(MAX_SOURCE_FETCH_BYTES, request.rangeBytes ?? MAX_SOURCE_FETCH_BYTES);
  const documentUrl = String(globalThis.location?.href ?? "");
  const world = globalThis as typeof globalThis & {
    __dezoomifySourceFetches?: Map<string, SourceFetch | null>;
    __dezoomifyDocumentToken?: string;
  };
  if (!request.documentToken || world.__dezoomifyDocumentToken !== request.documentToken)
    return {
      ok: false,
      documentUrl,
      error: {
        kind: "policy-denied",
        blocked_reason: "source-document-lost",
        transport: "browser-session",
        detail: "source document changed before fetching",
      },
    };
  let controllers = world.__dezoomifySourceFetches;
  if (!controllers) {
    controllers = new Map();
    world.__dezoomifySourceFetches = controllers;
  }
  const fail = (error: JobError) => ({ ok: false as const, error, documentUrl });

  const headers = Object.fromEntries(request.headers.map(({ name, value }) => [name, value]));

  const { deadlineAt, operationId } = request;
  if (Date.now() >= deadlineAt)
    return fail({
      kind: "timeout",
      transport: "browser-session",
      detail: "the source request timed out",
    });
  if (controllers.get(operationId) === null) {
    controllers.delete(operationId);
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
  controllers.set(operationId, { controller, finished });
  try {
    const response = await fetch(request.url, {
      method: "GET",
      headers,
      signal: controller.signal,
    });
    if (!validResponse(response))
      return fail({
        kind: "network-failure",
        transport: "browser-session",
        detail: "the source returned an invalid response",
      });
    if (!response.ok) return await httpFailure(response);
    return await readSourceResponse(response);
  } catch (error) {
    return classifyFailure(error);
  } finally {
    controller.abort();
    clearTimeout(timer);
    controllers.delete(operationId);
    finish();
  }

  // These helpers must remain inside the serialized executeScript function.
  function validResponse(response: Response): boolean {
    return Boolean(response) && typeof response.status === "number";
  }
  function declaredTooLarge(response: Response): boolean {
    const declared = Number(response.headers?.get?.("content-length"));
    return Number.isSafeInteger(declared) && declared > maxBytes;
  }
  async function httpFailure(response: Response) {
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
    const preview = await errorPreview(response);
    if (preview) Object.assign(result.error, { preview });
    return result;
  }

  async function errorPreview(response: Response): Promise<string | undefined> {
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
        return text
          .replace(/<[^>]*>/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 300);
      } catch {
        // The HTTP refusal remains authoritative if its body is unreadable.
      } finally {
        void reader.cancel().catch(() => {});
      }
    }
    return undefined;
  }

  async function readSourceResponse(response: Response) {
    const responseUrl =
      typeof response.url === "string" && response.url !== "" ? response.url : request.url;

    // This function is injected without module closures. The job page validates
    // exact Content-Range facts; reject an ignored range before reading any body.
    if (request.rangeBytes !== undefined && response.status !== 206)
      return fail({
        kind: "bad-url",
        detail: `invalid byte-range response: expected HTTP 206, received ${response.status}`,
      });

    if (declaredTooLarge(response)) return fail({ kind: "size-limit", max_bytes: maxBytes });

    const parts: Uint8Array[] = [];
    let total = 0;
    function append(part: Uint8Array | ArrayBuffer | undefined): void {
      const value = part instanceof Uint8Array ? part : new Uint8Array(part ?? []);
      total += value.byteLength;
      if (total > maxBytes) {
        controller.abort();
        throw { kind: "size-limit", max_bytes: maxBytes };
      }
      parts.push(value);
    }
    await readBody();
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.byteLength;
    }
    return {
      ok: true as const,
      status: response.status,
      contentType: String(response.headers?.get?.("content-type") ?? "").slice(0, 256),
      ...rangeResponseFacts(response),
      url: responseUrl,
      bytes: total,
      data: bytes.toBase64(),
      documentUrl,
    };
    async function readBody(): Promise<void> {
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
    }
  }

  function rangeResponseFacts(response: Response): {
    contentRange?: string;
    contentLength?: string;
  } {
    return request.rangeBytes === undefined
      ? {}
      : {
          contentRange: String(response.headers?.get?.("content-range") ?? "").slice(0, 256),
          contentLength: response.headers?.get?.("content-length") ?? undefined,
        };
  }

  function classifyFailure(error: unknown) {
    const caught = error as { kind?: unknown; name?: unknown };
    if (timedOut) {
      return fail({
        kind: "timeout",
        transport: "browser-session",
        detail: "the source request timed out",
      });
    }
    if (caught?.kind === "size-limit") return fail({ kind: "size-limit", max_bytes: maxBytes });
    return caught?.name === "AbortError"
      ? fail({ kind: "cancelled" })
      : fail({
          kind: "network-failure",
          transport: "browser-session",
          detail: error instanceof Error ? error.message.slice(0, 4096) : "the source fetch failed",
        });
  }
}

/** Cancel a live fetch in this extension's isolated world for this document. */
export async function cancelSourceFetch(
  operationId: string,
  deadlineAt: number,
  documentToken: string,
): Promise<void> {
  const world = globalThis as typeof globalThis & {
    __dezoomifySourceFetches?: Map<string, SourceFetch | null>;
    __dezoomifyDocumentToken?: string;
  };
  if (!documentToken || world.__dezoomifyDocumentToken !== documentToken) return;
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
