import type {
  BrowserApplicationContext,
  BrowserCapabilities,
} from "@dezoomify/browser-runtime/application";
import type {
  Error as JobError,
  JobInput,
  Output,
  ResourceRead,
  ResourceRequest,
} from "@dezoomify/wasm-bindings";

type Image = {
  url: string;
  blob: Blob;
  width: number;
  height: number;
  format: "jpeg" | "png" | "webp";
};

function imageBlob(bytes: ArrayLike<number>): { blob: Blob; format: Image["format"] } | undefined {
  let format: Image["format"];
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) format = "jpeg";
  else if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)
    format = "png";
  else if (
    String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) === "RIFF" &&
    String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]) === "WEBP"
  )
    format = "webp";
  else return undefined;
  return { format, blob: new Blob([new Uint8Array(bytes).buffer], { type: `image/${format}` }) };
}

/** A browser convenience after tiled discovery fails, independent of the core. */
export function createLoadedImageFallback(
  context: BrowserApplicationContext,
  fetchResource: BrowserCapabilities["fetchResource"],
  save: BrowserCapabilities["save"],
) {
  const images = new Map<string, Blob | undefined>();
  const resources = new Set<string>();
  let cachedBytes = 0;
  let preview: string | undefined;

  function observe(snapshot: { inputs: JobInput[]; images?: string[] }) {
    for (const input of snapshot.inputs) {
      if (resources.size < 256) resources.add(input.url);
    }
    for (const url of snapshot.images ?? []) {
      if (images.size < 64 && !images.has(url)) images.set(url, undefined);
    }
  }

  function record(request: ResourceRequest, read: ResourceRead) {
    if (
      request.purpose !== "metadata" ||
      read.kind !== "response" ||
      !resources.has(request.uri) ||
      images.get(request.uri)
    )
      return;
    const image = imageBlob(read.response.bytes);
    if (!image || (images.size >= 64 && !images.has(request.uri))) return;
    if (!images.has(request.uri)) images.set(request.uri, undefined);
    if (!images.get(request.uri) && cachedBytes + image.blob.size <= 16 * 1024 * 1024) {
      images.set(request.uri, image.blob);
      cachedBytes += image.blob.size;
    }
  }

  async function measure(url: string): Promise<Image | undefined> {
    context.signal.throwIfAborted();
    let blob = images.get(url);
    if (!blob) {
      const read = await fetchResource(
        { uri: url, headers: [], purpose: "probe" },
        context.signal,
        "allowed",
      );
      if (read.kind !== "response") return undefined;
      blob = imageBlob(read.response.bytes)?.blob;
    }
    if (!blob) return undefined;
    const bitmap = await createImageBitmap(blob);
    try {
      context.signal.throwIfAborted();
      const { width, height } = bitmap;
      if (Math.min(width, height) < 512 || width * height < 2_000_000) return undefined;
      return { url, blob, width, height, format: blob.type.slice(6) as Image["format"] };
    } finally {
      bitmap.close();
    }
  }

  async function recover(error: JobError): Promise<Output | undefined> {
    if (!["discovery-failed", "malformed-metadata", "no-image-found"].includes(error.kind))
      return undefined;
    let largest: Image | undefined;
    const urls = [...images.keys()];
    for (let start = 0; start < urls.length; start += 4) {
      const results = await Promise.allSettled(urls.slice(start, start + 4).map(measure));
      context.signal.throwIfAborted();
      for (const result of results) {
        if (
          result.status === "fulfilled" &&
          result.value &&
          (!largest || result.value.width * result.value.height > largest.width * largest.height)
        )
          largest = result.value;
      }
    }
    if (!largest) return undefined;
    images.clear();
    resources.clear();
    context.diagnostics.record("warn", "discovery-fallback", error);
    const { width, height, blob, format, url } = largest;
    context.diagnostics.record("info", "loaded-image", { url, width, height, bytes: blob.size });
    preview = URL.createObjectURL(blob);
    context.view.loadedImage = { width, height, url: preview };
    context.view.offerDesktopApp = false;
    context.update();
    const disposition = await save(blob, width, height, context.signal);
    return { canvas: { width, height }, format, disposition };
  }

  function dispose() {
    if (preview) URL.revokeObjectURL(preview);
    images.clear();
    resources.clear();
  }

  return { observe, record, recover, dispose };
}
