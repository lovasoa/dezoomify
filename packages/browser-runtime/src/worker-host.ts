// Shared worker entrypoint for the website and extension. Rust owns the job
// state machine; this module transfers browser-owned bytes through the
// generated typed WASM ABI.
import type {
  DispatchResult,
  EngineSnapshotDto,
  ErrorDto,
  FetchFailureDto,
  HostCompletion,
  HostEffect,
  JobCommand,
  JobInputDto,
  ProcessingRecipe,
  ProbeOutcome,
  Session as WasmSession,
  SessionConfig,
} from "@dezoomify/wasm-bindings";
import { dispatchTyped } from "./typed-dispatch.ts";
import type { DispatchTable } from "./typed-dispatch.ts";

export type WorkerHostLog = (
  level: "debug" | "info" | "warn" | "error",
  code: string,
  detail?: unknown,
) => void;

function abiFault(error: unknown): ErrorDto {
  const detail = error instanceof Error ? error.message : String(error);
  return {
    code: "adapter.abi",
    phase: "validation",
    retryable: false,
    message: "The browser and image engine could not exchange a typed message.",
    recovery: [],
    transport: "browser-session",
    detail,
  };
}

export interface WorkerHostWasm {
  default?: () => Promise<void>;
  Session: typeof WasmSession;
}

export type WorkerHostMessage =
  | { type: "engine.start"; jobId: string; inputs: JobInputDto[]; quotas?: SessionConfig }
  | { type: "engine.bytes"; requestId: number; bytes: Uint8Array; finalUri?: string }
  | { type: "engine.probe"; requestId: number; outcome: ProbeOutcome }
  | { type: "engine.display"; requestId: number }
  | { type: "engine.acquired"; requestId: number }
  | { type: "engine.process"; requestId: number; recipe: ProcessingRecipe; bytes: Uint8Array | ArrayBuffer }
  | { type: "engine.rank"; requestId: number; urls: string[] }
  | { type: "engine.failure"; requestId: number; error: FetchFailureDto }
  | { type: "engine.timer-elapsed"; tile: number; attempt: number }
  | { type: "engine.command"; command: JobCommand }
  | { type: "engine.finalize"; outcome: Extract<HostCompletion, { type: "finalization-succeeded" } | { type: "finalization-failed" }> }
  | { type: "engine.dispose" };

export type WorkerHostOutput =
  | { type: "engine.messages"; messages: HostEffect[]; snapshot: EngineSnapshotDto }
  | { type: "engine.processed"; requestId: number; bytes: ArrayBuffer }
  | { type: "engine.process-failed"; requestId: number; error: ErrorDto }
  | { type: "engine.ranked"; requestId: number; urls: string[] }
  | { type: "engine.error"; error: ErrorDto }
  | { type: "engine.log"; line: string };

export function createJobWorkerHost(deps: {
  postMessage(message: WorkerHostOutput, transfer?: Transferable[]): void;
  wasm(): Promise<WorkerHostWasm>;
  log?: WorkerHostLog;
}) {
  const log: WorkerHostLog = deps.log ?? (() => {});
  let session: WasmSession | null = null;
  let disposed = false;

  function publish(result: DispatchResult): void {
    if (result.status === "error") {
      log("error", "core-error", `code=${result.error.code} phase=${result.error.phase} message=${result.error.message}`);
      deps.postMessage({ type: "engine.error", error: result.error });
      return;
    }
    const messages: HostEffect[] = result.messages;
    const snapshot: EngineSnapshotDto = result.snapshot;
    // Snapshots always cross the worker boundary, even when the dispatch
    // produced no messages: the snapshot is the only job-state object and
    // the UI renders it directly. Stale revisions are dropped at the
    // runner edge, never here.
    log("debug", "messages-returned", `effects=${messages.length} revision=${snapshot.revision}`);
    deps.postMessage({ type: "engine.messages", messages, snapshot });
  }

  function dispatch(command: JobCommand): void {
    if (!session || disposed) return;
    log("debug", "command-dispatched", `command=${command.type}`);
    publish(session.command(command));
  }

  function complete(completion: HostCompletion): void {
    if (!session || disposed) return;
    const request = "request" in completion ? completion.request : undefined;
    log("debug", "completion-dispatched", `completion=${completion.type}${request === undefined ? "" : ` request=${request}`}`);
    publish(session.complete(completion));
  }

  async function start(message: Extract<WorkerHostMessage, { type: "engine.start" }>): Promise<void> {
    const wasm = await deps.wasm();
    if (disposed) return;
    await wasm.default?.();
    session = new wasm.Session(message.quotas ?? {});
    log("info", "session-created", `jobId=${String(message.jobId)} typed-abi=true`);
    dispatch({ type: "start", inputs: message.inputs });
  }

  function provideBytes(message: Extract<WorkerHostMessage, { type: "engine.bytes" }>): void {
    if (!session || disposed) return;
    // Direct-bytes provide: browser-owned bytes ride inline on the completion;
    // the WASM byte arena is gone (no allocate/write/commit/take/free).
    // The generated contract declares `bytes: number[]`, so the host sends
    // a plain array (only small discovery metadata travels here; tile
    // success is body-free and never carries bytes).
    const finalUri = message.finalUri !== "" ? message.finalUri : undefined;
    complete({
      type: "provide-resource",
      request: message.requestId,
      bytes: Array.from(message.bytes),
      ...(finalUri ? { final_uri: finalUri } : {}),
    });
  }

  function provideProbe(message: Extract<WorkerHostMessage, { type: "engine.probe" }>): void {
    complete({ type: "provide-probe-outcome", request: message.requestId, outcome: message.outcome });
  }

  function provideDisplay(message: Extract<WorkerHostMessage, { type: "engine.display" }>): void {
    complete({ type: "provide-display-outcome", request: message.requestId });
  }

  function reportAcquired(message: Extract<WorkerHostMessage, { type: "engine.acquired" }>): void {
    // Body-free tile acknowledgment: the tile was fetched, decoded, and
    // placed host-side, so only the typed outcome crosses into the engine.
    complete({ type: "tile-acquired", request: message.requestId });
  }

  function processTile(message: Extract<WorkerHostMessage, { type: "engine.process" }>): void {
    if (!session || disposed) return;
    const bytes = message.bytes instanceof Uint8Array
      ? message.bytes
      : new Uint8Array(message.bytes);
    try {
      const out = new Uint8Array(session.applyProcessing({ recipe: message.recipe }, bytes)).slice();
      deps.postMessage({ type: "engine.processed", requestId: message.requestId, bytes: out.buffer }, [out.buffer]);
    } catch (error) {
      deps.postMessage({ type: "engine.process-failed", requestId: message.requestId, error: abiFault(error) });
    }
  }

  const messageHandlers = {
    "engine.start": start,
    "engine.bytes": provideBytes,
    "engine.probe": provideProbe,
    "engine.display": provideDisplay,
    "engine.acquired": reportAcquired,
    "engine.process": processTile,
    "engine.rank": (input) => {
      deps.postMessage({ type: "engine.ranked", requestId: input.requestId, urls: input.urls });
    },
    "engine.failure": (input) => {
      complete({ type: "provide-fetch-failure", request: input.requestId, error: input.error });
    },
    "engine.timer-elapsed": (input) => {
      complete({ type: "retry-timer-elapsed", tile: input.tile, attempt: input.attempt });
    },
    "engine.command": (input) => dispatch(input.command),
    "engine.finalize": (input) => complete(input.outcome),
    "engine.dispose": () => {
      log("info", "session-disposed", "");
      disposed = true;
      try {
        if (session) publish(session.dispose());
      } finally {
        session = null;
      }
    },
  } satisfies DispatchTable<WorkerHostMessage, void | Promise<void>>;

  return {
    async onMessage(message: unknown) {
      if (!message || typeof message !== "object" || disposed) return;
      const input = message as WorkerHostMessage;
      try {
        await dispatchTyped(messageHandlers, input);
      } catch (error) {
        const failure = abiFault(error);
        log("error", "core-error", `code=${failure.code} phase=${failure.phase} message=${failure.message}`);
        deps.postMessage({ type: "engine.error", error: failure });
      }
    },
  };
}

export type JobWorkerHost = ReturnType<typeof createJobWorkerHost>;
