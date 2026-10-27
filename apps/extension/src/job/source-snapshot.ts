/** Passive document/resource evidence; format recognition belongs to Rust. */
import type { DiscoveryInputKind, JobInput } from "@dezoomify/wasm-bindings";

export const sourceSnapshotLimits = {
  urlLength: 2048,
  documentBytes: 8 * 1024 * 1024,
};

/** The document precedes URL-only resources. */
export interface SourceSnapshot {
  ok: true;
  documentUrl: string;
  inputs: JobInput[];
}

/** One finite snapshot after explicit source access. Pass limits as arguments:
 * scripting.executeScript serializes this function without module scope.
 * Supply the complete URL inventory; Rust ranks it before attempting reads.
 * The job page owns frame traversal and validates the reply before using it. */
export function collectCandidates(limits: typeof sourceSnapshotLimits): SourceSnapshot {
  const documentUrl = String(globalThis.location?.href ?? "");
  const inputs: JobInput[] = [];
  const seen = new Set<string>();
  const encoder = new TextEncoder();
  function readableContents(contents: unknown): string | undefined {
    return typeof contents === "string" &&
      contents.length > 0 &&
      encoder.encode(contents).byteLength <= limits.documentBytes
      ? contents
      : undefined;
  }
  function publicUrl(value: unknown): value is string {
    if (typeof value !== "string" || value.length > limits.urlLength) return false;
    try {
      const protocol = new URL(value).protocol;
      return protocol === "http:" || protocol === "https:";
    } catch {
      return false;
    }
  }
  const append = (value: unknown, kind: DiscoveryInputKind, contents?: unknown) => {
    if (!publicUrl(value) || seen.has(value)) return;
    seen.add(value);
    const supplied = readableContents(contents);
    inputs.push({ url: value, kind, ...(supplied !== undefined ? { contents: supplied } : {}) });
  };

  try {
    const doc = globalThis.document;
    // Metadata tabs need their original bytes; image tabs have a useful HTML wrapper.
    const html =
      doc.contentType === "text/html" ||
      doc.contentType === "application/xhtml+xml" ||
      imageDocument()
        ? String(doc.documentElement?.outerHTML ?? "")
        : undefined;
    append(documentUrl, "source", html);
  } catch {
    append(documentUrl, "source");
  }
  // Standalone images need no favicon or other browser-generated resources.
  if (!imageDocument()) {
    try {
      for (const entry of globalThis.performance?.getEntriesByType?.("resource") ?? []) {
        append(typeof entry === "string" ? entry : entry?.name, "observed-resource");
      }
    } catch {}
  }
  return { ok: true, documentUrl, inputs };

  function imageDocument() {
    return globalThis.document?.contentType?.startsWith("image/") ?? false;
  }
}
