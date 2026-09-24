// One browser job service over the WASM session, shared by the website and
// the extension job tab. Products inject their transport, output assembly,
// and product actions; the service owns exactly one attempt: the worker, the
// WASM session bridge, cross-worker processing calls, the abort scope, and
// disposal. It owns no job policy (retries, partials, pause, ordering stay
// in the engine) and no UI (snapshots stay in `@dezoomify/app-model`).
//
// This implements the app-model `JobService` declaration directly:
// `start` validates and runs one browser attempt, then emits absolute engine
// snapshots and separate runtime faults. The returned handle forwards every
// `UserCommand` to the engine and disposes the attempt. Selection stays
// explicit: the engine
// terminal is the only settle signal, so the service keeps no settled flag
// and no terminal gating. Stale revisions and retired jobs are dropped here
// at the transport edge, the single place that guards them. The pending
// cross-worker processing ledger plus the worker and assembly handles are
// the only per-attempt state kept.
import type {
  EngineStartRequest,
  JobHandle,
  JobObserver,
  JobService,
  Snapshot,
  UserCommand,
} from "@dezoomify/app-model";
import { validateEngineStartRequest } from "@dezoomify/app-model";
import type {
  Error as EngineError,
  JobInput,
  ProcessingRecipe,
  ResourceRequest,
  SessionConfig,
} from "@dezoomify/wasm-bindings";
import {
  createEngineHost,
  type EngineHost,
  type EngineHostAssembly,
  type HostFailure,
} from "./engine-host.ts";
import { createProbeSize } from "./probe.ts";
import { createTileDecoder, type TileDecoder } from "./tile-decode.ts";
import type { TileImageLike } from "./tile-draw.ts";
import type { WorkerHostMessage, WorkerHostOutput } from "./worker-host.ts";

/** Packaged worker module (page keeps the visible canvas; the worker never touches DOM). */
export interface BrowserWorker {
  postMessage(message: WorkerHostMessage, transfer?: Transferable[]): void;
  addEventListener(type: "message", listener: (event: { data: WorkerHostOutput }) => void): void;
  terminate(): void;
}

export interface BrowserAssemblyArgs {
  signal: AbortSignal;
  decoder: TileDecoder;
  /** First input URL: save naming, history, and desktop handoff stay product-side. */
  sourceUrl: string;
  /**
   * Core recipe processing through the worker session. Supplied by the
   * service so both products share one pending-call ledger and one
   * deliberate transferable per call.
   */
  processTile(recipe: ProcessingRecipe, bytes: ArrayBuffer): Promise<ArrayBuffer>;
}

/** Product-injected effects and surfaces behind one browser attempt. */
export interface BrowserProduct {
  createWorker(): BrowserWorker;
  /** One-attempt resource fetch feeding the engine retry budget. */
  fetchResource(
    request: ResourceRequest,
    signal: AbortSignal,
  ): Promise<{ bytes: Uint8Array; finalUri?: string }>;
  /** Absent: no display fallback (failed acquisitions fail the engine). */
  loadDisplayImage?: (url: string, signal: AbortSignal) => Promise<TileImageLike>;
  classifyFailure(error: unknown): HostFailure;
  createAssembly(args: BrowserAssemblyArgs): EngineHostAssembly;
  /** Budget defaults; the request engine options win per job. */
  quotas?: SessionConfig;
  /** Recovery decision needed (product renders keep/discard). */
  onRecoveryRequested?(generation: number): void;
  log?(level: "debug" | "info" | "warn" | "error", code: string, detail?: unknown): void;
}

function serviceError(code: string, message: string): EngineError {
  return { code, phase: "validation", retryable: false, message, recovery: [] };
}

function firstSourceUrl(inputs: JobInput[]): string | null {
  const raw = inputs?.[0]?.url;
  return typeof raw === "string" && raw !== "" ? raw : null;
}

/** Browser service over generated engine requests. */
export interface BrowserJobService extends JobService<EngineStartRequest, JobHandle> {
  start(request: EngineStartRequest, observer: JobObserver): Promise<JobHandle>;
}

export function createBrowserJobService(product: BrowserProduct): BrowserJobService {
  const log = product.log ?? (() => {});
  let jobSequence = 0;

  async function start(request: EngineStartRequest, observer: JobObserver): Promise<JobHandle> {
    const problem = validateEngineStartRequest(request);
    if (problem) {
      throw serviceError(problem, "The job request is not valid.");
    }
    const sourceUrl = firstSourceUrl(request.inputs);
    if (sourceUrl === null) {
      throw serviceError("browser.invalid-source", "The browser job has no usable input URL.");
    }
    jobSequence += 1;
    const id = `job:${jobSequence}`;
    const worker = product.createWorker();
    const attemptSignal = new AbortController();
    let disposed = false;
    let failed = false;
    let terminal = false;
    // Transport-edge revision guard: the single stale drop. Live snapshots
    // apply only when newer; engine terminals always apply and settle the UI.
    let lastSnapshotRevision = -1;
    let host: EngineHost | null = null;
    let assembly: EngineHostAssembly | null = null;
    // Cross-worker processing calls (session.applyProcessing) awaiting a reply.
    const pendingProcess = new Map<
      number,
      { resolve: (bytes: ArrayBuffer) => void; reject: (error: unknown) => void }
    >();
    let processSeq = 0;
    const decoder = createTileDecoder();
    const probeSize = createProbeSize({
      fetchResource: product.fetchResource,
      classifyFailure: product.classifyFailure,
      decode: (bytes) => decoder.decode(bytes, attemptSignal.signal),
      loadImage: product.loadDisplayImage
        ? async (url, signal) => {
            const image = await product.loadDisplayImage!(url, signal);
            return { width: image.naturalWidth, height: image.naturalHeight, image };
          }
        : undefined,
    });

    function abortAttempt(): void {
      try {
        attemptSignal.abort();
      } catch {
        // Abort must never break teardown.
      }
    }

    function processTile(recipe: ProcessingRecipe, bytes: ArrayBuffer): Promise<ArrayBuffer> {
      if (disposed || failed) {
        return Promise.reject(
          serviceError("browser.job-settled", "The browser job already finished."),
        );
      }
      const requestId = ++processSeq;
      return new Promise<ArrayBuffer>((resolve, reject) => {
        pendingProcess.set(requestId, { resolve, reject });
        // Transferable by design: the buffer detaches here and is never reused.
        worker.postMessage({ type: "engine.process", requestId, recipe, bytes }, [bytes]);
      });
    }

    function forwardSnapshot(snapshot: Snapshot): void {
      lastSnapshotRevision = snapshot.revision;
      observer.snapshot(snapshot);
    }

    function onSnapshot(snapshot: Snapshot): void {
      // Stale live snapshots never move the UI; terminals always settle it.
      if (disposed || failed || terminal) return;
      terminal = snapshot.terminal != null;
      if (!snapshot.terminal && snapshot.revision <= lastSnapshotRevision) return;
      forwardSnapshot(snapshot);
    }

    // A dead runtime cannot author an engine snapshot. Report its fault once.
    function forwardRuntimeError(error: EngineError): void {
      if (disposed || failed || terminal) return;
      failed = true;
      observer.failure(error);
      void dispose();
    }

    function projectFailure(error: unknown): EngineError {
      // A host execution failure is terminal with no later effects faked:
      // project the typed error (codes, phases, transports, previews pass
      // through untouched) so the snapshot still terminates honestly.
      const candidate = error && typeof error === "object" ? (error as Partial<EngineError>) : null;
      const code =
        typeof candidate?.code === "string" && candidate.code !== ""
          ? candidate.code
          : "browser.host-failed";
      const message =
        typeof candidate?.message === "string" && candidate.message !== ""
          ? candidate.message
          : "The browser could not assemble the image.";
      return {
        code,
        phase: candidate?.phase ?? "output",
        retryable: candidate?.retryable ?? false,
        message,
        recovery: candidate?.recovery ?? [],
        ...(candidate?.transport ? { transport: candidate.transport } : {}),
        ...(candidate?.blocked_reason ? { blocked_reason: candidate.blocked_reason } : {}),
        ...(candidate?.resource_kind ? { resource_kind: candidate.resource_kind } : {}),
        ...(candidate?.request ? { request: candidate.request } : {}),
        ...(typeof candidate?.http === "number" ? { http: candidate.http } : {}),
        ...(candidate?.preview ? { preview: candidate.preview } : {}),
        ...(candidate?.detail ? { detail: candidate.detail } : {}),
      };
    }

    assembly = product.createAssembly({
      sourceUrl,
      processTile,
      signal: attemptSignal.signal,
      decoder,
    });
    const activeAssembly = assembly;
    host = createEngineHost({
      worker: { postMessage: (message) => worker.postMessage(message) },
      jobId: () => id,
      fetchResource: (request) => product.fetchResource(request, attemptSignal.signal),
      cancelFetch: () => {
        abortAttempt();
      },
      assembly: activeAssembly,
      quotas: { ...product.quotas, ...request.engine },
      probeSize: (request) => probeSize(request, attemptSignal.signal),
      loadDisplayImage: product.loadDisplayImage
        ? (url) => product.loadDisplayImage!(url, attemptSignal.signal)
        : undefined,
      classifyFailure: (error) => product.classifyFailure(error),
      onRecoveryRequested: (generation) => {
        product.onRecoveryRequested?.(generation);
      },
      onSnapshot,
      onHostFailure: (error) => {
        if (disposed) return;
        abortAttempt();
        forwardRuntimeError(projectFailure(error));
      },
      log,
    });
    const activeHost = host;

    worker.addEventListener("message", (event: { data: WorkerHostOutput }) => {
      const data = event.data;
      if (!data || typeof data !== "object" || disposed) return;
      if (data.type === "engine.messages") {
        activeHost.handleEngineMessages(data.messages, data.snapshot);
        return;
      }
      if (data.type === "engine.processed" || data.type === "engine.process-failed") {
        const pending = pendingProcess.get(data.requestId);
        if (!pending) return;
        pendingProcess.delete(data.requestId);
        if (data.type === "engine.processed" && data.bytes instanceof ArrayBuffer)
          pending.resolve(data.bytes);
        else
          pending.reject(
            serviceError("browser.processing-failed", "A tile could not be processed."),
          );
        return;
      }
      if (data.type === "engine.log" && typeof data.line === "string") {
        log("info", "worker", data.line);
        return;
      }
      if (data.type === "engine.error") {
        if (disposed) return;
        abortAttempt();
        forwardRuntimeError(data.error);
      }
    });

    activeHost.start(request.inputs);

    async function command(command: UserCommand): Promise<void> {
      // Every command forwards to the engine, including after its terminal:
      // the engine owns post-terminal semantics. Only a disposed attempt
      // rejects, since its worker and assembly are gone.
      if (disposed) {
        throw serviceError("browser.job-settled", "The browser job already finished.");
      }
      if (command.type === "start") {
        throw serviceError("browser.unsupported-command", "A running browser job cannot restart.");
      }
      activeHost.command(command);
    }

    async function dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      abortAttempt();
      for (const { reject } of pendingProcess.values()) {
        reject(serviceError("browser.job-settled", "The browser job already finished."));
      }
      pendingProcess.clear();
      decoder.dispose();
      try {
        activeHost.dispose();
      } catch {
        // Teardown is best-effort.
      }
      try {
        worker.terminate();
      } catch {
        // The worker may already be gone.
      }
    }

    const handle: JobHandle = {
      id,
      command,
      dispose,
    };
    return handle;
  }

  return { start };
}
