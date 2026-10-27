/** Passive document/resource evidence; format recognition belongs to Rust. */
import type { DiscoveryInputKind, JobInput } from "@dezoomify/wasm-bindings";

export const sourceSnapshotLimits = {
  urlLength: 2048,
  documentBytes: 8 * 1024 * 1024,
  resourceBytes: 1024 * 1024,
};

/** The document precedes URL-only resources. Overflow counts resource entries
 * omitted by the URL byte budget. */
export interface SourceSnapshot {
  ok: true;
  documentUrl: string;
  inputs: JobInput[];
  overflow: number;
}

/** One finite snapshot after explicit source access. Pass limits as arguments:
 * scripting.executeScript serializes this function without module scope.
 * URL evidence has its own byte budget, independent of discovery's read budget.
 * The job page owns frame traversal and validates the reply before using it. */
export function collectCandidates(limits: typeof sourceSnapshotLimits): SourceSnapshot {
  const documentUrl = String(globalThis.location?.href ?? "");
  const inputs: JobInput[] = [];
  const seen = new Set<string>();
  const encoder = new TextEncoder();
  let resourceBytes = 0;
  let overflow = 0;
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
    const bytes = encoder.encode(value).byteLength;
    if (kind === "observed-resource" && resourceBytes + bytes > limits.resourceBytes) {
      overflow++;
      return;
    }
    seen.add(value);
    if (kind === "observed-resource") resourceBytes += bytes;
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
  return { ok: true, documentUrl, inputs, overflow };

  function imageDocument() {
    return globalThis.document?.contentType?.startsWith("image/") ?? false;
  }
}
