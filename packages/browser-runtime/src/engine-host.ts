// Shared engine-effect host for browser products (website + extension).
//
// One job-engine session drives both products: the host answers the
// engine's correlated effects and forwards engine events to product UI. It
// owns no job policy: retries, cancellation, partial-output decisions, and
// ordering belong to the engine. Products inject their transports
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
import type { TileImageLike } from "./tile-draw.ts";
import type { ProbeSize } from "./probe.ts";
import type { WorkerHostMessage } from "./worker-host.ts";
import { dispatchTyped } from "./typed-dispatch.ts";
import type { DispatchTable } from "./typed-dispatch.ts";
import type {
  BlockedReason,
  ErrorDto,
  ErrorTransport,
  FetchFailureDto,
  HostMessage,
  JobEvent,
  JobInputDto,
  OutputFormat,
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
}

export type AcquireEffect = Extract<HostMessage, { kind: "effect"; type: "acquire-resource" | "acquire-tile" }>;
type EffectMessage = Extract<HostMessage, { kind: "effect" }>;

export interface HostFailure {
  code: string;
  retryable: boolean;
  message: string;
  blocked_reason?: BlockedReason;
  transport: ErrorTransport;
  http?: number;
  preview?: string;
  detail?: string;
}

export interface EngineHostDeps {
  worker: { postMessage(message: WorkerHostMessage): void };
  jobId(): string;
  /** Fetch one effect resource as readable bytes (product transport). */
  fetchResource(effect: AcquireEffect): Promise<{ bytes: Uint8Array; finalUri?: string }>;
  /**
   * One-attempt fetch used to classify a tile origin (no transport retries).
   * Defaults to `fetchResource`; hosts with a retrying transport supply a
   * single-attempt variant so an unreadable origin is detected once.
   */
  fetchResourceOnce?(effect: AcquireEffect): Promise<{ bytes: Uint8Array; finalUri?: string }>;
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
  onEvent(event: JobEvent): void;
  log?(level: "debug" | "info" | "warn" | "error", code: string, detail?: unknown): void;
}

export type RecoveryChoice = "keep" | "retry" | "discard";

export function createEngineHost(deps: EngineHostDeps) {
  const log: NonNullable<EngineHostDeps["log"]> = deps.log ?? (() => {});
  let cancelled = false;
  let disposed = false;
  const settled = new Set<number>();
  /** Requests paused while the host asks for an optional grant. */
  const waitingForPermission = new Map<number, { effect: AcquireEffect; failure: HostFailure }>();
  let chain = Promise.resolve();

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

  // Per-origin readable/display classification. The first tile of an origin
  // performs the readable attempt; concurrent tiles of the same origin wait
  // for that classification instead of repeating a fetch that is known to
  // fail. Once an origin is display-only, later tiles go straight to <img>.
  type OriginMode = "readable" | "display";
  interface OriginState {
    settled: boolean;
    mode?: OriginMode;
    promise: Promise<OriginMode>;
    resolve: (mode: OriginMode) => void;
  }
  const originStates = new Map<string, OriginState>();

  function originOf(url: string): string {
    try {
      return new URL(url, typeof window === "undefined" ? undefined : window.location.href).origin;
    } catch {
      return url;
    }
  }

  /** Claim the origin for a first tile, or share the existing classification. */
  function claimOrigin(url: string): { state: OriginState; owner: boolean } {
    const origin = originOf(url);
    const existing = originStates.get(origin);
    if (existing) return { state: existing, owner: false };
    let resolve!: (mode: OriginMode) => void;
    const promise = new Promise<OriginMode>((r) => { resolve = r; });
    // A shared classification never settles for a disposed attempt.
    promise.catch(() => undefined);
    const state: OriginState = { settled: false, promise, resolve };
    originStates.set(origin, state);
    return { state, owner: true };
  }

  function settleOrigin(state: OriginState | null, mode: OriginMode): void {
    if (!state || state.settled) return;
    state.settled = true;
    state.mode = mode;
    state.resolve(mode);
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
      if (cancelled) return true;
      const width = image.naturalWidth;
      const height = image.naturalHeight;
      if (!(width > 0 && height > 0)) return false;
      deps.assembly.acquireDisplayTile(effect.tile, effect.placement, image);
      log("debug", "effect-outcome", `type=${effect.type} request=${requestId} display=true size=${width}x${height}`);
      if (!cancelled) {
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
      ...(failure.preview ? { preview: failure.preview } : {}),
      ...(failure.detail ? { detail: failure.detail } : {}),
    };
  }

  async function acquire(effect: AcquireEffect) {
    const request = effect.request;
    if (settled.has(request.id)) return;
    settled.add(request.id);
    // Probe effects resolve planning geometry. Probe-and-output effects also
    // retain the successful tile so the resolved plan does not fetch it again.
    if (effect.type === "acquire-tile" && request.purpose === "probe") {
      log("debug", "effect-fetch", `type=${effect.type} request=${request.id} purpose=probe route=probe`);
      try {
        if (effect.placement.probe_output === true) {
          // A probe retained as output participates in the visible assembly;
          // a measurement-only probe must not reveal a provisional canvas.
          deps.assembly.prepare(effect.placement.canvas);
        }
        const size = await deps.probeSize(request.uri, headerRecord(request.headers), request.id);
        if (cancelled) return;
        const probeOutput = effect.placement.probe_output === true;
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
        if (!cancelled) {
          sendToEngine({ type: "engine.probe", requestId: request.id, outcome });
        }
      } catch (error) {
        const failure = deps.classifyFailure(error);
        log("warn", "effect-failed", `type=${effect.type} request=${request.id} code=${String(failure.code ?? failure.blocked_reason ?? "unknown")} retryable=${failure.retryable === true}`);
        if (grantable(error, failure)) {
          waitingForPermission.set(request.id, { effect, failure });
          deps.onPermissionRequired({ hosts: hostsOf(error), requestId: request.id, jobId: deps.jobId() });
          return;
        }
        // A failed probe fetch is a missing observation, never a tile
        // failure: the adapter maps it to ProbeOutcome{available:false}.
        if (!cancelled) sendToEngine({ type: "engine.failure", requestId: request.id, error: fetchFailure(failure) });
      }
      return;
    }
    log("debug", "effect-fetch", `type=${effect.type} request=${request.id} purpose=${request.purpose}`);
    // Classify the origin before fetching an ordinary tile: a display-only
    // origin goes straight to its image, and concurrent first tiles await
    // the owner's classification instead of repeating a failing fetch. The
    // owner classifies with a single attempt so a blocked origin is detected
    // once; the fallback marks the whole origin display-only.
    let originState: OriginState | null = null;
    let originOwner = false;
    if (
      effect.type === "acquire-tile"
      && deps.loadDisplayImage
    ) {
      const claim = claimOrigin(request.uri);
      originState = claim.state;
      originOwner = claim.owner;
      if (!claim.owner) {
        const mode = await originState.promise;
        if (mode === "display" && (await displayFallback(effect, request.id))) return;
      }
    }
    try {
      if (effect.type === "acquire-tile") {
        // Prepare before network I/O so tiles become visible as they arrive.
        deps.assembly.prepare(effect.placement.canvas);
      }
      const fetch = originOwner && deps.fetchResourceOnce ? deps.fetchResourceOnce : deps.fetchResource;
      const result = await fetch(effect);
      if (cancelled) return;
      log("debug", "effect-outcome", `type=${effect.type} request=${request.id} bytes=${result.bytes.byteLength}`);
      if (effect.type === "acquire-tile") {
        // Decode-at-acquisition: the placement is recorded and the bitmap is
        // held before the outcome settles, so assembly never depends on a
        // later bytes hand-off and decode failures retry honestly.
        await deps.assembly.acquireTile(effect.tile, effect.placement, asArrayBuffer(result.bytes));
      }
      settleOrigin(originState, "readable");
      if (!cancelled) {
        sendToEngine({
          type: "engine.bytes",
          requestId: request.id,
          bytes: result.bytes,
          ...(result.finalUri ? { finalUri: result.finalUri } : {}),
        });
      }
    } catch (error) {
      const failure = deps.classifyFailure(error);
      log("warn", "effect-failed", `type=${effect.type} request=${request.id} code=${String(failure.code ?? failure.blocked_reason ?? "unknown")} retryable=${failure.retryable === true}`);
      if (grantable(error, failure)) {
        // A visible, explicit user action may grant this host. Keep the
        // effect pending so the same acquisition can resume after a grant.
        waitingForPermission.set(request.id, { effect, failure });
        deps.onPermissionRequired({ hosts: hostsOf(error), requestId: request.id, jobId: deps.jobId() });
        return;
      }
      if (effect.type === "acquire-tile" && (await displayFallback(effect, request.id))) {
        settleOrigin(originState, "display");
        return;
      }
      // Neither readable nor display worked: settle the shared classification
      // and drop it so a retry can classify the origin again.
      settleOrigin(originState, "readable");
      if (originState) originStates.delete(originOf(request.uri));
      if (!cancelled) sendToEngine({ type: "engine.failure", requestId: request.id, error: fetchFailure(failure) });
    }
  }

  /**
   * Build the protocol `ErrorDto` for a failed awaited output operation.
   * The engine records typed success or failure, never rendered text.
   */
  function finalizationError(error: unknown): ErrorDto {
    const failure = deps.classifyFailure(error);
    return {
      code: failure.code,
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
        type: "engine.command",
        command: { type: "finalization-failed", error: finalizationError(error) },
      });
      return;
    }
    sendToEngine({ type: "engine.command", command: { type: "finalization-succeeded" } });
  }

  function enqueue(step: () => Promise<void> | void) {
    chain = chain
      .then(() => {
        if (!cancelled) return step();
      })
      .catch((error) => {
        if (cancelled) return;
        cancelled = true;
        deps.cancelFetch();
        deps.onHostFailure(error);
        sendToEngine({ type: "engine.command", command: { type: "cancel" } });
      });
  }

  const effectHandlers = {
    "acquire-resource": (effect) => { void acquire(effect); },
    "acquire-tile": (effect) => { void acquire(effect); },
    "finalize-output": (effect) => enqueue(() => finalizeOutput(effect)),
    "cancel-work": () => {
      deps.cancelFetch();
      deps.assembly.release();
    },
    "request-decision": (effect) => enqueue(() => {
      deps.onRecoveryRequested(effect.generation);
    }),
  } satisfies DispatchTable<EffectMessage, void>;

  function handleEngineMessages(messages: HostMessage[]) {
    for (const message of messages) {
      if (message.kind === "effect") {
        log("debug", "effect-received", `type=${message.type}${"tile" in message ? ` tile=${message.tile}` : ""}`);
        dispatchTyped(effectHandlers, message);
      } else {
        // Events pass through the same chain so terminal events never
        // overtake the lifecycle work they describe.
        const event = message;
        log("debug", "event-received", `type=${event.type}`);
        enqueue(() => {
          deps.onEvent(event);
        });
      }
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
    selectLevel(level: number) {
      sendToEngine({ type: "engine.command", command: { type: "select-level", level } });
    },
    chooseRecovery(generation: number, choice: RecoveryChoice) {
      sendToEngine({ type: "engine.command", command: { type: "recovery-choice", generation, choice } });
    },
    pause() {
      sendToEngine({ type: "engine.command", command: { type: "pause" } });
    },
    resume() {
      sendToEngine({ type: "engine.command", command: { type: "resume" } });
    },
    resolvePermission(granted: boolean) {
      const pending = [...waitingForPermission.entries()];
      waitingForPermission.clear();
      for (const [id, { effect, failure }] of pending) {
        if (cancelled) return;
        if (!granted) {
          sendToEngine({ type: "engine.failure", requestId: id, error: fetchFailure(failure) });
          continue;
        }
        settled.delete(id);
        void acquire(effect);
      }
    },
    cancel() {
      if (cancelled) return;
      log("debug", "controller-cancel", "");
      cancelled = true;
      deps.cancelFetch();
      sendToEngine({ type: "engine.command", command: { type: "cancel" } });
    },
    dispose() {
      if (disposed) return;
      log("debug", "controller-dispose", "");
      disposed = true;
      cancelled = true;
      deps.cancelFetch();
      deps.assembly?.release();
      sendToEngine({ type: "engine.dispose" });
    },
  };
}

export type EngineHost = ReturnType<typeof createEngineHost>;
