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

export interface EngineHostAssembly {
  acquireTile(tile: number, placement: unknown, bytes: ArrayBuffer): Promise<void>;
  acquireDisplayTile(tile: number, placement: unknown, image: TileImageLike): void;
  /** The one awaited output operation (draw, encode, save / display-only). */
  finalizeOutput(
    partial: boolean,
    format: string,
    canvas?: { width: number; height: number } | null,
  ): Promise<void>;
  release(): void;
}

export interface EngineHostRequest {
  id: number;
  purpose: string;
  uri: string;
  method?: string;
  headers?: Record<string, string> | Array<{ name: string; value: string }>;
}

export interface EngineHostEffect {
  kind: "effect" | "event";
  type: string;
  request?: EngineHostRequest;
  tile?: number;
  placement?: unknown;
  format?: string;
  canvas?: { width: number; height: number } | null;
  generation?: number;
  [key: string]: unknown;
}

export interface EngineHostDeps {
  worker: { postMessage(message: unknown): void };
  jobId(): string;
  /** Fetch one effect resource as readable bytes (product transport). */
  fetchResource(effect: EngineHostEffect): Promise<{ bytes: Uint8Array; finalUri?: string }>;
  /**
   * One-attempt fetch used to classify a tile origin (no transport retries).
   * Defaults to `fetchResource`; hosts with a retrying transport supply a
   * single-attempt variant so an unreadable origin is detected once.
   */
  fetchResourceOnce?(effect: EngineHostEffect): Promise<{ bytes: Uint8Array; finalUri?: string }>;
  /** Cancel in-flight fetches (product transport). */
  cancelFetch(): void;
  assembly: EngineHostAssembly;
  /** Optional job-budget overrides forwarded to the session at start. */
  quotas?: Record<string, unknown>;
  /** Measure one probe tile (shared probe helper). */
  probeSize(url: string, headers: Record<string, string>): Promise<{
    ok: boolean;
    width: number;
    height: number;
    bytes?: ArrayBuffer;
    image?: TileImageLike;
  }>;
  /**
   * Load one tile as an ordinary image element for display-only fallback.
   * Absent: no display fallback (failed acquisitions fail the engine).
   */
  loadDisplayImage?: (url: string) => Promise<TileImageLike>;
  classifyFailure(error: unknown): { blocked_reason?: string; [key: string]: unknown };
  onPermissionRequired(detail: { hosts: string[]; requestId: number; jobId: string }): void;
  /** The engine asks for a keep/retry/discard choice after tile failures. */
  onRecoveryRequested(generation: number): void;
  onHostFailure(error: unknown): void;
  onEvent(event: unknown): void;
  onUnsupportedEffect(envelope: unknown): void;
  log?(level: "debug" | "info" | "warn" | "error", code: string, detail?: unknown): void;
}

export type RecoveryChoice = "keep" | "retry" | "discard";

export function createEngineHost(deps: EngineHostDeps) {
  const log: NonNullable<EngineHostDeps["log"]> = deps.log ?? (() => {});
  let cancelled = false;
  let disposed = false;
  const settled = new Set<number>();
  /** Requests paused while the host asks for an optional grant. */
  const waitingForPermission = new Map<number, { effect: EngineHostEffect; failure: { blocked_reason?: string; [key: string]: unknown } }>();
  let chain = Promise.resolve();

  function sendToEngine(message: unknown) {
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
  function grantable(error: unknown, failure: { blocked_reason?: string; [key: string]: unknown }): boolean {
    return failure.blocked_reason === "access-required"
      && error !== null && typeof error === "object"
      && (error as { code?: unknown }).code === "permission-denied";
  }

  /**
   * Normalize protocol headers to the record `fetch` accepts. The wire
   * shape is `HeaderDto[]` (`{name, value}`); hosts and `fetch` expect a
   * plain object.
   */
  function headerRecord(headers: EngineHostRequest["headers"]): Record<string, string> {
    if (Array.isArray(headers)) {
      const out: Record<string, string> = {};
      for (const header of headers) {
        if (header && typeof header.name === "string" && typeof header.value === "string") {
          out[header.name] = header.value;
        }
      }
      return out;
    }
    if (headers && typeof headers === "object") return headers;
    return {};
  }

  function plainRecipe(placement: unknown): boolean {
    const processing = (placement as { processing?: unknown } | undefined)?.processing;
    return processing === undefined || processing === null || processing === "" || processing === "none";
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
    effect: EngineHostEffect,
    requestId: number,
  ): Promise<boolean> {
    if (!deps.loadDisplayImage || effect.type !== "acquire-tile" || typeof effect.tile !== "number" || !effect.placement) {
      return false;
    }
    // Display-only output is only legitimate for unprocessed ordinary tiles:
    // a tainted canvas can never satisfy a processing recipe.
    if (!plainRecipe(effect.placement)) return false;
    const uri = effect.request?.uri;
    if (typeof uri !== "string" || uri === "") return false;
    try {
      const image = await deps.loadDisplayImage(uri);
      if (cancelled) return true;
      const width = image.naturalWidth;
      const height = image.naturalHeight;
      if (!(width > 0 && height > 0)) return false;
      deps.assembly.acquireDisplayTile(effect.tile, effect.placement, image);
      log("debug", "effect-outcome", `type=${effect.type} request=${requestId} display=true size=${width}x${height}`);
      if (!cancelled) {
        sendToEngine({ type: "engine.display", requestId, width, height });
      }
      return true;
    } catch {
      return false;
    }
  }

  async function acquire(effect: EngineHostEffect) {
    const request = effect.request;
    if (!request || !Number.isSafeInteger(request.id) || request.id < 0 || settled.has(request.id)) return;
    settled.add(request.id);
    // Probe effects resolve planning geometry. Probe-and-output effects also
    // retain the successful tile so the resolved plan does not fetch it again.
    if (effect.type === "acquire-tile" && request.purpose === "probe") {
      log("debug", "effect-fetch", `type=${effect.type} request=${request.id} purpose=probe route=probe`);
      try {
        const size = await deps.probeSize(request.uri, headerRecord(request.headers));
        if (cancelled) return;
        const probeOutput = (effect.placement as { probe_output?: unknown } | undefined)?.probe_output === true;
        if (size.ok && probeOutput && typeof effect.tile === "number" && effect.placement) {
          if (size.bytes) {
            await deps.assembly.acquireTile(effect.tile, effect.placement, size.bytes);
          } else if (size.image) {
            deps.assembly.acquireDisplayTile(effect.tile, effect.placement, size.image);
          } else {
            // An available probe-and-output observation must be retainable;
            // otherwise the core would correctly skip a tile the host lost.
            size.ok = false;
            size.width = 0;
            size.height = 0;
          }
        }
        log("debug", "effect-outcome", `type=${effect.type} request=${request.id} probe-ok=${size.ok} size=${size.width}x${size.height}`);
        if (!cancelled) {
          sendToEngine({ type: "engine.probe", requestId: request.id, ok: size.ok, width: size.width, height: size.height });
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
        if (!cancelled) sendToEngine({ type: "engine.failure", requestId: request.id, error: failure });
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
      && typeof effect.tile === "number"
      && effect.placement
      && deps.loadDisplayImage
      && typeof request.uri === "string"
      && request.uri !== ""
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
      const fetch = originOwner && deps.fetchResourceOnce ? deps.fetchResourceOnce : deps.fetchResource;
      const result = await fetch(effect);
      if (cancelled) return;
      log("debug", "effect-outcome", `type=${effect.type} request=${request.id} bytes=${result.bytes.byteLength}`);
      if (effect.type === "acquire-tile" && typeof effect.tile === "number" && effect.placement) {
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
      if (!cancelled) sendToEngine({ type: "engine.failure", requestId: request.id, error: failure });
    }
  }

  /**
   * Build the protocol `ErrorDto` for a failed awaited output operation.
   * The engine records typed success or failure, never rendered text.
   */
  function finalizationError(error: unknown): Record<string, unknown> {
    const failure = deps.classifyFailure(error);
    const code = typeof failure.code === "string" && failure.code !== "" ? failure.code : "output.failed";
    const message =
      error !== null && typeof error === "object" && typeof (error as { message?: unknown }).message === "string"
        ? String((error as { message?: unknown }).message)
        : "The image could not be saved.";
    return {
      code,
      phase: "output",
      retryable: failure.retryable === true,
      message,
    };
  }

  /**
   * Ordered lifecycle effects. Any executor failure is terminal for this
   * host: the failure is rendered and the engine job is cancelled so no
   * effect is silently skipped or faked.
   */
  async function runLifecycle(envelope: EngineHostEffect) {
    switch (envelope.type) {
      case "finalize-output":
        try {
          await deps.assembly.finalizeOutput(
            envelope.partial === true,
            String(envelope.format),
            envelope.canvas ?? null,
          );
        } catch (error) {
          sendToEngine({
            type: "engine.command",
            command: { type: "finalization-failed", error: finalizationError(error) },
          });
          return;
        }
        sendToEngine({ type: "engine.command", command: { type: "finalization-succeeded" } });
        return;
      case "request-decision":
        deps.onRecoveryRequested(Number(envelope.generation));
        return;
      default:
        log("warn", "unsupported-effect", `type=${envelope.type}`);
        deps.onUnsupportedEffect(envelope);
        return;
    }
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

  function handleEngineMessages(messages: unknown[]) {
    for (const envelope of messages) {
      if (!envelope || typeof envelope !== "object") continue;
      const message = envelope as EngineHostEffect;
      if (message.kind !== "effect" && message.kind !== "event") continue;
      if (message.kind === "effect") {
        log("debug", "effect-received", `type=${message.type}${message.tile !== undefined ? ` tile=${message.tile}` : ""}`);
        if (message.type === "acquire-resource" || message.type === "acquire-tile") void acquire(message);
        else if (message.type === "cancel-work") {
          deps.cancelFetch();
          deps.assembly.release();
        } else enqueue(() => runLifecycle(message));
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
    start(inputUrl: string) {
      sendToEngine({
        type: "engine.start",
        jobId: deps.jobId(),
        inputUrl,
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
          sendToEngine({ type: "engine.failure", requestId: id, error: failure });
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
