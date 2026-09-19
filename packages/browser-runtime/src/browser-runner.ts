// One browser job runner over the WASM session, shared by the website and
// the extension job tab. Products inject their transport, output assembly,
// and product actions; the runner owns exactly one attempt: the worker, the
// WASM session bridge, cross-worker processing calls, the abort scope, and
// disposal. It owns no job policy (retries, partials, ordering stay in the
// engine) and no UI (snapshots stay in `@dezoomify/app-model`).
//
// The runner implements the app-model `HostRunner` declaration: `start`
// runs one browser attempt and emits ordered engine events plus host
// presentation state; the returned handle takes exactly one `UserCommand`
// at a time and disposes the attempt. Selection stays explicit: catalog
// events flow to the observer and the product answers with select commands.
// Deferred metadata is a product concern (a fresh start), never followed
// silently here.
import type {
  EngineSnapshotDto,
  HostRunner,
  HostStatus,
  JobEvent,
  JobStartRequest,
  RunnerHandle,
  RunnerSink,
  UserCommand,
} from "@dezoomify/app-model";
import type {
  ErrorDto,
  JobInputDto,
  ProcessingRecipe,
  SessionConfig,
} from "@dezoomify/wasm-bindings";
import {
  createEngineHost,
  type AcquireEffect,
  type EngineHost,
  type EngineHostAssembly,
  type HostFailure,
} from "./engine-host.ts";
import type { ProbeSize } from "./probe.ts";
import type { TileImageLike } from "./tile-draw.ts";
import type { WorkerHostMessage, WorkerHostOutput } from "./worker-host.ts";

/** Packaged worker module (page keeps the visible canvas; the worker never touches DOM). */
export interface BrowserWorker {
  postMessage(message: WorkerHostMessage, transfer?: Transferable[]): void;
  addEventListener(type: "message", listener: (event: { data: WorkerHostOutput }) => void): void;
  terminate(): void;
}

export interface BrowserAssemblyArgs {
  /** First input URL: save naming, history, and desktop handoff stay product-side. */
  sourceUrl: string;
  /**
   * Core recipe processing through the worker session. Supplied by the
   * runner so both products share one pending-call ledger and one
   * deliberate transferable per call.
   */
  processTile(recipe: ProcessingRecipe, bytes: ArrayBuffer): Promise<ArrayBuffer>;
}

/** Product-injected effects and surfaces behind one browser attempt. */
export interface BrowserProduct {
  createWorker(): BrowserWorker;
  /** One-attempt resource fetch feeding the engine retry budget. */
  fetchResource(effect: AcquireEffect, signal: AbortSignal): Promise<{ bytes: Uint8Array; finalUri?: string }>;
  /** Single-attempt variant classifying tile origins (defaults to fetchResource). */
  fetchResourceOnce?(effect: AcquireEffect, signal: AbortSignal): Promise<{ bytes: Uint8Array; finalUri?: string }>;
  probeSize(url: string, headers: Record<string, string>, requestId?: number, signal?: AbortSignal): Promise<ProbeSize>;
  /** Absent: no display fallback (failed acquisitions fail the engine). */
  loadDisplayImage?: (url: string) => Promise<TileImageLike>;
  classifyFailure(error: unknown): HostFailure;
  createAssembly(args: BrowserAssemblyArgs): EngineHostAssembly;
  /** Budget defaults; the request engine options win per job. */
  quotas?: SessionConfig;
  sessionId(): string;
  /** Active transport label for HostStatus (website fetcher, extension session). */
  getTransport(): string | null;
  /** True while paused for an explicit host grant (extension only). */
  isPermissionPending(): boolean;
  /** Output presentation: tainted surfaces report display-only. */
  getOutputState(): HostStatus["output"];
  /** Visible permission action needed (extension access view). */
  onPermissionRequired?(detail: { hosts: string[]; requestId: number; jobId: string }): void;
  /** Recovery decision needed (product renders keep/discard). */
  onRecoveryRequested?(generation: number): void;
  /**
   * Abort in-flight product resources the runner signal cannot reach
   * (extension-origin fetch controllers). Runs on cancel and disposal.
   */
  onAbort?(): void;
  log?(level: "debug" | "info" | "warn" | "error", code: string, detail?: unknown): void;
}

/** Browser job control: the runner handle plus the grant-resolution channel. */
export interface BrowserJobHandle extends RunnerHandle {
  /** Resolve a paused host-grant acquisition after the explicit user action. */
  resolvePermission(granted: boolean): void;
}

function runnerError(code: string, message: string): ErrorDto {
  return { code, phase: "validation", retryable: false, message, recovery: [] };
}

function firstSourceUrl(inputs: JobInputDto[]): string | null {
  const raw = inputs?.[0]?.url;
  return typeof raw === "string" && raw !== "" ? raw : null;
}

/** Browser runner: the app-model HostRunner whose jobs carry the grant-resolution channel. */
export interface BrowserRunner extends HostRunner {
  start(request: JobStartRequest, sink: RunnerSink): Promise<BrowserJobHandle>;
}

export function createBrowserRunner(product: BrowserProduct): BrowserRunner {
  const log = product.log ?? (() => {});

  async function start(
    request: JobStartRequest,
    sink: RunnerSink,
  ): Promise<BrowserJobHandle> {
    if (!request || typeof request !== "object" || request.exec?.kind !== "browser") {
      throw runnerError("browser.invalid-exec", "The browser runner runs browser jobs only.");
    }
    const sourceUrl = firstSourceUrl(request.inputs);
    if (sourceUrl === null) {
      throw runnerError("browser.invalid-source", "The browser job has no usable input URL.");
    }
    const worker = product.createWorker();
    const attemptSignal = new AbortController();
    let settled = false;
    let host: EngineHost | null = null;
    let assembly: EngineHostAssembly | null = null;
    // Cross-worker processing calls (session.applyProcessing) awaiting a reply.
    const pendingProcess = new Map<number, { resolve: (bytes: ArrayBuffer) => void; reject: (error: unknown) => void }>();
    let processSeq = 0;

    function abortAttempt(): void {
      try {
        attemptSignal.abort();
      } catch {
        // Abort must never break teardown.
      }
      try {
        product.onAbort?.();
      } catch {
        // Product abort must never break teardown.
      }
    }

    function status(): HostStatus {
      let output = product.getOutputState();
      try {
        if (assembly?.isTainted?.() === true) output = "display-only";
      } catch {
        // A broken surface probe must never stall status.
      }
      return {
        transport: product.getTransport(),
        permission: product.isPermissionPending() ? "prompt" : "granted",
        output,
      };
    }

    function processTile(recipe: ProcessingRecipe, bytes: ArrayBuffer): Promise<ArrayBuffer> {
      if (settled) {
        return Promise.reject(runnerError("browser.job-settled", "The browser job already finished."));
      }
      const requestId = ++processSeq;
      return new Promise<ArrayBuffer>((resolve, reject) => {
        pendingProcess.set(requestId, { resolve, reject });
        // Transferable by design: the buffer detaches here and is never reused.
        worker.postMessage({ type: "engine.process", requestId, recipe, bytes }, [bytes]);
      });
    }

    function onEvent(event: JobEvent): void {
      if (settled) return;
      if (
        event.type === "completed" ||
        event.type === "partial-completed" ||
        event.type === "failed" ||
        event.type === "cancelled"
      ) {
        settled = true;
      }
      sink.event(event, status());
    }

    function onSnapshot(snapshot: EngineSnapshotDto): void {
      if (settled) return;
      if (snapshot.terminal) settled = true;
      sink.snapshot(snapshot);
    }

    assembly = product.createAssembly({ sourceUrl, processTile });
    const activeAssembly = assembly;
    host = createEngineHost({
      worker: { postMessage: (message) => worker.postMessage(message) },
      jobId: () => product.sessionId(),
      fetchResource: (effect) => product.fetchResource(effect, attemptSignal.signal),
      fetchResourceOnce: product.fetchResourceOnce
        ? (effect) => (product.fetchResourceOnce as NonNullable<BrowserProduct["fetchResourceOnce"]>)(effect, attemptSignal.signal)
        : undefined,
      cancelFetch: () => {
        abortAttempt();
      },
      assembly: activeAssembly,
      quotas: { ...product.quotas, ...request.engine },
      probeSize: (url, headers, requestId) => product.probeSize(url, headers, requestId, attemptSignal.signal),
      loadDisplayImage: product.loadDisplayImage,
      classifyFailure: (error) => product.classifyFailure(error),
      onPermissionRequired: (detail) => {
        product.onPermissionRequired?.(detail);
        log("info", "permission-required", detail.hosts.join(","));
      },
      onRecoveryRequested: (generation) => {
        product.onRecoveryRequested?.(generation);
      },
      onSnapshot,
      onHostFailure: (error) => {
        if (settled) return;
        settled = true;
        // A host execution failure is terminal with no later effects faked:
        // project the typed error (codes, phases, transports, previews pass
        // through untouched) so the snapshot still terminates honestly.
        const candidate = error && typeof error === "object" ? (error as Partial<ErrorDto>) : null;
        const code = typeof candidate?.code === "string" && candidate.code !== "" ? candidate.code : "browser.host-failed";
        const message = typeof candidate?.message === "string" && candidate.message !== ""
          ? candidate.message
          : "The browser could not assemble the image.";
        const failure: ErrorDto = {
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
        sink.event({ type: "failed", error: failure }, status());
      },
      onEvent,
      log,
    });
    const activeHost = host;

    worker.addEventListener("message", (event: { data: WorkerHostOutput }) => {
      const data = event.data;
      if (!data || typeof data !== "object" || settled) return;
      if (data.type === "engine.messages") {
        activeHost.handleEngineMessages(data.messages, data.snapshot);
        return;
      }
      if (data.type === "engine.processed" || data.type === "engine.process-failed") {
        const pending = pendingProcess.get(data.requestId);
        if (!pending) return;
        pendingProcess.delete(data.requestId);
        if (data.type === "engine.processed" && data.bytes instanceof ArrayBuffer) pending.resolve(data.bytes);
        else pending.reject(runnerError("browser.processing-failed", "A tile could not be processed."));
        return;
      }
      if (data.type === "engine.log" && typeof data.line === "string") {
        log("info", "worker", data.line);
        return;
      }
      if (data.type === "engine.error") {
        if (settled) return;
        settled = true;
        sink.event({ type: "failed", error: data.error }, status());
      }
    });

    activeHost.start(request.inputs);

    async function command(command: UserCommand): Promise<void> {
      if (settled && command.type !== "cancel") {
        throw runnerError("browser.job-settled", "The browser job already finished.");
      }
      switch (command.type) {
        case "select-image":
          activeHost.selectImage(command.image);
          return;
        case "select-level":
          activeHost.selectLevel(command.level);
          return;
        case "recovery-choice":
          activeHost.chooseRecovery(command.generation, command.choice);
          return;
        case "pause":
          activeHost.pause();
          return;
        case "resume":
          activeHost.resume();
          return;
        case "cancel":
          activeHost.cancel();
          return;
        default:
          throw runnerError("browser.unsupported-command", `The browser runner has no command for ${command.type} yet.`);
      }
    }

    async function dispose(): Promise<void> {
      settled = true;
      abortAttempt();
      for (const { reject } of pendingProcess.values()) {
        reject(runnerError("browser.job-settled", "The browser job already finished."));
      }
      pendingProcess.clear();
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

    const handle: BrowserJobHandle = {
      command,
      dispose,
      resolvePermission: (granted: boolean) => {
        activeHost.resolvePermission(granted);
      },
    };
    return handle;
  }

  return { start };
}
