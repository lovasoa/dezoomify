import type {
  Catalog,
  ErrorTransport,
  FinishRequest,
  Gate,
  Host,
  HostTiming,
  HtmlDocument,
  HtmlQuery,
  Image,
  Interaction,
  Error as JobError,
  JobInput,
  Output,
  OutputPlan,
  ProbeOutcome,
  Progress,
  ResourceRead,
  ResourceRequest,
  Size,
  Tile,
  TileAcquisition,
  ViewerTileRequest,
} from "@dezoomify/wasm-bindings";
import type { DiagnosticRecorder } from "../../shared-ui/src/diagnostics.ts";
import { causeOf, isJobError, unknownDetail } from "../../shared-ui/src/failure.ts";
import type { CanvasAssembly } from "./assembly.ts";
import {
  CancelledError,
  DezoomifyError,
  errorFromPayload,
  InternalError,
  InvalidInputError,
  NetworkError,
  PolicyDeniedError,
  ResourceError,
} from "./errors.ts";
import { originOfUrl } from "./fetch-primitives.ts";
import type { SelectionLimits } from "./limits.ts";
import { canvasTooLargeFailure } from "./plan-gates.ts";
import type { TileDecoder } from "./tile-decode.ts";
import type { TileImageLike } from "./tile-draw.ts";

export interface BrowserHostDependencies {
  signal: AbortSignal;
  selectionLimits: SelectionLimits;
  diagnostics?: DiagnosticRecorder;
  assembly: CanvasAssembly;
  decoder: TileDecoder;
  observe?(interaction: Interaction, signal: AbortSignal): Promise<JobInput[]>;
  fetchResource(
    request: ResourceRequest,
    signal: AbortSignal,
    interaction: Interaction,
  ): Promise<ResourceRead>;
  loadDisplayImage?(url: string, signal: AbortSignal): Promise<TileImageLike>;
  /** Return owned encoded bytes for one attempt using a handle retained until
   * job settlement. Honor cancellation without clearing the viewer's queue.
   * Preserve typed load failures; never route handles through URL transports. */
  loadViewerTile?(
    request: ViewerTileRequest,
    extent: Size,
    signal: AbortSignal,
  ): Promise<ArrayBuffer>;
  onProgress(progress: Progress): void;
  chooseImage(catalog: Catalog, signal: AbortSignal): Promise<number>;
  approveRetry(request: TileAcquisition, signal: AbortSignal): Promise<void>;
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
  private resumePending: (() => void) | undefined;
  private pauseWait: Promise<void> | undefined;
  paused = false;
  retryWaiting = false;

  constructor(deps: BrowserHostDependencies) {
    if (
      Object.values(deps.selectionLimits).some((limit) => !Number.isFinite(limit) || limit <= 0)
    ) {
      throw new DezoomifyError({
        kind: "invalid-options",
        detail: "canvas limits must be positive",
      });
    }
    this.deps = deps;
    this.signal = AbortSignal.any([deps.signal, this.resources.signal]);
  }

  async beginOutput(plan: OutputPlan): Promise<void> {
    try {
      await this.checkpoint("cancellation");
      this.deps.assembly.prepare(plan.canvas);
    } catch (error) {
      throw this.failure(error);
    }
  }

  /** Classify one thrown value into the typed error contract, attaching the
   * request context once (host operations wrap their failures a single time). */
  private failure(
    error: unknown,
    request?: ResourceRequest,
    domain: "fetch" | "host" = "host",
  ): JobError {
    if (this.signal.aborted) return new CancelledError();
    const typed: JobError = isJobError(error)
      ? errorFromPayload(error)
      : domain === "fetch"
        ? new NetworkError(
            unknownDetail(error),
            { transport: this.deps.transport?.() ?? "direct" },
            { cause: error },
          )
        : new InternalError(unknownDetail(error), { cause: error });
    if (!request || typed.kind === "resource" || typed.kind === "cancelled") return typed;
    return new ResourceError({
      request: request.uri,
      resource_kind: request.purpose,
      source: typed,
    });
  }

  private tileFailure(error: unknown, tile: Tile): JobError {
    return this.failure(error, tile.source.kind === "resource" ? tile.source : undefined);
  }

  fetch(request: ResourceRequest, interaction: Interaction): Promise<ResourceRead> {
    return this.own(() => this.readResource(request, interaction));
  }

  observe(interaction: Interaction): Promise<JobInput[]> {
    return this.own(async () => {
      this.signal.throwIfAborted();
      const inputs = await this.deps.observe?.(interaction, this.signal);
      this.signal.throwIfAborted();
      return inputs ?? [];
    }).catch((error) => {
      throw this.failure(error);
    });
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
      throw new PolicyDeniedError({
        blocked_reason: "access-required",
        transport: this.deps.transport?.() ?? "browser-session",
        detail: `access to ${result.origin} is required`,
      });
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
        const failure = this.tileFailure(error, tile);
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
      throw this.tileFailure(error, tile);
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

  acquireTile(request: TileAcquisition): Promise<void> {
    return this.own(async () => {
      if (request.requires_approval) await this.wait(this.deps.approveRetry(request, this.signal));
      if (this.paused || this.retryWaiting) await this.checkpoint("acquisition");
      await this.paintTile(request.tile);
    });
  }

  private async paintTile(tile: Tile): Promise<void> {
    try {
      this.signal.throwIfAborted();
      if (tile.index === 0)
        this.deps.diagnostics?.context({
          first_tile: {
            source: tile.source,
            placement: tile.placement,
          },
        });
      this.deps.assembly.prepare(tile.placement.canvas);
      const resource = await this.loadTile(tile);
      await this.paintLoaded(tile, resource);
    } catch (error) {
      const failure = this.tileFailure(error, tile);
      if (!this.signal.aborted)
        this.deps.diagnostics?.record("warn", "acquisition-failed", {
          ...failure,
          tile: tile.index,
          tile_source: tile.source,
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

  /** Dispatch once: viewer calls cannot enter resource transports or fallback. */
  private async loadTile(tile: Tile): Promise<ArrayBuffer | TileImageLike> {
    const source = tile.source;
    if (source.kind === "viewer") {
      const load = this.deps.loadViewerTile;
      const extent = tile.placement.expected_size;
      if (!load)
        throw new InvalidInputError("Live viewer tiles require their browser extension session");
      if (!extent) throw new InternalError("Viewer tile plan has no expected pixel dimensions");
      try {
        return await load(source, extent, this.signal);
      } catch (error) {
        if (isJobError(error)) throw errorFromPayload(error);
        throw new InternalError(
          `Unexpected exception while loading viewer tile (level ${source.level}, column ${source.column}, row ${source.row}): ${unknownDetail(error, 1024)}`,
          { cause: error },
        );
      }
    }
    return this.loadResourceTile(source, tile.placement.processing === "none");
  }

  /** Rust owns retries and concurrency; remember only successful display fallback.
   * If fallback fails, retain the readable cause for the core's recovery policy. */
  private async loadResourceTile(
    request: ResourceRequest,
    unprocessed: boolean,
  ): Promise<ArrayBuffer | TileImageLike> {
    const origin = originOfUrl(request.uri);
    const ordinary =
      unprocessed &&
      this.deps.loadDisplayImage !== undefined &&
      !(request.headers ?? []).some(({ name }) => name.toLowerCase() === "range");
    this.signal.throwIfAborted();
    if (ordinary && this.displayOrigins.has(origin)) return await this.display(request);
    try {
      return await this.readable(request);
    } catch (error) {
      const failure = this.failure(error, request);
      const cause = causeOf(failure);
      if (
        ordinary &&
        (cause.kind === "network-failure" || cause.kind === "timeout") &&
        !this.signal.aborted
      )
        return this.displayFallback(request, failure);
      throw failure;
    }
  }

  private async displayFallback(
    request: ResourceRequest,
    original: JobError,
  ): Promise<TileImageLike> {
    try {
      return await this.display(request);
    } catch (error) {
      // Expected image-load failures must not erase the readable cause.
      // Unexpected exceptions and more specific typed failures remain authoritative.
      if (isJobError(error) && ["network-failure", "timeout"].includes(causeOf(error).kind))
        throw original;
      throw error;
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
        disposition,
      };
    } catch (error) {
      throw this.failure(error);
    }
  }

  async chooseImage(catalog: Catalog): Promise<number> {
    await this.checkpoint("cancellation");
    if (!catalog.entries.length) throw new DezoomifyError({ kind: "plan-empty" });
    if (catalog.entries.length === 1) return 0;
    return this.own(() => this.deps.chooseImage(catalog, this.signal));
  }
  /** Select only a fitting declared level; unknown geometry is checked at output preflight. */
  async chooseLevel(image: Image): Promise<number> {
    await this.checkpoint("cancellation");
    const { maxWidth, maxHeight, maxArea } = this.deps.selectionLimits;
    const levels = image.levels.flatMap(({ size }, index) =>
      size && size.width > 0 && size.height > 0
        ? [{ index, size, area: size.width * size.height }]
        : [],
    );
    levels.sort((a, b) => a.area - b.area);
    const fitting = levels.filter(
      ({ size, area }) => size.width <= maxWidth && size.height <= maxHeight && area <= maxArea,
    );
    const selected = fitting.at(-1);
    if (selected) return selected.index;
    const smallest = levels[0];
    if (smallest)
      throw canvasTooLargeFailure(smallest.size.width, smallest.size.height, image.sourceUrl ?? "");
    return image.levels.length - 1;
  }
  private updatePauseGate(): void {
    if (this.paused || this.retryWaiting) {
      this.pauseWait ??= new Promise((resolve) => {
        this.resumePending = resolve;
      });
    } else {
      this.resumePending?.();
      this.resumePending = undefined;
      this.pauseWait = undefined;
    }
  }
  pause(): void {
    this.paused = true;
    this.updatePauseGate();
  }
  resume(): void {
    this.paused = false;
    this.updatePauseGate();
  }
  waitForRetry(waiting: boolean): void {
    this.retryWaiting = waiting;
    this.updatePauseGate();
  }

  async checkpoint(gate: Gate): Promise<HostTiming> {
    try {
      this.signal.throwIfAborted();
      while (gate === "acquisition" && (this.paused || this.retryWaiting) && this.pauseWait)
        await this.wait(this.pauseWait);
      this.signal.throwIfAborted();
      return { time_ms: Math.floor(performance.now()) };
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

  async sleep(delay: number): Promise<HostTiming> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await this.wait(
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, delay);
        }),
      );
      return { time_ms: Math.floor(performance.now()) };
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
      this.waitForRetry(false);
      this.resume();
      this.deps.assembly.release();
      this.deps.decoder.dispose();
      while (this.pending.size) await Promise.allSettled([...this.pending]);
      await this.deps.decoder.settle();
    })();
    return this.settling;
  }
}
