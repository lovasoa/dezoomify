// Desktop job service: typed JobService over the public Tauri API.
// Uses `@tauri-apps/api/core` invoke and `@tauri-apps/api/event` listen
// only (never host-injected globals, never validation-only fallbacks: with
// no host the service reports typed host-unavailable errors and tests inject
// explicit doubles). One service owns many window-owned jobs; each job is an
// observer entry keyed by its snapshot identity.
//
// Snapshot-only transport: the shell emits `dezoomify://job-snapshot`
// `EngineSnapshotDto` payloads verbatim from the runner (revision,
// lifecycle, paused, progress, selection with catalog, decision, terminal,
// output). The service forwards each canonical snapshot directly to its
// observer: no channel/kind fold, no seq guard, no settled mirror.
// Exactly-once terminals, monotonic progress, honest partials, typed
// failure codes, and redaction are the shell's contract; the frontend
// never refolds them.
//
// Command routing against the shipped shell (DESKTOP_COMMANDS):
// cancel -> cancel_job; pause/resume -> pause_job/resume_job;
// image/level/partial choices -> answer_choice with the shell's typed
// choice shapes (single source here, partial carrying generation+choice).
// Remaining engine-internal commands have no shell command and reject
// with desktop.unsupported-command.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  JobHandle,
  JobObserver,
  JobService,
  JobSnapshot,
  JobStartRequest,
  UserCommand,
} from "@dezoomify/app-model";
import {
  DESKTOP_EVENT_CHANNELS,
  assertNoTileBytes,
  eventJobId,
  type DesktopEventChannel,
} from "./events.ts";
import { DESKTOP_COMMANDS, NATIVE_FORMATS } from "./desktopIntegration.ts";

// Keep erasable syntax only so node type-stripping can read this file.

// Typed desktop choice shapes sent to the shell `answer_choice` command.
// Selection shapes are pre-start options; the partial shape carries the
// decision generation plus the keep/retry/discard choice verbatim.
// Structured end to end: these objects decode to the shell `Choice` enum
// directly; no string parsing is involved.
export type AnswerChoice =
  | { kind: "image"; index: number }
  | { kind: "level"; index: number }
  | { kind: "partial"; generation: number; decision: "keep" | "retry" | "discard" };

export interface DesktopIpc {
  invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown>;
  listen(
    channel: string,
    handler: (event: { payload: unknown }) => void,
  ): Promise<unknown>;
}

export interface DesktopJobServiceDeps {
  ipc?: DesktopIpc;
  now?: () => number;
  /** Extra start_job settings (output preferences); default omits the key. */
  settings?: () => Record<string, unknown>;
  /** Product-level deep-link confirmations stay in the product shell. */
  onDeepLink?: (payload: Record<string, unknown>) => void;
}

export interface DesktopCapabilities {
  protocolMin: string;
  protocolMax: string;
  commands: string[];
}

export interface DestinationRequest {
  format: string;
  suggestedName: string;
}

export type DestinationOutcome = "granted" | "denied" | "cancelled";

export interface DestinationResult {
  outcome: DestinationOutcome;
  reason?: string;
  code?: string;
}

function publicIpc(): DesktopIpc {
  return {
    invoke: (cmd, args) => invoke(cmd, args),
    listen: (channel, handler) => listen(channel, handler),
  };
}

function serviceError(code: string, message: string): { code: string; message: string } {
  return { code, message };
}

function extensionFor(format: string): string | null {
  if (format === "png") return ".png";
  if (format === "jpeg") return ".jpg";
  if (format === "iiif-dir") return ".iiif";
  if (format === "tiff") return ".tif";
  if (format === "zif") return ".zif";
  if (format === "webp") return ".webp";
  return null;
}

export interface DesktopJobHandle extends JobHandle {
  /** Ask the shell for a save destination; resolves the grant dialog. */
  requestDestination(req: DestinationRequest): Promise<DestinationResult>;
  /** Open the saved output (or reveal it) through the retained job ref. */
  openOutput(reveal: boolean): Promise<void>;
}

export interface DesktopJobService extends JobService {
  start(request: JobStartRequest, observer: JobObserver): Promise<DesktopJobHandle>;
  queryCapabilities(): Promise<DesktopCapabilities>;
  dispose(): Promise<void>;
}

interface TrackedObserver {
  nativeId: string;
  observer: JobObserver;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

// Closed engine lifecycles (the `JobState` union): anything else is not a
// canonical snapshot and is dropped at the boundary.
const ENGINE_LIFECYCLES = new Set([
  "Created",
  "Discovering",
  "AwaitingImageSelection",
  "AwaitingLevelSelection",
  "Planning",
  "AcquiringTiles",
  "AwaitingPartialDecision",
  "Finalizing",
  "Cancelling",
  "Completed",
  "PartiallyCompleted",
  "Failed",
  "Cancelled",
]);

// Closed terminal outcomes (the `SnapshotTerminalDto` type tag).
const TERMINAL_TYPES = new Set(["completed", "partial-completed", "failed", "cancelled"]);

/** Canonical DTO guard: revision/lifecycle/progress/selection are required;
 * decision/terminal/output ride only in their generated shapes. Legacy
 * folded payloads (state/acquired/recovery/terminal.kind/...) fail here
 * and never reach an observer. */
function isSnapshotPayload(value: unknown): value is JobSnapshot {
  if (!isRecord(value)) return false;
  if (typeof value["revision"] !== "number") return false;
  const lifecycle = value["lifecycle"];
  if (typeof lifecycle !== "string" || !ENGINE_LIFECYCLES.has(lifecycle)) return false;
  if (value["paused"] !== undefined && typeof value["paused"] !== "boolean") return false;
  const progress = value["progress"];
  if (!isRecord(progress) || typeof progress["completed"] !== "number") return false;
  const total = progress["total"];
  if (total !== undefined && total !== null && typeof total !== "number") return false;
  const selection = value["selection"];
  if (!isRecord(selection)) return false;
  if (typeof selection["level_count"] !== "number") return false;
  if (!Array.isArray(selection["deferred"])) return false;
  const decision = value["decision"];
  if (decision !== undefined && decision !== null) {
    if (!isRecord(decision)) return false;
    if (typeof decision["generation"] !== "number") return false;
    if (!Array.isArray(decision["missing"])) return false;
  }
  const terminal = value["terminal"];
  if (terminal !== undefined && terminal !== null) {
    if (!isRecord(terminal)) return false;
    if (typeof terminal["type"] !== "string" || !TERMINAL_TYPES.has(terminal["type"])) return false;
    if (terminal["type"] === "failed" && !isRecord(terminal["error"])) return false;
  }
  const output = value["output"];
  if (output !== undefined && output !== null) {
    if (!isRecord(output)) return false;
    if (typeof output["complete"] !== "boolean") return false;
    if (!Array.isArray(output["missing"])) return false;
  }
  return true;
}

export function createDesktopJobService(deps?: DesktopJobServiceDeps): DesktopJobService {
  const ipc = deps?.ipc ?? publicIpc();
  const now = deps?.now ?? Date.now;
  const settingsOf = deps?.settings;
  const onDeepLink = deps?.onDeepLink;
  const observers = new Map<string, TrackedObserver>();
  // IPC events can arrive before start_job returns its routing identity.
  // Keep only the latest absolute snapshot until that identity is known.
  const startingSnapshots = new Map<string, JobSnapshot>();
  let pendingStarts = 0;
  const unlistens: Array<() => void> = [];
  let listening: Promise<void> | null = null;

  function hostStatus(): { transport: string; permission: string; output: string } {
    return { transport: "native", permission: "granted", output: "writable" };
  }

  function route(channel: DesktopEventChannel, raw: unknown): void {
    if (channel === "dezoomify://deep-link-pending") {
      if (onDeepLink && raw && typeof raw === "object") {
        onDeepLink(raw as Record<string, unknown>);
      }
      return;
    }
    if (channel !== "dezoomify://job-snapshot") return;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
    const payload = raw as Record<string, unknown>;
    const id = eventJobId(payload);
    if (!id) return;
    if (!isSnapshotPayload(payload)) return;
    try {
      assertNoTileBytes(payload);
    } catch {
      return;
    }
    const tracked = observers.get(id);
    if (!tracked) {
      if (pendingStarts > 0) startingSnapshots.set(id, payload);
      return;
    }
    // Verbatim forward: the snapshot is already authoritative (shell
    // guarantees exactly-once terminals, monotonic counts, honest
    // partials, typed codes, redacted context), so no fold, no seq guard,
    // and no settled mirror live here.
    tracked.observer.snapshot(payload as unknown as JobSnapshot);
    tracked.observer.hostStatus(hostStatus() as never);
  }

  function ensureListening(): Promise<void> {
    return listening ??= (async () => {
      try {
        for (const channel of DESKTOP_EVENT_CHANNELS) {
          const maybe = await ipc.listen(channel, (event) => {
            try {
              route(channel, event.payload);
            } catch {
              // One bad payload never breaks the channel.
            }
          });
          if (typeof maybe === "function") unlistens.push(maybe as () => void);
        }
      } catch {
        throw serviceError(
          "desktop.host-unavailable",
          "The desktop host is not reachable from this window.",
        );
      }
    })();
  }

  function validateStart(request: JobStartRequest): { url: string } {
    const raw = request.inputs?.[0]?.url;
    if (typeof raw !== "string" || raw.trim() === "" || raw.length > 2048) {
      throw serviceError("desktop.invalid-source", "The image address is not usable.");
    }
    let parsed: URL;
    try {
      parsed = new URL(raw.trim());
    } catch {
      throw serviceError("desktop.invalid-source", "The image address is not usable.");
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw serviceError("desktop.invalid-source", "Only http and https addresses can be saved.");
    }
    if (parsed.username !== "" || parsed.password !== "") {
      throw serviceError("desktop.invalid-source", "Addresses with sign-in details are rejected.");
    }
    if (request.exec?.kind !== "native") {
      throw serviceError("desktop.invalid-exec", "The desktop service runs native jobs only.");
    }
    const dest = request.exec.destination;
    if (!NATIVE_FORMATS.includes(dest.format as (typeof NATIVE_FORMATS)[number])) {
      throw serviceError("desktop.invalid-destination", "The output format is not supported.");
    }
    const wanted = extensionFor(dest.format);
    if (!wanted || !dest.suggestedName.toLowerCase().endsWith(wanted)) {
      throw serviceError("desktop.invalid-destination", "The file name does not match its format.");
    }
    return { url: raw.trim() };
  }

  async function start(request: JobStartRequest, observer: JobObserver): Promise<DesktopJobHandle> {
    const { url } = validateStart(request);
    await ensureListening();
    const args: Record<string, unknown> = { inputUrl: url };
    if (settingsOf) args["settings"] = settingsOf();
    let raw: unknown;
    pendingStarts += 1;
    try {
      raw = await ipc.invoke("start_job", args);
    } catch (error) {
      pendingStarts -= 1;
      if (pendingStarts === 0) startingSnapshots.clear();
      throw serviceError(
        "desktop.start-failed",
        error instanceof Error ? error.message : "The desktop job could not start.",
      );
    }
    const nativeId =
      raw && typeof raw === "object" && typeof (raw as Record<string, unknown>)["job"] === "string"
        ? ((raw as Record<string, unknown>)["job"] as string)
        : null;
    if (!nativeId) {
      pendingStarts -= 1;
      if (pendingStarts === 0) startingSnapshots.clear();
      throw serviceError("desktop.start-failed", "The desktop host returned no job.");
    }
    const id: string = nativeId;
    const existing = observers.get(id);
    if (existing) observers.delete(id);
    observers.set(id, { nativeId: id, observer });
    const startingSnapshot = startingSnapshots.get(id);
    startingSnapshots.delete(id);
    pendingStarts -= 1;
    if (pendingStarts === 0) startingSnapshots.clear();
    if (startingSnapshot) observer.snapshot(startingSnapshot);
    observer.hostStatus(hostStatus() as never);

    async function command(command: UserCommand): Promise<void> {
      const live = observers.get(id);
      if (!live) {
        throw serviceError("desktop.job-settled", "The job already finished.");
      }
      if (command.type === "cancel") {
        await ipc.invoke("cancel_job", { job: id });
        return;
      }
      if (command.type === "select-image") {
        const choice: AnswerChoice = { kind: "image", index: command.image };
        await ipc.invoke("answer_choice", { job: id, choice });
        return;
      }
      if (command.type === "select-level") {
        const choice: AnswerChoice = { kind: "level", index: command.level };
        await ipc.invoke("answer_choice", { job: id, choice });
        return;
      }
      if (command.type === "answer-partial") {
        const choice: AnswerChoice = {
          kind: "partial",
          generation: command.generation,
          decision: command.decision,
        };
        await ipc.invoke("answer_choice", { job: id, choice });
        return;
      }
      if (command.type === "pause") {
        try {
          await ipc.invoke("pause_job", { job: id });
        } catch (error) {
          throw serviceError(
            "desktop.pause-failed",
            error instanceof Error ? error.message : "The pause request was rejected.",
          );
        }
        return;
      }
      if (command.type === "resume") {
        try {
          await ipc.invoke("resume_job", { job: id });
        } catch (error) {
          throw serviceError(
            "desktop.resume-failed",
            error instanceof Error ? error.message : "The resume request was rejected.",
          );
        }
        return;
      }
      throw serviceError(
        "desktop.unsupported-command",
        `The desktop host has no command for ${command.type} yet.`,
      );
    }

    async function requestDestination(req: DestinationRequest): Promise<DestinationResult> {
      if (!NATIVE_FORMATS.includes(req.format as (typeof NATIVE_FORMATS)[number])) {
        return { outcome: "denied", reason: "unsupported-format" };
      }
      const wanted = extensionFor(req.format);
      if (!wanted || !req.suggestedName.toLowerCase().endsWith(wanted)) {
        return { outcome: "denied", reason: "invalid-extension" };
      }
      if (req.suggestedName.includes("\0") || req.suggestedName.includes("..")) {
        return { outcome: "denied", reason: "invalid-path" };
      }
      let rawResult: unknown;
      try {
        rawResult = await ipc.invoke("request_destination", {
          job: id,
          format: req.format,
          suggestedName: req.suggestedName,
        });
      } catch (error) {
        return {
          outcome: "denied",
          reason: error instanceof Error ? error.message : "destination-failed",
        };
      }
      if (!rawResult || typeof rawResult !== "object") {
        return { outcome: "denied", reason: "destination-failed" };
      }
      const table = rawResult as Record<string, unknown>;
      if (table["outcome"] === "granted") return { outcome: "granted" };
      if (table["outcome"] === "cancelled") {
        return {
          outcome: "cancelled",
          reason: typeof table["reason"] === "string" ? table["reason"] : "user-cancelled",
        };
      }
      if (table["outcome"] === "denied") {
        const result: DestinationResult = {
          outcome: "denied",
          reason: typeof table["reason"] === "string" ? table["reason"] : "destination-denied",
        };
        if (typeof table["code"] === "string" && table["code"] !== "") result.code = table["code"];
        return result;
      }
      return { outcome: "denied", reason: "destination-failed" };
    }

    async function openOutput(reveal: boolean): Promise<void> {
      await ipc.invoke("open_saved_output", { job: id, reveal });
    }

    async function dispose(): Promise<void> {
      observers.delete(id);
    }

    return { id, command, dispose, requestDestination, openOutput };
  }

  async function queryCapabilities(): Promise<DesktopCapabilities> {
    let raw: unknown;
    try {
      raw = await ipc.invoke("query_capabilities");
    } catch (error) {
      throw serviceError(
        "desktop.host-unavailable",
        error instanceof Error ? error.message : "The desktop host is not reachable.",
      );
    }
    const table = (raw ?? {}) as Record<string, unknown>;
    const commands = Array.isArray(table["commands"])
      ? (table["commands"] as unknown[]).map((name) => String(name))
      : [];
    for (const name of commands) {
      if (!(DESKTOP_COMMANDS as readonly string[]).includes(name)) {
        throw serviceError("desktop.capability-mismatch", "The desktop host offers unknown commands.");
      }
    }
    return {
      protocolMin: typeof table["protocol_min"] === "string" ? table["protocol_min"] : "",
      protocolMax: typeof table["protocol_max"] === "string" ? table["protocol_max"] : "",
      commands,
    };
  }

  async function dispose(): Promise<void> {
    await listening?.catch(() => {});
    startingSnapshots.clear();
    for (const id of [...observers.keys()]) {
      observers.delete(id);
    }
    while (unlistens.length > 0) {
      const unlisten = unlistens.pop();
      try {
        (unlisten as () => void)();
      } catch {
        // Teardown best-effort.
      }
    }
    listening = null;
  }

  return { start, queryCapabilities, dispose };
}
