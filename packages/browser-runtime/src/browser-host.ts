import type {
  Catalog,
  FetchFailure,
  FinishRequest,
  Gate,
  Host,
  Image,
  Interaction,
  Error as JobError,
  MissingTiles,
  Output,
  ProcessingRecipe,
  Progress,
  RecoveryChoice,
  ResourceRead,
  ResourceRequest,
  Tile,
  TileReceipt,
} from "@dezoomify/wasm-bindings";
import type { DiagnosticRecorder } from "../../shared-ui/src/diagnostics.ts";
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
  classifyFailure(error: unknown): FetchFailure;
  onProgress(progress: Progress): void;
  choosePartial(missing: MissingTiles, signal: AbortSignal): Promise<RecoveryChoice>;
}

export interface BrowserAssemblyArgs {
  diagnostics?: DiagnosticRecorder;
  signal: AbortSignal;
  decoder: TileDecoder;
  sourceUrl: string;
  processTile(recipe: ProcessingRecipe, bytes: ArrayBuffer): Promise<ArrayBuffer>;
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

  private failure(
    error: unknown,
    request?: ResourceRequest,
    phase: JobError["phase"] = "acquisition",
  ): JobError {
    if (this.signal.aborted)
      return {
        code: "TRANSPORT_CANCELLED",
        phase,
        message: "The job was cancelled.",
        retryable: false,
        recovery: [],
      };
    const observed = this.deps.classifyFailure(error);
    const own = error && typeof error === "object" ? (error as Partial<JobError>) : {};
    const http = own.http ?? observed.http;
    return {
      ...observed,
      code:
        typeof own.code === "string" && (own.phase || phase === "output")
          ? own.code
          : observed.code,
      message: typeof own.message === "string" ? own.message : observed.message,
      phase: own.phase ?? phase,
      retryable:
        own.retryable ??
        (http !== undefined
          ? http === 408 || http === 429 || http >= 500
          : observed.code !== "TRANSPORT_POLICY_DENIED"),
      recovery: own.recovery ?? [],
      ...(request ? { request: request.uri, resource_kind: request.purpose } : {}),
      ...(own.detail ? { detail: own.detail } : {}),
    };
  }

  fetch(request: ResourceRequest, interaction: Interaction): Promise<ResourceRead> {
    return this.own(() => this.readResource(request, interaction));
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
      throw this.failure(
        error,
        request,
        request.purpose === "metadata" ? "discovery" : "acquisition",
      );
    }
  }

  private async readable(request: ResourceRequest): Promise<Uint8Array> {
    const result = await this.fetch(request, "allowed");
    if (result.kind === "needs-access")
      throw {
        code: "TRANSPORT_POLICY_DENIED",
        message: `Access to ${result.origin} is required.`,
        retryable: false,
        phase: "acquisition",
        recovery: [],
      };
    return new Uint8Array(result.response.bytes);
  }

  probe(tile: Tile): Promise<import("@dezoomify/wasm-bindings").ProbeOutcome> {
    return this.own(() => this.measureTile(tile));
  }

  private async measureTile(tile: Tile): Promise<import("@dezoomify/wasm-bindings").ProbeOutcome> {
    try {
      const loadDisplayImage = this.deps.loadDisplayImage;
      const probe = createProbeSize({
        fetchResource: async (request) => ({ bytes: await this.readable(request) }),
        classifyFailure: this.deps.classifyFailure,
        decode: (bytes) => this.deps.decoder.decode(bytes, this.signal),
        ...(loadDisplayImage
          ? {
              loadImage: async (url: string, signal: AbortSignal) => {
                const image = await loadDisplayImage(url, signal);
                return { width: image.naturalWidth, height: image.naturalHeight, image };
              },
            }
          : {}),
      });
      const size = await probe(tile.request, this.signal);
      if (size.status === "available" && tile.placement.probe_output) {
        try {
          this.deps.assembly.prepare(tile.placement.canvas);
        } catch (error) {
          throw this.failure(error, undefined, "output");
        }
        if (size.bytes)
          await this.deps.assembly.acquireTile(tile.index, tile.placement, size.bytes);
        else if (size.image)
          this.deps.assembly.acquireDisplayTile(tile.index, tile.placement, size.image);
        else return { status: "missing" as const };
      }
      return size.status === "missing"
        ? size
        : { status: "available" as const, width: size.width, height: size.height };
    } catch (error) {
      throw this.failure(error, tile.request);
    }
  }

  private async display(tile: Tile): Promise<TileReceipt> {
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
      return { display_only: true };
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

  acquireTile(tile: Tile): Promise<TileReceipt> {
    return this.own(() => this.paintTile(tile));
  }

  private async paintTile(tile: Tile): Promise<TileReceipt> {
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
        return { display_only: false };
      } catch (error) {
        const failure = this.failure(error, tile.request);
        if (
          ordinary &&
          failure.http === undefined &&
          failure.code !== "TRANSPORT_POLICY_DENIED" &&
          !this.signal.aborted
        ) {
          const receipt = await this.display(tile);
          classified?.(true);
          return receipt;
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
      const disposition = await this.deps.assembly.finalizeOutput(
        request.missing.length > 0,
        request.format,
        request.canvas,
      );
      this.signal.throwIfAborted();
      return {
        canvas: this.deps.assembly.dimensions() ?? undefined,
        format: request.format,
        complete: request.missing.length === 0,
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
