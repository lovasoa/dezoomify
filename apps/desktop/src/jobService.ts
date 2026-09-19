// Desktop job service: typed JobService over the public Tauri API.
// Uses `@tauri-apps/api/core` invoke and `@tauri-apps/api/event` listen
// only (never host-injected globals, never validation-only fallbacks: with
// no host the service reports typed host-unavailable errors and tests inject
// explicit doubles). One service owns many window-owned jobs; each job gets
// a per-job snapshot channel backed by the shared snapshot store.
//
// Command routing against the shipped shell (DESKTOP_COMMANDS):
// cancel -> cancel_job; image/level/recovery choices -> answer_choice with
// the shell's typed choice shapes (single source here); pause/resume and
// engine-internal commands have no shell command yet and reject with
// desktop.unsupported-command until the typed native IPC lands.
//
// Event projection is explicit and total: each payload maps by its channel
// plus kind/state fields to one generated JobEvent, or is ignored. No
// substring matching on display text. Payload shapes are imported from
// events.ts (canonical); destination formats from desktopIntegration.ts.
// Native payloads carry data the shared fold cannot know (output geometry,
// partial ledgers, sibling basenames); the service enriches the folded
// snapshot with it before publishing, so the snapshot stays the single
// source of truth the UI renders.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  ErrorDto,
  HostStatus,
  JobEvent,
  JobHandle,
  JobObserver,
  JobService,
  JobSnapshot,
  JobStartRequest,
  UserCommand,
} from "@dezoomify/app-model";
import {
  applyJobEvent,
  createSnapshotStore,
  initialSnapshot,
  type SnapshotStore,
} from "@dezoomify/app-model";
import {
  DESKTOP_EVENT_CHANNELS,
  eventJobId,
  eventSeq,
  type DesktopEventChannel,
} from "./events.ts";
import { DESKTOP_COMMANDS, NATIVE_FORMATS } from "./desktopIntegration.ts";

// Keep erasable syntax only so node type-stripping can read this file.

// Typed desktop choice shapes sent to the shell `answer_choice` command.
// Structured end to end: these objects decode to the shell `Choice` enum
// directly; no string parsing is involved.
export type AnswerChoice =
  | { kind: "image"; index: number }
  | { kind: "level"; index: number }
  | { kind: "partial"; keep: boolean }
  | { kind: "retry" };

export interface DesktopIpc {
  invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown>;
  listen(
    channel: string,
    handler: (event: { payload: unknown }) => void,
  ): Promise<unknown>;
}

export interface DesktopJobServiceDeps {
  ipc?: DesktopIpc;
  store?: SnapshotStore;
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

function serviceError(code: string, message: string): ErrorDto {
  return { code, phase: "validation", retryable: false, message, recovery: [] };
}

function strField(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function numField(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function stringList(record: Record<string, unknown>, keys: string[]): string[] {
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) {
      return value.filter((item): item is string => typeof item === "string" && item !== "");
    }
  }
  return [];
}

const VALID_PHASES = new Set([
  "handshake",
  "validation",
  "discovery",
  "acquisition",
  "decode",
  "processing",
  "output",
  "publication",
  "cleanup",
]);

type ErrorPhaseName =
  | "handshake"
  | "validation"
  | "discovery"
  | "acquisition"
  | "decode"
  | "processing"
  | "output"
  | "publication"
  | "cleanup";

function phaseOf(payload: Record<string, unknown>): ErrorPhaseName {
  const phase = strField(payload, ["phase"]);
  if (phase && VALID_PHASES.has(phase)) return phase as ErrorPhaseName;
  return "acquisition";
}

function flatKind(payload: Record<string, unknown>): string {
  const kind = strField(payload, ["kind"]) ?? "";
  return kind.toLowerCase().replace(/[-_]/g, "");
}

function stateOf(payload: Record<string, unknown>): string {
  return (strField(payload, ["state"]) ?? "").toLowerCase().replace(/[-_]/g, "");
}

/** Typed recovery actions for each native recovery family. */
const PARTIAL_ACTIONS = [
  { id: "keep-partial", kind: "keep-partial", scope: "job", rationale: "kept-partial" },
  { id: "discard-partial", kind: "discard-partial", scope: "job", rationale: "fail-closed" },
  { id: "retry", kind: "retry", scope: "tile", rationale: "transient" },
] as const;

const DESTINATION_ACTIONS = [
  { id: "choose-output", kind: "choose-output", scope: "job", rationale: "output-denied" },
  { id: "retry", kind: "retry", scope: "job", rationale: "transient" },
] as const;

/** Shell state names that map onto one engine job state. */
const SHELL_STATE_TABLE: Record<string, JobEvent> = {
  created: { type: "job-state", state: "Created" },
  discovering: { type: "job-state", state: "Discovering" },
  awaitingimageselection: { type: "job-state", state: "AwaitingImageSelection" },
  awaitinglevelselection: { type: "job-state", state: "AwaitingLevelSelection" },
  planning: { type: "job-state", state: "Planning" },
  running: { type: "job-state", state: "AcquiringTiles" },
  acquiring: { type: "job-state", state: "AcquiringTiles" },
  acquiringtiles: { type: "job-state", state: "AcquiringTiles" },
  processing: { type: "job-state", state: "AcquiringTiles" },
  encoding: { type: "job-state", state: "Finalizing" },
  finalizing: { type: "job-state", state: "Finalizing" },
  cancelling: { type: "job-state", state: "Cancelling" },
  cleaningup: { type: "job-state", state: "Cancelling" },
  awaitingpartialdecision: { type: "job-state", state: "AwaitingPartialDecision" },
};

/**
 * Fold one self-describing `job-snapshot` payload into generated events.
 * The shell already folded the runner snapshot into the record; the emit
 * carries lifecycle, counts, the recovery ledger, and the terminal, so no
 * payload parsing beyond typed fields is involved.
 */
export function foldSnapshotPayload(
  payload: Record<string, unknown>,
): JobEvent[] {
  const out: JobEvent[] = [];
  const lifecycle = stateOf(payload);
  const stateEvent = SHELL_STATE_TABLE[lifecycle];
  if (stateEvent) out.push(stateEvent);
  const acquired = numField(payload, ["acquired"]);
  const total = numField(payload, ["total"]);
  if (typeof acquired === "number" && typeof total === "number") {
    out.push({ type: "progress", acquired, total });
  }
  const recovery = payload["recovery"];
  if (recovery && typeof recovery === "object") {
    const table = recovery as Record<string, unknown>;
    const generation = eventSeq(payload) ?? 0;
    const reason = strField(payload, ["reason"]);
    const actions = reason === "destination" ? DESTINATION_ACTIONS : PARTIAL_ACTIONS;
    out.push({
      type: "recovery-request",
      generation,
      actions: actions.map((action) => ({ ...action })),
    });
  }
  const terminal = strField(payload, ["terminal"]);
  const terminalKind = terminal ? terminal.toLowerCase().replace(/[-_]/g, "") : "";
  if (terminalKind === "completed") {
    out.push({ type: "completed" });
  } else if (terminalKind === "partialcompleted") {
    out.push({ type: "partial-completed" });
  } else if (terminalKind === "cancelled") {
    out.push({ type: "cancelled" });
  } else if (terminalKind === "failed") {
    const code = strField(payload, ["code"]) ?? "desktop.job-failed";
    const message = strField(payload, ["message"]) ?? "The desktop job failed.";
    const retryable = payload["retryable"] === true;
    out.push({
      type: "failed",
      error: {
        code,
        phase: phaseOf(payload),
        retryable,
        message,
        recovery: [],
        transport: "native",
      },
    });
  }
  return out;
}

/**
 * Project one shell payload to one generated JobEvent. Returns null for
 * payloads that carry no engine event (grants, heartbeats, unknown kinds):
 * the snapshot stays put instead of moving on display text.
 */
export function projectDesktopEvent(
  channel: DesktopEventChannel,
  payload: Record<string, unknown>,
): JobEvent | null {
  const kind = flatKind(payload);
  const state = stateOf(payload);

  if (channel === "dezoomify://deep-link-pending") return null;

  if (
    channel === "dezoomify://job-progress" ||
    kind === "progress" ||
    kind === "downloading" ||
    kind === "discovery" ||
    kind === "encoding"
  ) {
    const acquired = numField(payload, ["acquired"]);
    const total = numField(payload, ["total"]);
    if (typeof acquired === "number" && typeof total === "number") {
      return { type: "progress", acquired, total };
    }
    return null;
  }

  if (
    channel === "dezoomify://job-output" ||
    kind === "completed" ||
    kind === "partialcompleted" ||
    kind === "output"
  ) {
    if (kind === "partialcompleted" || state === "partiallycompleted") {
      return { type: "partial-completed" };
    }
    return { type: "completed" };
  }

  if (channel === "dezoomify://job-error" || kind === "failed" || kind === "error") {
    const code = strField(payload, ["code"]) ?? "desktop.job-failed";
    const message = strField(payload, ["message"]) ?? "The desktop job failed.";
    const retryable = payload["retryable"] === true;
    const transportRaw = strField(payload, ["transport"]);
    const transport =
      transportRaw === "direct" ||
      transportRaw === "metadata-proxy" ||
      transportRaw === "browser-session" ||
      transportRaw === "native" ||
      transportRaw === "display-only"
        ? transportRaw
        : "native";
    return {
      type: "failed",
      error: {
        code,
        phase: phaseOf(payload),
        retryable,
        message,
        recovery: [],
        transport,
      },
    };
  }

  if (kind === "cancelled") return { type: "cancelled" };
  if (kind === "paused") return { type: "paused" };
  if (kind === "resumed") return { type: "resumed" };

  // Recovery requests: partial decisions offer keep/discard/retry; the
  // destination cue (any event reporting the AwaitingDestination shell
  // state) offers choose-output. The reason field is typed, never display
  // text.
  if (
    kind === "recoveryrequested" ||
    kind === "requestdecision" ||
    kind === "awaitingrecovery" ||
    kind === "awaitingpartialdecision" ||
    kind === "awaitingpartial"
  ) {
    const generation = eventSeq(payload) ?? 0;
    const reason = strField(payload, ["reason"]);
    const actions = reason === "destination" ? DESTINATION_ACTIONS : PARTIAL_ACTIONS;
    return {
      type: "recovery-request",
      generation,
      actions: actions.map((action) => ({ ...action })),
    };
  }
  if (state === "awaitingdestination") {
    const generation = eventSeq(payload) ?? 0;
    return {
      type: "recovery-request",
      generation,
      actions: DESTINATION_ACTIONS.map((action) => ({ ...action })),
    };
  }
  // A destination grant moves the job into active work: the driver plans
  // before the first tile flows.
  if (kind === "destination") {
    return { type: "job-state", state: "Planning" };
  }

  const stateEvent = SHELL_STATE_TABLE[state];
  return stateEvent ?? null;
}

/**
 * Fold the shell state riding a progress payload before the progress event:
 * the snapshot state must track Acquiring/Finalizing during downloads.
 */
function progressStateEvent(payload: Record<string, unknown>): JobEvent | null {
  const stateEvent = SHELL_STATE_TABLE[stateOf(payload)];
  return stateEvent ?? null;
}

/** Typed output details a native terminal payload carries beyond the fold. */
function enrichOutput(
  snapshot: JobSnapshot,
  payload: Record<string, unknown>,
): JobSnapshot {
  if (!snapshot.output) return snapshot;
  const width = numField(payload, ["width"]);
  const height = numField(payload, ["height"]);
  const format = strField(payload, ["format"]);
  const missing = stringList(payload, ["missingTiles", "missing"]);
  const siblingRaw = strField(payload, ["sibling"]);
  const sibling =
    typeof siblingRaw === "string" &&
    siblingRaw.length > 0 &&
    siblingRaw.length <= 256 &&
    siblingRaw.indexOf("/") < 0 &&
    siblingRaw.indexOf("\\") < 0
      ? siblingRaw
      : undefined;
  return {
    ...snapshot,
    output: {
      ...snapshot.output,
      ...(typeof width === "number" && width > 0 ? { width } : {}),
      ...(typeof height === "number" && height > 0 ? { height } : {}),
      ...(format ? { format } : {}),
      ...(missing.length > 0 ? { missingTiles: missing } : {}),
      ...(sibling ? { siblingName: sibling } : {}),
    },
  };
}

/** Typed partial-ledger details a native recovery payload carries. */
function enrichRecovery(
  snapshot: JobSnapshot,
  payload: Record<string, unknown>,
): JobSnapshot {
  if (!snapshot.recovery) return snapshot;
  const missing = stringList(payload, ["missingTiles", "missing"]);
  const failed = numField(payload, ["failed", "failedRequests", "failures"]);
  const total = numField(payload, ["total", "tiles", "tileCount"]);
  return {
    ...snapshot,
    recovery: {
      ...snapshot.recovery,
      ...(missing.length > 0 ? { missing } : {}),
      ...(typeof failed === "number" ? { failed } : {}),
      ...(typeof total === "number" ? { total } : {}),
    },
  };
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

interface TrackedJob {
  nativeId: string;
  observer: JobObserver;
  current: JobSnapshot;
  seenSeq: number;
  settled: boolean;
}
export function createDesktopJobService(deps?: DesktopJobServiceDeps): DesktopJobService {
  const ipc = deps?.ipc ?? publicIpc();
  const store = deps?.store ?? createSnapshotStore();
  const now = deps?.now ?? Date.now;
  const settingsOf = deps?.settings;
  const onDeepLink = deps?.onDeepLink;
  const jobs = new Map<string, TrackedJob>();
  const unlistens: Array<() => void> = [];
  let listening = false;
  let listenFailed: unknown = null;

  function hostStatus(): HostStatus {
    return { transport: "native", permission: "granted", output: "writable" };
  }

  function route(channel: DesktopEventChannel, raw: unknown): void {
    if (channel === "dezoomify://deep-link-pending") {
      if (onDeepLink && raw && typeof raw === "object") {
        onDeepLink(raw as Record<string, unknown>);
      }
      return;
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
    const payload = raw as Record<string, unknown>;
    const id = eventJobId(payload);
    if (!id) return;
    const tracked = jobs.get(id);
    if (!tracked || tracked.settled) return;
    const remoteSeq = eventSeq(payload);
    if (remoteSeq !== null) {
      if (remoteSeq <= tracked.seenSeq) return;
      tracked.seenSeq = remoteSeq;
    }
    const events =
      channel === "dezoomify://job-snapshot"
        ? foldSnapshotPayload(payload)
        : (() => {
            const event = projectDesktopEvent(channel, payload);
            return event ? [event] : [];
          })();
    if (events.length === 0) return;
    let folded = tracked.current;
    for (const event of events) {
      // Progress payloads carry the live shell state alongside the counts;
      // fold it first so the snapshot state tracks the download.
      if (event.type === "progress") {
        const stateEvent = progressStateEvent(payload);
        if (stateEvent && stateEvent.type === "job-state" && stateEvent.state !== folded.state) {
          folded = applyJobEvent(folded, stateEvent, now());
        }
      }
      folded = applyJobEvent(folded, event, now());
      if (event.type === "completed" || event.type === "partial-completed") {
        folded = enrichOutput(folded, payload);
      } else if (event.type === "recovery-request") {
        folded = enrichRecovery(folded, payload);
      }
    }
    if (folded === tracked.current) return;
    tracked.current = folded;
    if (store.publish(folded)) tracked.observer.snapshot(folded);
    tracked.observer.hostStatus(hostStatus());
    if (folded.terminal !== null) tracked.settled = true;
  }

  async function ensureListening(): Promise<void> {
    if (listening || listenFailed) return;
    listening = true;
    for (const channel of DESKTOP_EVENT_CHANNELS) {
      const name = channel as DesktopEventChannel;
      try {
        const maybe = await ipc.listen(name, (event) => {
          try {
            route(name, event.payload);
          } catch {
            // One bad payload never breaks the channel.
          }
        });
        if (typeof maybe === "function") unlistens.push(maybe as () => void);
      } catch (error) {
        listenFailed = error;
        throw serviceError(
          "desktop.host-unavailable",
          "The desktop host is not reachable from this window.",
        );
      }
    }
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
    try {
      raw = await ipc.invoke("start_job", args);
    } catch (error) {
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
      throw serviceError("desktop.start-failed", "The desktop host returned no job.");
    }
    const id: string = nativeId;
    const current = initialSnapshot(id, now());
    store.publish(current);
    observer.snapshot(current);
    observer.hostStatus(hostStatus());
    const tracked: TrackedJob = { nativeId: id, observer, current, seenSeq: 0, settled: false };
    const existing = jobs.get(id);
    if (existing) existing.settled = true;
    jobs.set(id, tracked);

    async function command(command: UserCommand): Promise<void> {
      const live = jobs.get(id);
      if (!live || live.settled) {
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
      if (command.type === "recovery-choice") {
        const choice: AnswerChoice =
          command.choice === "retry"
            ? { kind: "retry" }
            : { kind: "partial", keep: command.choice === "keep" };
        await ipc.invoke("answer_choice", { job: id, choice });
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
      const live = jobs.get(id);
      if (live) live.settled = true;
      jobs.delete(id);
      store.remove(id);
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
    for (const id of [...jobs.keys()]) {
      const tracked = jobs.get(id);
      if (tracked) tracked.settled = true;
      jobs.delete(id);
      store.remove(id);
    }
    while (unlistens.length > 0) {
      const unlisten = unlistens.pop();
      try {
        (unlisten as () => void)();
      } catch {
        // Teardown best-effort.
      }
    }
    listening = false;
  }

  return { start, queryCapabilities, dispose };
}
