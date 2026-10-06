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
  OutputPlan,
  ProbeOutcome,
  Progress,
  RecoveryChoice,
  ResourceRead,
  ResourceRequest,
  Tile,
} from "@dezoomify/wasm-bindings";
import type { DiagnosticRecorder } from "../../shared-ui/src/diagnostics.ts";
import { causeOf, isJobError, unknownDetail } from "../../shared-ui/src/failure.ts";
import type { CanvasAssembly } from "./assembly.ts";
import { originOfUrl } from "./fetch-primitives.ts";
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

  async beginOutput(_plan: OutputPlan): Promise<void> {
    await this.checkpoint("cancellation");
  }

  /** Classify one thrown value into the typed error contract, attaching the
   * request context once (host operations wrap their failures a single time). */
  private failure(
    error: unknown,
    request?: ResourceRequest,
    domain: "fetch" | "host" = "host",
  ): JobError {
    if (this.signal.aborted) return { kind: "cancelled" };
    const typed: JobError = isJobError(error)
      ? error
      : domain === "fetch"
        ? {
            kind: "network-failure",
            transport: this.deps.transport?.() ?? "direct",
            detail: unknownDetail(error),
          }
        : { kind: "internal", detail: unknownDetail(error) };
    if (!request || typed.kind === "resource" || typed.kind === "cancelled") return typed;
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
      throw this.failure(error);
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
      throw this.failure(error, request, "fetch");
    }
  }

  private async readable(request: ResourceRequest): Promise<ArrayBuffer> {
    const result = await this.fetch(request, "allowed");
    if (result.kind === "needs-access")
      throw {
        kind: "policy-denied",
        blocked_reason: "access-required",
        transport: this.deps.transport?.() ?? "browser-session",
        detail: `access to ${result.origin} is required`,
      } satisfies JobError;
    return new Uint8Array(result.response.bytes).buffer;
  }

  probe(tile: Tile): Promise<ProbeOutcome> {
    return this.own(() => this.measureTile(tile));
  }

  private async measureTile(tile: Tile): Promise<ProbeOutcome> {
    try {
      let resource: ArrayBuffer | TileImageLike;
      let width: number, height: number;
      try {
        resource = await this.loadTile(tile);
        if (resource instanceof ArrayBuffer) {
          const bitmap = await this.deps.decoder.decode(resource, this.signal);
          width = bitmap.width;
          height = bitmap.height;
          try {
            bitmap.close();
          } catch {
            // Bitmap cleanup is best-effort.
          }
        } else {
          width = resource.naturalWidth;
          height = resource.naturalHeight;
        }
        this.signal.throwIfAborted();
      } catch (error) {
        const failure = this.failure(error, tile.request);
        const cause = causeOf(failure);
        if (cause.kind === "cancelled" || cause.kind === "policy-denied") throw failure;
        return { status: "missing" };
      }
      if (!(width > 0 && height > 0)) return { status: "missing" };
      if (tile.placement.role.output) {
        this.deps.assembly.prepare(tile.placement.canvas);
        await this.paintLoaded(tile, resource);
      }
      return { status: "available", width, height };
    } catch (error) {
      throw this.failure(error, tile.request);
    }
  }

  private async display(request: ResourceRequest): Promise<TileImageLike> {
    this.deps.diagnostics?.count("requests");
    this.deps.diagnostics?.count("requests_pending");
    try {
      const loadDisplayImage = this.deps.loadDisplayImage;
      if (!loadDisplayImage) throw new Error("Ordinary image display is unavailable.");
      const image = await loadDisplayImage(request.uri, this.signal);
      this.signal.throwIfAborted();
      this.displayOrigins.add(originOfUrl(request.uri));
      this.deps.diagnostics?.count("requests_completed");
      return image;
    } catch (error) {
      this.deps.diagnostics?.count(this.signal.aborted ? "requests_cancelled" : "request_failures");
      if (!this.signal.aborted)
        this.deps.diagnostics?.record("warn", "request-failed", {
          transport: "ordinary-image",
          url: request.uri,
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
      this.deps.assembly.prepare(tile.placement.canvas);
      const resource = await this.loadTile(tile);
      await this.paintLoaded(tile, resource);
    } catch (error) {
      const failure = this.failure(error, tile.request);
      if (!this.signal.aborted)
        this.deps.diagnostics?.record("warn", "acquisition-failed", {
          ...failure,
          tile: tile.index,
          placement: tile.placement,
        });
      throw failure;
    }
  }

  private async paintLoaded(tile: Tile, resource: ArrayBuffer | TileImageLike): Promise<void> {
    this.signal.throwIfAborted();
    if (resource instanceof ArrayBuffer)
      await this.deps.assembly.acquireTile(tile.index, tile.placement, resource);
    else {
      this.deps.assembly.acquireDisplayTile(tile.index, tile.placement, resource);
      this.deps.diagnostics?.count("displayed_tiles");
    }
  }

  private async loadTile(tile: Tile): Promise<ArrayBuffer | TileImageLike> {
    const origin = originOfUrl(tile.request.uri);
    const ordinary =
      tile.placement.processing === "none" && this.deps.loadDisplayImage !== undefined;
    let classified: ((displayOnly: boolean) => void) | undefined;
    try {
      this.signal.throwIfAborted();
      if (ordinary) {
        if (this.displayOrigins.has(origin)) return await this.display(tile.request);
        const pending = this.classifying.get(origin);
        if (pending) {
          if (await this.wait(pending)) return await this.display(tile.request);
        } else
          this.classifying.set(
            origin,
            new Promise((resolve) => {
              classified = resolve;
            }),
          );
      }
      let bytes: ArrayBuffer;
      try {
        bytes = await this.readable(tile.request);
      } catch (error) {
        const failure = this.failure(error, tile.request);
        const cause = causeOf(failure);
        if (
          ordinary &&
          (cause.kind === "network-failure" || cause.kind === "timeout") &&
          !this.signal.aborted
        ) {
          const image = await this.display(tile.request);
          classified?.(true);
          return image;
        }
        throw failure;
      }
      return bytes;
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
      throw this.failure(error);
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
