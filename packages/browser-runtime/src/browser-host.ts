import type {
  Catalog,
  ErrorTransport,
  FinishRequest,
  Gate,
  Host,
  HtmlDocument,
  HtmlQuery,
  Image,
  Interaction,
  Error as JobError,
  MissingTiles,
  Output,
  Progress,
  RecoveryChoice,
  ResourceRead,
  ResourceRequest,
  Tile,
} from "@dezoomify/wasm-bindings";
import type { DiagnosticRecorder } from "../../shared-ui/src/diagnostics.ts";
import { causeOf, isJobError } from "../../shared-ui/src/failure.ts";
import type { CanvasAssembly } from "./assembly.ts";
import { originOfUrl } from "./fetch-primitives.ts";
import { createProbeSize } from "./probe.ts";
import type { TileDecoder } from "./tile-decode.ts";
import type { TileImageLike } from "./tile-draw.ts";

export interface BrowserHostDependencies {
  signal: AbortSignal;
  diagnostics?: DiagnosticRecorder;
  assembly: CanvasAssembly;
  decoder: TileDecoder;
  fetchResource(
    request: ResourceRequest,
    signal: AbortSignal,
    interaction: Interaction,
  ): Promise<ResourceRead>;
  loadDisplayImage?(url: string, signal: AbortSignal): Promise<TileImageLike>;
  onProgress(progress: Progress): void;
  choosePartial(missing: MissingTiles, signal: AbortSignal): Promise<RecoveryChoice>;
  transport?(): ErrorTransport | null;
}

/** Concrete browser capabilities for one cancellable invocation. */
export class BrowserHost implements Host {
  private readonly deps: BrowserHostDependencies;
  private readonly resources = new AbortController();
  private readonly signal: AbortSignal;
  private readonly pending = new Set<Promise<unknown>>();
  private settling: Promise<void> | undefined;
  private readonly displayOrigins = new Set<string>();
  private readonly classifying = new Map<string, Promise<boolean>>();
  private resumePending: (() => void) | undefined;
  private pauseWait: Promise<void> | undefined;
  paused = false;

  constructor(deps: BrowserHostDependencies) {
    this.deps = deps;
    this.signal = AbortSignal.any([deps.signal, this.resources.signal]);
  }

  /** Classify one thrown value into the typed error contract, attaching the
   * request context once (host operations wrap their failures a single time). */
  private failure(
    error: unknown,
    request?: ResourceRequest,
    domain: "fetch" | "output" = "fetch",
  ): JobError {
    if (this.signal.aborted) return { kind: "cancelled" };
    const typed: JobError = isJobError(error)
      ? error
      : domain === "output"
        ? { kind: "write-failed", detail: String(error).slice(0, 2048) }
        : {
            kind: "network-failure",
            transport: this.deps.transport?.() ?? "direct",
            detail: String(error).slice(0, 2048),
          };
    if (!request || typed.kind === "resource") return typed;
    return {
      kind: "resource",
      request: request.uri,
      resource_kind: request.purpose,
      source: typed,
    };
  }

  fetch(request: ResourceRequest, interaction: Interaction): Promise<ResourceRead> {
    return this.own(() => this.readResource(request, interaction));
  }

  parseHtml(query: HtmlQuery): Promise<HtmlDocument> {
    return this.own(async () => {
      this.signal.throwIfAborted();
      // No browsing context: scripts, handlers and resource loads remain inert.
      const inert = document.implementation.createHTMLDocument("");
      inert.documentElement.innerHTML = query.source;
      return Object.fromEntries(
        query.selectors.map((selector) => [
          selector,
          Array.from(inert.querySelectorAll(selector))
            .filter((element) => !element.closest("noscript, template"))
            .map((element) => ({
              name: element.localName,
              attributes: Object.fromEntries(
                Array.from(element.attributes, (attr) => [attr.name, attr.value]),
              ),
              text: element.textContent ?? "",
            })),
        ]),
      );
    }).catch((error) => {
      throw this.failure(
        isJobError(error)
          ? error
          : {
              kind: "binding-invalid-value",
              detail: String(error).slice(0, 2048),
            },
      );
    });
  }

  private async readResource(
    request: ResourceRequest,
    interaction: Interaction,
  ): Promise<ResourceRead> {
    try {
      this.signal.throwIfAborted();
      const result = await this.deps.fetchResource(request, this.signal, interaction);
      this.signal.throwIfAborted();
      return result;
    } catch (error) {
      throw this.failure(error, request);
    }
  }

  private async readable(request: ResourceRequest): Promise<Uint8Array> {
    const result = await this.fetch(request, "allowed");
    if (result.kind === "needs-access")
      throw {
        kind: "policy-denied",
        blocked_reason: "access-required",
        transport: this.deps.transport?.() ?? "browser-session",
        detail: `access to ${result.origin} is required`,
      } satisfies JobError;
    return new Uint8Array(result.response.bytes);
  }

  probe(tile: Tile): Promise<import("@dezoomify/wasm-bindings").ProbeOutcome> {
    return this.own(() => this.measureTile(tile));
  }

  private async measureTile(tile: Tile): Promise<import("@dezoomify/wasm-bindings").ProbeOutcome> {
    try {
      const loadDisplayImage = this.deps.loadDisplayImage;
      const probe = createProbeSize({
        fetchResource: async (request) => ({
          bytes: await this.readable(request),
        }),
        decode: (bytes) => this.deps.decoder.decode(bytes, this.signal),
        ...(loadDisplayImage
          ? {
              loadImage: async (url: string, signal: AbortSignal) => {
                const image = await loadDisplayImage(url, signal);
                return {
                  width: image.naturalWidth,
                  height: image.naturalHeight,
                  image,
                };
              },
            }
          : {}),
      });
      const tile_probe = await probe(tile.request, this.signal);
      if (tile_probe.status === "available" && tile.placement.role.output) {
        try {
          this.deps.assembly.prepare(tile.placement.canvas);
        } catch (error) {
          throw this.failure(error, undefined, "output");
        }
        if (tile_probe.bytes)
          await this.deps.assembly.acquireTile(tile.index, tile.placement, tile_probe.bytes);
        else if (tile_probe.image)
          this.deps.assembly.acquireDisplayTile(tile.index, tile.placement, tile_probe.image);
        else return { status: "missing" as const };
      }
      return tile_probe.status === "missing"
        ? tile_probe
        : {
            status: "available" as const,
            width: tile_probe.width,
            height: tile_probe.height,
          };
    } catch (error) {
      throw this.failure(error, tile.request);
    }
  }

  private async display(tile: Tile): Promise<void> {
    this.deps.diagnostics?.count("requests");
    this.deps.diagnostics?.count("requests_pending");
    try {
      const loadDisplayImage = this.deps.loadDisplayImage;
      if (!loadDisplayImage) throw new Error("Ordinary image display is unavailable.");
      const image = await loadDisplayImage(tile.request.uri, this.signal);
      this.signal.throwIfAborted();
      this.deps.assembly.acquireDisplayTile(tile.index, tile.placement, image);
      this.displayOrigins.add(originOfUrl(tile.request.uri));
      this.deps.diagnostics?.count("requests_completed");
      this.deps.diagnostics?.count("displayed_tiles");
      return;
    } catch (error) {
      this.deps.diagnostics?.count(this.signal.aborted ? "requests_cancelled" : "request_failures");
      if (!this.signal.aborted)
        this.deps.diagnostics?.record("warn", "request-failed", {
          transport: "ordinary-image",
          url: tile.request.uri,
          http_status: "unavailable",
          error,
        });
      throw error;
    } finally {
      this.deps.diagnostics?.count("requests_pending", -1);
    }
  }

  acquireTile(tile: Tile): Promise<void> {
    return this.own(() => this.paintTile(tile));
  }

  private async paintTile(tile: Tile): Promise<void> {
    const origin = originOfUrl(tile.request.uri);
    const ordinary =
      tile.placement.processing === "none" && this.deps.loadDisplayImage !== undefined;
    let classified: ((displayOnly: boolean) => void) | undefined;
    try {
      this.signal.throwIfAborted();
      if (tile.index === 0)
        this.deps.diagnostics?.context({
          first_tile: {
            url: tile.request.uri,
            purpose: tile.request.purpose,
            placement: tile.placement,
          },
        });
      try {
        this.deps.assembly.prepare(tile.placement.canvas);
      } catch (error) {
        throw this.failure(error, undefined, "output");
      }
      if (ordinary) {
        if (this.displayOrigins.has(origin)) return await this.display(tile);
        const pending = this.classifying.get(origin);
        if (pending) {
          if (await pending) return await this.display(tile);
        } else
          this.classifying.set(
            origin,
            new Promise((resolve) => {
              classified = resolve;
            }),
          );
      }
      try {
        const bytes = await this.readable(tile.request);
        classified?.(false);
        await this.deps.assembly.acquireTile(tile.index, tile.placement, bytes.slice().buffer);
        return;
      } catch (error) {
        const failure = this.failure(error, tile.request);
        const cause = causeOf(failure);
        if (
          ordinary &&
          cause.kind !== "http-error" &&
          cause.kind !== "policy-denied" &&
          !this.signal.aborted
        ) {
          await this.display(tile);
          classified?.(true);
          return;
        }
        throw failure;
      }
    } catch (error) {
      const failure = this.failure(error, tile.request);
      if (!this.signal.aborted)
        this.deps.diagnostics?.record("warn", "acquisition-failed", {
          ...failure,
          tile: tile.index,
          placement: tile.placement,
        });
      throw failure;
    } finally {
      if (classified) {
        classified(false);
        this.classifying.delete(origin);
      }
    }
  }

  finish(request: FinishRequest): Promise<Output> {
    return this.own(() => this.saveOutput(request));
  }

  private async saveOutput(request: FinishRequest): Promise<Output> {
    try {
      const disposition = await this.deps.assembly.finalizeOutput(request.canvas);
      this.signal.throwIfAborted();
      return {
        canvas: this.deps.assembly.dimensions() ?? undefined,
        format: request.format,
        missing: request.missing,
        disposition,
      };
    } catch (error) {
      throw this.failure(error, undefined, "output");
    }
  }

  async chooseImage(catalog: Catalog): Promise<number> {
    const index = catalog.entries.findIndex((entry) => entry.kind === "image");
    return Math.max(0, index);
  }
  async chooseLevel(image: Image): Promise<number> {
    return Math.max(0, image.levels.length - 1);
  }
  async choosePartial(missing: MissingTiles): Promise<RecoveryChoice> {
    try {
      return await this.own(() => this.deps.choosePartial(missing, this.signal));
    } catch (error) {
      throw this.failure(error);
    }
  }
  pause(): void {
    if (!this.paused) {
      this.paused = true;
      this.pauseWait = new Promise((resolve) => {
        this.resumePending = resolve;
      });
    }
  }
  resume(): void {
    this.paused = false;
    this.resumePending?.();
    this.resumePending = undefined;
    this.pauseWait = undefined;
  }

  async checkpoint(gate: Gate): Promise<void> {
    try {
      this.signal.throwIfAborted();
      while (gate === "acquisition" && this.pauseWait) await this.wait(this.pauseWait);
      this.signal.throwIfAborted();
    } catch (error) {
      throw this.failure(error);
    }
  }

  private wait<T>(promise: Promise<T>): Promise<T> {
    const signal = this.signal;
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(this.failure(signal.reason));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      void promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
  }

  async sleep(delay: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await this.wait(
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, delay);
        }),
      );
    } finally {
      clearTimeout(timer);
    }
  }
  report(progress: Progress): void {
    if (!this.signal.aborted) {
      this.deps.diagnostics?.observe(progress);
      this.deps.onProgress(progress);
    }
  }
  warn(message: string): void {
    if (!this.signal.aborted)
      this.deps.diagnostics?.record("warn", "discovery-warning", { message });
  }
  private async own<T>(operation: () => Promise<T>): Promise<T> {
    if (this.signal.aborted) throw this.failure(this.signal.reason);
    const promise = operation();
    this.pending.add(promise);
    try {
      return await promise;
    } finally {
      this.pending.delete(promise);
    }
  }

  settle(): Promise<void> {
    this.settling ??= (async () => {
      this.resources.abort();
      this.resume();
      this.deps.assembly.release();
      this.deps.decoder.dispose();
      while (this.pending.size) await Promise.allSettled([...this.pending]);
      await this.deps.decoder.settle();
    })();
    return this.settling;
  }
}
