// Desktop job service: typed JobService over the public Tauri API.
// Uses `@tauri-apps/api/core` invoke and `@tauri-apps/api/event` listen
// only (never host-injected globals, never validation-only fallbacks: with
// no host the service reports typed host-unavailable errors and tests inject
// explicit doubles). One service owns many window-owned jobs; each job is an
// observer entry keyed by its snapshot identity.
//
// Snapshot-only transport: the shell emits `dezoomify://job-snapshot`
// `{ job, snapshot }` payloads with the runner's `EngineSnapshotDto` verbatim (revision,
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

import type {
  JobHandle,
  JobObserver,
  JobService,
  JobSnapshot,
  JobStartRequest,
  UserCommand,
} from "@dezoomify/app-model";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { DESKTOP_COMMANDS, NATIVE_FORMATS } from "./desktopIntegration.ts";
import {
  assertNoTileBytes,
  DESKTOP_EVENT_CHANNELS,
  type DesktopEventChannel,
  type JobSnapshotPayload,
} from "./events.ts";

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
  listen(channel: string, handler: (event: { payload: unknown }) => void): Promise<unknown>;
}

export interface DesktopJobServiceDeps {
  ipc?: DesktopIpc;
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
  /** Open the saved output (or reveal it) through the retained job ref. */
  openOutput(reveal: boolean): Promise<void>;
}

export interface DesktopJobService extends JobService {
  start(request: JobStartRequest, observer: JobObserver): Promise<DesktopJobHandle>;
  queryCapabilities(): Promise<DesktopCapabilities>;
  dispose(): Promise<void>;
}

interface TrackedObserver {
  observer: JobObserver;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function createDesktopJobService(deps?: DesktopJobServiceDeps): DesktopJobService {
  const ipc = deps?.ipc ?? publicIpc();
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
    if (!isRecord(raw) || typeof raw.job !== "string" || !isRecord(raw.snapshot)) return;
    const payload = raw as unknown as JobSnapshotPayload;
    const id = payload.job;
    try {
      assertNoTileBytes(payload);
    } catch {
      return;
    }
    const tracked = observers.get(id);
    if (!tracked) {
      if (pendingStarts > 0) startingSnapshots.set(id, payload.snapshot);
      return;
    }
    // Verbatim forward: the snapshot is already authoritative (shell
    // guarantees exactly-once terminals, monotonic counts, honest
    // partials, typed codes, redacted context), so no fold, no seq guard,
    // and no settled mirror live here.
    tracked.observer.snapshot(payload.snapshot);
    tracked.observer.hostStatus(hostStatus() as never);
  }

  function ensureListening(): Promise<void> {
    if (listening) return listening;
    listening = (async () => {
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
    return listening;
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
    observers.set(id, { observer });
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

    async function openOutput(reveal: boolean): Promise<void> {
      await ipc.invoke("open_saved_output", { job: id, reveal });
    }

    async function dispose(): Promise<void> {
      observers.delete(id);
    }

    return { id, command, dispose, openOutput };
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
        throw serviceError(
          "desktop.capability-mismatch",
          "The desktop host offers unknown commands.",
        );
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
