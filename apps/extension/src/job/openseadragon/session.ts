import type { Error as JobError } from "@dezoomify/wasm-bindings";
import { transportError } from "../../runtime/fetch.ts";
import { loadOpenSeadragonTile } from "./tile-loader.ts";
import type { MetadataContext, ObservedMetadata } from "./types.ts";

const marker = "#dezoomify-openseadragon-tile/";

interface Source {
  width: number;
  height: number;
  minLevel: number;
  maxLevel: number;
  tileOverlap: number;
  ready: boolean;
  displayRects?: unknown[];
  getLevelScale(level: number): number;
  getTileWidth(level: number): number;
  getTileHeight(level: number): number;
  getNumTiles(level: number): { x: number; y: number };
}

interface Bridge {
  register(source: object, item: object, context: MetadataContext): ObservedMetadata;
  load(url: string, operationId: string, deadlineAt: number): Promise<unknown>;
  cancel(operationId: string): Promise<void>;
  release(bases: string[]): void;
}

type Page = typeof globalThis & { __dezoomifyOpenSeadragon?: Bridge };

/** These fragments name live page capabilities, never HTTP resources. */
export function isOpenSeadragonTile(url: string): boolean {
  return url.includes(marker);
}

export function tileResourceBase(url: string): string | undefined {
  return /^(.*#dezoomify-openseadragon-tile\/[\w-]+\/image)\/\d+\/\d+_\d+\.png$/.exec(url)?.[1];
}

function geometry(source: Source) {
  const { width, height, maxLevel, tileOverlap: overlap = 0 } = source;
  const tileSize = source.getTileWidth(maxLevel);
  if (
    source.ready === false ||
    source.minLevel !== 0 ||
    source.displayRects?.length ||
    Object.hasOwn(source, "getTileBounds") ||
    Object.hasOwn(source, "tileExists") ||
    ![width, height, tileSize].every((n) => Number.isSafeInteger(n) && n > 0 && n <= 0xffffffff) ||
    maxLevel !== Math.ceil(Math.log2(Math.max(width, height))) ||
    !Number.isSafeInteger(overlap) ||
    overlap < 0 ||
    overlap > tileSize
  )
    throw new Error("unsupported OpenSeadragon grid");
  for (let level = 0; level <= maxLevel; level++) {
    const scale = 2 ** (level - maxLevel);
    const count = source.getNumTiles(level);
    if (
      source.getLevelScale(level) !== scale ||
      source.getTileWidth(level) !== tileSize ||
      source.getTileHeight(level) !== tileSize ||
      count.x !== Math.ceil(Math.ceil(width * scale) / tileSize) ||
      count.y !== Math.ceil(Math.ceil(height * scale) / tileSize)
    )
      throw new Error("unsupported OpenSeadragon grid");
  }
  return { width, height, maxLevel, tileSize, overlap };
}

/** Live Host capability: invoke viewer code in its own page, with an exact job-frame binding. */
export function createTileSession() {
  const existing = (globalThis as Page).__dezoomifyOpenSeadragon;
  if (existing) return existing.register;
  const sources = new Map<
    string,
    { source: Source; item: object; shape: ReturnType<typeof geometry> }
  >();
  const pending = new Map<
    string,
    { base: string | undefined; controller: AbortController; finished: Promise<void> }
  >();
  const bridge: Bridge = {
    register(source, item, context) {
      const live = source as Source;
      const shape = geometry(live);
      const identity = new URL(context.documentUrl);
      identity.hash = `${marker.slice(1)}${crypto.getRandomValues(new Uint32Array(4)).join("-")}/image`;
      const base = identity.href;
      sources.set(base, { source: live, item, shape });
      return {
        kind: "observed-metadata",
        url: `${context.documentUrl.split("#")[0]}#dezoomify-openseadragon-${context.imageIndex}`,
        contents: JSON.stringify({
          Image: {
            Url: base,
            Format: "png",
            TileSize: shape.tileSize,
            Overlap: shape.overlap,
            Size: { Width: shape.width, Height: shape.height },
          },
        }),
      };
    },
    async load(url, operationId, deadlineAt) {
      const documentUrl = location.href;
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(transportError("timeout", "OpenSeadragon tile timed out")),
        Math.max(0, deadlineAt - Date.now()),
      );
      const base = tileResourceBase(url);
      let finish = () => {};
      const finished = new Promise<void>((resolve) => {
        finish = resolve;
      });
      pending.set(operationId, { base, controller, finished });
      try {
        const entry = base && sources.get(base);
        const coordinates = /\/(\d+)\/(\d+)_(\d+)\.png$/.exec(url);
        if (!entry || !coordinates)
          throw transportError("source-lost", "OpenSeadragon source is no longer available");
        const [level, x, y] = coordinates.slice(1).map(Number);
        const { width, height, maxLevel, tileSize } = entry.shape;
        const scale = 2 ** (level - maxLevel);
        if (
          level > maxLevel ||
          x >= Math.ceil((width * scale) / tileSize) ||
          y >= Math.ceil((height * scale) / tileSize)
        )
          throw { kind: "bad-url", detail: "invalid OpenSeadragon tile coordinates" };
        const blob = await loadOpenSeadragonTile(
          entry.source,
          entry.item,
          level,
          x,
          y,
          controller.signal,
        );
        const data = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          const abort = () => {
            reader.abort();
            reject(controller.signal.reason);
          };
          controller.signal.addEventListener("abort", abort, { once: true });
          reader.onloadend = () => controller.signal.removeEventListener("abort", abort);
          reader.onload = () => resolve(String(reader.result).split(",")[1]);
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(blob);
        });
        controller.signal.throwIfAborted();
        return {
          documentUrl,
          ok: true,
          status: 200,
          url,
          data,
          bytes: blob.size,
          contentType: blob.type,
        };
      } catch (cause) {
        const error =
          cause && typeof cause === "object" && "kind" in cause
            ? (cause as JobError)
            : transportError("network-failure", String(cause));
        return { documentUrl, ok: false, error };
      } finally {
        clearTimeout(timer);
        pending.delete(operationId);
        finish();
      }
    },
    async cancel(operationId) {
      const entry = pending.get(operationId);
      entry?.controller.abort();
      await entry?.finished;
    },
    release(bases) {
      for (const base of bases) sources.delete(base);
      for (const entry of pending.values()) {
        if (entry.base && bases.includes(entry.base)) entry.controller.abort();
      }
    },
  };
  (globalThis as Page).__dezoomifyOpenSeadragon = bridge;
  return bridge.register;
}

/** Serialized into the same main-world document as the explicit scan. */
export function readOpenSeadragonTile(request: {
  url: string;
  operationId: string;
  deadlineAt: number;
}) {
  const bridge = (globalThis as Page).__dezoomifyOpenSeadragon;
  return (
    bridge?.load(request.url, request.operationId, request.deadlineAt) ?? {
      documentUrl: location.href,
      ok: false,
      error: {
        kind: "policy-denied",
        blocked_reason: "source-document-lost",
        transport: "browser-session",
      },
    }
  );
}

export function cancelOpenSeadragonTile(operationId: string) {
  return (globalThis as Page).__dezoomifyOpenSeadragon?.cancel(operationId);
}

export function releaseOpenSeadragonTiles(bases: string[]) {
  (globalThis as Page).__dezoomifyOpenSeadragon?.release(bases);
}
