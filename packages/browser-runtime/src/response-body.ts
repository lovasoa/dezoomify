import { normalizeErrorPreviewText } from "./fetch-primitives.ts";

/** Read a bounded body, cancelling the reader on limits, abort, and completion. */
export async function readResponseBytes(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
  prefix = false,
): Promise<Uint8Array<ArrayBuffer>> {
  signal?.throwIfAborted();
  const oversized = () =>
    Object.assign(new Error(`response exceeds ${maxBytes} byte limit`), {
      code: "TRANSPORT_SIZE_LIMIT",
    });
  if (!prefix && Number(response.headers.get("content-length")) > maxBytes) {
    void response.body?.cancel().catch(() => {});
    throw oversized();
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const next = await reader.read();
      signal?.throwIfAborted();
      if (next.done) break;
      if (!prefix && next.value.byteLength > maxBytes - length) throw oversized();
      const chunk = next.value.subarray(0, maxBytes - length);
      chunks.push(chunk);
      length += chunk.byteLength;
      if (prefix && length === maxBytes) break;
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    cancel();
    reader.releaseLock();
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export async function readErrorPreview(response: Response, signal?: AbortSignal): Promise<string> {
  try {
    const bytes = await readResponseBytes(response, 4096, signal, true);
    return normalizeErrorPreviewText(new TextDecoder().decode(bytes), 300);
  } catch {
    return "";
  }
}

export function retryAfterMs(
  value: string | null | undefined,
  now = Date.now(),
): number | undefined {
  if (!value?.trim()) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.floor(seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}
