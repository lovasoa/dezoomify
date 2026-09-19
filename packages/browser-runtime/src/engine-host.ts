// Shared engine-effect host for browser products (website + extension).
//
// One job-engine session drives both products: the host answers the
// engine's correlated effects and forwards engine snapshots to product UI.
// It owns no job policy and keeps no job-state mirrors: retries,
// cancellation, pause, partial-output decisions, and ordering belong to the
// engine. Pause arrives via `snapshot.paused`; retry waits live exactly as
// long as their `wait-retry-timer` effect (the engine ignores stale
// duplicates); permission holds suspend the awaiting effect itself until the
// explicit user action resolves it. Products inject their transports
// (website: direct-first + metadata proxy fallback; extension: tab-origin
// + extension-origin under host grants) and their output assembly.
//
// Two execution lanes, matching the engine's own scheduling:
// - `acquire-resource`/`acquire-tile` run concurrently (the engine already
//   caps in-flight tiles); tile bytes are decoded during acquisition (the
//   native model), so a tile that cannot decode fails its acquisition
//   outcome and flows through the engine's retry/partial policy.
// - every other effect runs through one strictly ordered chain, because the
//   engine emits the decode/encode/publish/release sequence as an ordered
//   batch whose events must not overtake the work they describe.
//
// Probe effects resolve planning geometry only (shared `probe.ts` helper).
// Display fallback (website): when readable bytes are unavailable but an
// ordinary image loads, the tile is held as display-only. The canvas taints
// on draw, so the job completes as display-only with no programmatic save.
import type { EngineSnapshotDto } from "@dezoomify/wasm-bindings";
import { originOfUrl } from "./fetch-primitives.ts";
import type { TileImageLike } from "./tile-draw.ts";
import type { ProbeSize } from "./probe.ts";
import type { WorkerHostMessage } from "./worker-host.ts";
import { dispatchTyped } from "./typed-dispatch.ts";
import type { DispatchTable } from "./typed-dispatch.ts";
import type {
  BlockedReason,
  ErrorDto,
  ErrorTransport,
  FetchFailureCode,
  FetchFailureDto,
  HostEffect,
  JobInputDto,
  OutputFormat,
  RecoveryChoice,
  RequestDto,
  SessionConfig,
  SizeDto,
  TilePlacementDto,
} from "@dezoomify/wasm-bindings";

export interface EngineHostAssembly {
  /** Reveal the declared output surface before the first tile fetch. */
  prepare(canvas?: SizeDto | null): void;
  acquireTile(tile: number, placement: TilePlacementDto, bytes: ArrayBuffer): Promise<void>;
  acquireDisplayTile(tile: number, placement: TilePlacementDto, image: TileImageLike): void;
  /** The one awaited output operation (draw, encode, save / display-only). */
  finalizeOutput(
    partial: boolean,
    format: OutputFormat,
    canvas?: SizeDto | null,
  ): Promise<void>;
  release(): void;
  /** True once an ordinary image tainted the surface (display-only output). */
  isTainted?(): boolean;
}

export type AcquireEffect = Extract<HostEffect, { type: "acquire-resource" | "acquire-tile" }>;
type EffectMessage = HostEffect;

export interface HostFailure {
  code: FetchFailureCode;
  retryable: boolean;
  message: string;
  blocked_reason?: BlockedReason;
  transport: ErrorTransport;
  http?: number;
  retry_after_ms?: number;
  preview?: string;
  detail?: string;
}

export interface EngineHostDeps {
  worker: { postMessage(message: WorkerHostMessage): void };
  jobId(): string;
  /** Fetch one effect resource as readable bytes (product transport). Single attempt; the engine owns retries. */
  fetchResource(effect: AcquireEffect): Promise<{ bytes: Uint8Array; finalUri?: string }>;
  /** Cancel in-flight fetches (product transport). */
  cancelFetch(): void;
  assembly: EngineHostAssembly;
  /** Optional job-budget overrides forwarded to the session at start. */
  quotas?: SessionConfig;
  /** Measure one probe tile (shared probe helper). The engine request id lets a host route the probe like any effect fetch. */
  probeSize(url: string, headers: Record<string, string>, requestId?: number): Promise<ProbeSize>;
  /**
   * Load one tile as an ordinary image element for display-only fallback.
   * Absent: no display fallback (failed acquisitions fail the engine).
   */
  loadDisplayImage?: (url: string) => Promise<TileImageLike>;
  classifyFailure(error: unknown): HostFailure;
  onPermissionRequired(detail: { hosts: string[]; requestId: number; jobId: string }): void;
  /** The engine asks for a keep/retry/discard choice after tile failures. */
  onRecoveryRequested(generation: number): void;
  onHostFailure(error: unknown): void;
  /** Absolute engine snapshot for the UI. The only job-state object. */
  onSnapshot?(snapshot: EngineSnapshotDto): void;
  log?(level: "debug" | "info" | "warn" | "error", code: string, detail?: unknown): void;
}

export type { RecoveryChoice };

export function createEngineHost(deps: EngineHostDeps) {
  const log: NonNullable<EngineHostDeps["log"]> = deps.log ?? (() => {});
  let disposed = false;
  /** Host lifetime: aborted on cancel/dispose so late outcomes never send. Snapshots always forward. */
  const lifetime = new AbortController();
  let chain = Promise.resolve();
  /** Retry waits owned by their `wait-retry-timer` effect, abortable on cancel/dispose. */
  const pendingRetries = new Set<AbortController>();
  /**
   * Effects held for an explicit host grant. Each entry suspends its own
   * acquisition (an effect hold, not a job-state mirror) until
   * resolvePermission releases it; a grant retries the same acquisition in
   * place, a denial fails it typed.
   */
  const permissionGates = new Map<number, (granted: boolean) => void>();
  /**
   * Origins whose ordinary tiles already fell back to `<img>` display-only
   * this job. Only the first tile per origin tries readable bytes; later
   * ordinary tiles load straight through `<img>`.
   */
  const displayOnlyOrigins = new Set<string>();
  /**
   * Origins with a tile classifying readable bytes right now. Concurrent
   * same-origin ordinary tiles await the outcome instead of fetching.
   * Entries always settle (deleted in `finally`), so waiters never hang.
   */
  const originClassifying = new Map<string, Promise<boolean>>();

  function tornDown(): boolean {
    return disposed || lifetime.signal.aborted;
  }

  /**
   * Host-clock wait for one retry delay, abortable on cancel/dispose.
   * Returns true when the wait was abandoned. Mirrors the
   * `sleepUnlessAborted` pattern in `web-fetch.ts`.
   */
  async function sleepWithAbort(ms: number, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return true;
    let onAbort: (() => void) | null = null;
    const aborted = new Promise<boolean>((resolve) => {
      onAbort = () => resolve(true);
      signal.addEventListener("abort", onAbort, { once: true });
    });
    const elapsed = (async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, ms));
      return signal.aborted;
    })();
    const result = await Promise.race([elapsed, aborted]);
    if (onAbort) {
      try {
        signal.removeEventListener("abort", onAbort);
      } catch {
        // Detach is best-effort.
      }
    }
    return result;
  }

  function abortPendingRetries(): void {
    for (const ctrl of pendingRetries) {
      try {
        ctrl.abort();
      } catch {
        // Abort must never break teardown.
      }
    }
    pendingRetries.clear();
  }

  /** Release every held effect. Denials fail the held acquisitions typed. */
  function releaseGates(granted: boolean): void {
    if (permissionGates.size === 0) return;
    const gates = [...permissionGates.values()];
    permissionGates.clear();
    for (const resolve of gates) {
      try {
        resolve(granted);
      } catch {
        // Release must never break teardown.
      }
    }
  }

  /**
   * Explicit retry wait: the host waits `delay_ms` on its own clock then
   * answers with the same tile and attempt. The wait lives exactly as long
   * as this effect handling; the engine ignores stale duplicates, so no
   * pause parking is kept host-side.
   */
  async function waitRetryTimer(effect: Extract<EffectMessage, { type: "wait-retry-timer" }>): Promise<void> {
    const ctrl = new AbortController();
    pendingRetries.add(ctrl);
    try {
      log("debug", "effect-retry-wait", `tile=${effect.tile} attempt=${effect.attempt} delay_ms=${effect.delay_ms}`);
      const abandoned = await sleepWithAbort(effect.delay_ms, ctrl.signal);
      if (tornDown() || abandoned || ctrl.signal.aborted) return;
      log("debug", "effect-retry-elapsed", `tile=${effect.tile} attempt=${effect.attempt}`);
      sendToEngine({ type: "engine.timer-elapsed", effect: effect.effect });
    } finally {
      pendingRetries.delete(ctrl);
    }
  }

  function sendToEngine(message: WorkerHostMessage) {
    deps.worker.postMessage(message);
  }

  function asArrayBuffer(view: Uint8Array): ArrayBuffer {
    return new Uint8Array(view).slice().buffer;
  }

  function hostsOf(error: unknown): string[] {
    if (error !== null && typeof error === "object" && "hosts" in error && Array.isArray(error.hosts)) {
      return error.hosts.filter((host): host is string => typeof host === "string");
    }
    return [];
  }

  /**
   * Only a missing host grant pauses for a visible permission action.
   * Upstream refusals (a granted-origin 401/403) and programming errors
   * (missing user intent) fail directly; re-prompting cannot fix them.
   */
  function grantable(error: unknown, failure: HostFailure): boolean {
    return failure.blocked_reason === "access-required"
      && error !== null && typeof error === "object"
      && (error as { code?: unknown }).code === "permission-denied";
  }

  /**
   * Normalize generated request headers to the record `fetch` accepts. The contract
   * shape is `HeaderDto[]` (`{name, value}`); hosts and `fetch` expect a
   * plain object.
   */
  function headerRecord(headers: RequestDto["headers"]): Record<string, string> {
    return Object.fromEntries((headers ?? []).map(({ name, value }) => [name, value]));
  }

  function plainRecipe(placement: TilePlacementDto): boolean {
    return placement.processing === "none";
  }

  async function displayFallback(
    effect: AcquireEffect,
    requestId: number,
  ): Promise<boolean> {
    if (!deps.loadDisplayImage || effect.type !== "acquire-tile") {
      return false;
    }
    // Display-only output is only legitimate for unprocessed ordinary tiles:
    // a tainted canvas can never satisfy a processing recipe.
    if (!plainRecipe(effect.placement)) return false;
    const uri = effect.request.uri;
    try {
      const image = await deps.loadDisplayImage(uri);
      if (tornDown()) return true;
      const width = image.naturalWidth;
      const height = image.naturalHeight;
      if (!(width > 0 && height > 0)) return false;
      deps.assembly.acquireDisplayTile(effect.tile, effect.placement, image);
      // A successful ordinary `<img>` fallback marks that origin
      // display-only for the job, so later ordinary tiles skip readable
      // bytes and load directly through `<img>`.
      const origin = originOfUrl(uri);
      if (origin !== "") displayOnlyOrigins.add(origin);
      log("debug", "effect-outcome", `type=${effect.type} request=${requestId} display=true size=${width}x${height}`);
      if (!tornDown()) {
        sendToEngine({ type: "engine.display", requestId });
      }
      return true;
    } catch {
      return false;
    }
  }

  function fetchFailure(failure: HostFailure): FetchFailureDto {
    return {
      code: failure.code,
      retryable: failure.retryable,
      message: failure.message,
      recovery: [],
      transport: failure.transport,
      ...(failure.blocked_reason ? { blocked_reason: failure.blocked_reason } : {}),
      ...(typeof failure.http === "number" ? { http: failure.http } : {}),
      ...(typeof failure.retry_after_ms === "number" ? { retry_after_ms: failure.retry_after_ms } : {}),
      ...(failure.preview ? { preview: failure.preview } : {}),
      ...(failure.detail ? { detail: failure.detail } : {}),
    };
  }

  /**
   * Suspend one acquisition for the visible permission action. A grant
   * retries the same acquisition in place; a denial fails it typed. The
   * hold belongs to the effect lifetime: teardown releases it denied and
   * the waiter suppresses its outcome.
   */
  function holdForPermission(requestId: number, error: unknown): Promise<boolean> {
    deps.onPermissionRequired({ hosts: hostsOf(error), requestId, jobId: deps.jobId() });
    return new Promise<boolean>((resolve) => {
      permissionGates.set(requestId, resolve);
    });
  }

  async function acquireProbe(effect: AcquireEffect): Promise<void> {
    const request = effect.request;
    // Probe effects resolve planning geometry. Probe-and-output effects also
    // retain the successful tile so the resolved plan does not fetch it again.
    for (;;) {
      if (tornDown()) return;
      log("debug", "effect-fetch", `type=${effect.type} request=${request.id} purpose=probe route=probe`);
      try {
        if (effect.type === "acquire-tile" && effect.placement.probe_output === true) {
          // A probe retained as output participates in the visible assembly;
          // a measurement-only probe must not reveal a provisional canvas.
          deps.assembly.prepare(effect.placement.canvas);
        }
        const size = await deps.probeSize(request.uri, headerRecord(request.headers), request.id);
        if (tornDown()) return;
        const probeOutput = effect.type === "acquire-tile" && effect.placement.probe_output === true;
        let outcome = size.status === "available"
          ? { status: "available" as const, width: size.width, height: size.height }
          : { status: "missing" as const };
        if (size.status === "available" && probeOutput) {
          if (size.bytes) {
            await deps.assembly.acquireTile(effect.tile, effect.placement, size.bytes);
          } else if (size.image) {
            deps.assembly.acquireDisplayTile(effect.tile, effect.placement, size.image);
          } else {
            // An available probe-and-output observation must be retainable;
            // otherwise the core would correctly skip a tile the host lost.
            outcome = { status: "missing" };
          }
        }
        const dimensions = outcome.status === "available" ? `${outcome.width}x${outcome.height}` : "missing";
        log("debug", "effect-outcome", `type=${effect.type} request=${request.id} probe=${dimensions}`);
        if (!tornDown()) {
          sendToEngine({ type: "engine.probe", requestId: request.id, outcome });
        }
        return;
      } catch (error) {
        const failure = deps.classifyFailure(error);
        log("warn", "effect-failed", `type=${effect.type} request=${request.id} code=${String(failure.code ?? failure.blocked_reason ?? "unknown")} retryable=${failure.retryable === true}`);
        if (grantable(error, failure)) {
          const granted = await holdForPermission(request.id, error);
          permissionGates.delete(request.id);
          if (!granted) {
            if (tornDown()) return;
            sendToEngine({ type: "engine.failure", requestId: request.id, error: fetchFailure(failure) });
            return;
          }
          continue;
        }
        // A failed probe fetch is a missing observation, never a tile
        // failure: the adapter maps it to ProbeOutcome{available:false}.
        if (tornDown()) return;
        sendToEngine({ type: "engine.failure", requestId: request.id, error: fetchFailure(failure) });
        return;
      }
    }
  }

  async function acquire(effect: AcquireEffect) {
    const request = effect.request;
    if (tornDown()) return;
    if (effect.type === "acquire-tile" && request.purpose === "probe") {
      await acquireProbe(effect);
      return;
    }
    // Ordinary tiles share one per-origin readable-bytes classification:
    // the first tile decides while concurrent same-origin tiles wait for
    // its outcome instead of repeating the fetch. Tiles of a display-only
    // origin load straight through `<img>`. A failed fast path falls
    // through to the normal attempt below.
    if (effect.type === "acquire-tile" && plainRecipe(effect.placement) && deps.loadDisplayImage) {
      const origin = originOfUrl(request.uri);
      if (origin !== "") {
        if (displayOnlyOrigins.has(origin)) {
          if (await displayFallback(effect, request.id)) return;
          if (tornDown()) return;
        } else if (originClassifying.has(origin)) {
          const displayOnly = await originClassifying.get(origin)!;
          if (tornDown()) return;
          if (displayOnly) {
            if (await displayFallback(effect, request.id)) return;
            if (tornDown()) return;
          }
        } else {
          let resolveClass!: (displayOnly: boolean) => void;
          const classified = new Promise<boolean>((resolve) => {
            resolveClass = resolve;
          });
          originClassifying.set(origin, classified);
          let settled = false;
          const settle = (displayOnly: boolean) => {
            if (settled) return;
            settled = true;
            resolveClass(displayOnly);
          };
          try {
            await acquireAttempt(effect, settle);
          } finally {
            settle(false);
            originClassifying.delete(origin);
          }
          return;
        }
      }
    }
    await acquireAttempt(effect);
  }

  async function acquireAttempt(effect: AcquireEffect, settle?: (displayOnly: boolean) => void) {
    const request = effect.request;
    log("debug", "effect-fetch", `type=${effect.type} request=${request.id} purpose=${request.purpose}`);
    for (;;) {
      if (tornDown()) return;
      try {
        if (effect.type === "acquire-tile") {
          // Prepare before network I/O so tiles become visible as they arrive.
          deps.assembly.prepare(effect.placement.canvas);
        }
        const result = await deps.fetchResource(effect);
        // Readable bytes for this origin: it is not display-only.
        settle?.(false);
        if (tornDown()) return;
        log("debug", "effect-outcome", `type=${effect.type} request=${request.id} bytes=${result.bytes.byteLength}`);
        if (effect.type === "acquire-tile") {
          // Decode-at-acquisition: the placement is recorded and the bitmap is
          // held before the outcome settles, so assembly never depends on a
          // later bytes hand-off and decode failures retry honestly.
          await deps.assembly.acquireTile(effect.tile, effect.placement, asArrayBuffer(result.bytes));
        }
        if (tornDown()) return;
        if (effect.type === "acquire-tile") {
          // Body-free tile acknowledgment: the tile was decoded and placed
          // above, so only the typed outcome crosses into the engine. Only
          // metadata (`acquire-resource`) carries bytes.
          sendToEngine({ type: "engine.acquired", requestId: request.id });
          return;
        }
        sendToEngine({
          type: "engine.bytes",
          requestId: request.id,
          bytes: result.bytes,
          ...(result.finalUri ? { finalUri: result.finalUri } : {}),
        });
        return;
      } catch (error) {
        const failure = deps.classifyFailure(error);
        log("warn", "effect-failed", `type=${effect.type} request=${request.id} code=${String(failure.code ?? failure.blocked_reason ?? "unknown")} retryable=${failure.retryable === true}`);
        if (grantable(error, failure)) {
          // A visible, explicit user action may grant this host. Hold the
          // effect so the same acquisition resumes after a grant.
          const granted = await holdForPermission(request.id, error);
          permissionGates.delete(request.id);
          if (!granted) {
            if (tornDown()) return;
            sendToEngine({ type: "engine.failure", requestId: request.id, error: fetchFailure(failure) });
            return;
          }
          continue;
        }
        if (effect.type === "acquire-tile") {
          const fellBack = await displayFallback(effect, request.id);
          settle?.(fellBack);
          if (fellBack) return;
        }
        if (tornDown()) return;
        sendToEngine({ type: "engine.failure", requestId: request.id, error: fetchFailure(failure) });
        return;
      }
    }
  }

  /**
   * Build the protocol `ErrorDto` for a failed awaited output operation.
   * The engine records typed success or failure, never rendered text.
   */
  function finalizationError(error: unknown): ErrorDto {
    const failure = deps.classifyFailure(error);
    return {
      code: `${failure.code}`,
      phase: "output",
      retryable: failure.retryable,
      message: failure.message,
      recovery: [],
      ...(failure.transport ? { transport: failure.transport } : {}),
      ...(failure.detail ? { detail: failure.detail } : {}),
    };
  }

  /**
   * Ordered lifecycle effects. Any executor failure is terminal for this
   * host: the failure is rendered and the engine job is cancelled so no
   * effect is silently skipped or faked.
   */
  async function finalizeOutput(effect: Extract<EffectMessage, { type: "finalize-output" }>) {
    try {
      await deps.assembly.finalizeOutput(
        effect.partial === true,
        effect.format,
        effect.canvas ?? null,
      );
    } catch (error) {
      sendToEngine({
        type: "engine.finalize",
        outcome: { type: "finalization-failed", effect: effect.effect, error: finalizationError(error) },
      });
      return;
    }
    sendToEngine({
      type: "engine.finalize",
      // Honest disposition from the performing host: a tainted canvas was
      // shown without readable bytes, so the engine must present preview
      // instead of claiming a saved file.
      outcome: {
        type: "finalization-succeeded",
        effect: effect.effect,
        disposition: deps.assembly.isTainted?.() === true ? "display-only" : "browser-save-initiated",
      },
    });
  }

  /** Abort in-flight host work: retry waits, permission holds, and fetches. */
  function abortInFlight(): void {
    abortPendingRetries();
    releaseGates(false);
    try {
      lifetime.abort();
    } catch {
      // Abort must never break teardown.
    }
    try {
      deps.cancelFetch();
    } catch {
      // Product abort must never break teardown.
    }
  }

  function enqueue(step: () => Promise<void> | void) {
    chain = chain
      .then(() => {
        if (!tornDown()) return step();
      })
      .catch((error) => {
        if (tornDown()) return;
        abortInFlight();
        deps.onHostFailure(error);
        sendToEngine({ type: "engine.command", command: { type: "cancel" } });
      });
  }

  const effectHandlers = {
    "acquire-resource": (effect) => { void acquire(effect); },
    "acquire-tile": (effect) => { void acquire(effect); },
    "finalize-output": (effect) => enqueue(() => finalizeOutput(effect)),
    "wait-retry-timer": (effect) => { void waitRetryTimer(effect); },
    "cancel-work": () => {
      abortPendingRetries();
      releaseGates(false);
      try {
        deps.cancelFetch();
      } catch {
        // Product abort must never break teardown.
      }
      deps.assembly.release();
    },
    "request-decision": (effect) => enqueue(() => {
      deps.onRecoveryRequested(effect.generation);
    }),
  } satisfies DispatchTable<EffectMessage, void>;

  function handleEngineMessages(messages: HostEffect[], snapshot?: EngineSnapshotDto) {
    // The snapshot is the only job-state object: it always forwards,
    // including after cancel. Engine events carry no state host-side
    // (pause, terminals, and progress all ride the snapshot) and are only
    // logged here, never refolded.
    if (snapshot) deps.onSnapshot?.(snapshot);
    for (const message of messages) {
      log("debug", "effect-received", `type=${message.type}${"tile" in message ? ` tile=${message.tile}` : ""}`);
      dispatchTyped(effectHandlers, message);
    }
  }

  return {
    handleEngineMessages,
    start(inputs: JobInputDto[]) {
      sendToEngine({
        type: "engine.start",
        jobId: deps.jobId(),
        inputs,
        ...(deps.quotas ? { quotas: deps.quotas } : {}),
      });
    },
    selectImage(image: number) {
      sendToEngine({ type: "engine.command", command: { type: "select-image", image } });
    },
    followDeferred(image: number) {
      sendToEngine({ type: "engine.command", command: { type: "follow-deferred", image } });
    },
    selectLevel(level: number) {
      sendToEngine({ type: "engine.command", command: { type: "select-level", level } });
    },
    chooseRecovery(generation: number, choice: RecoveryChoice) {
      sendToEngine({ type: "engine.command", command: { type: "answer-partial", generation, decision: choice } });
    },
    pause() {
      // Pause state arrives back via snapshot.paused; the host keeps no flag.
      sendToEngine({ type: "engine.command", command: { type: "pause" } });
    },
    resume() {
      sendToEngine({ type: "engine.command", command: { type: "resume" } });
    },
    resolvePermission(granted: boolean) {
      // Release the held effects; each resumes (grant) or fails typed (denial).
      releaseGates(granted);
    },
    cancel() {
      if (disposed || lifetime.signal.aborted) return;
      log("debug", "controller-cancel", "");
      abortInFlight();
      sendToEngine({ type: "engine.command", command: { type: "cancel" } });
    },
    dispose() {
      if (disposed) return;
      log("debug", "controller-dispose", "");
      disposed = true;
      abortInFlight();
      deps.assembly?.release();
      sendToEngine({ type: "engine.dispose" });
    },
  };
}

export type EngineHost = ReturnType<typeof createEngineHost>;
