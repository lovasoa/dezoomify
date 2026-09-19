// Desktop integration: the desktop app implementation connecting the
// shared UI to its runtime and host capabilities.
//
// No imports from apps/web, apps/extension, browser-session fetch, or the
// metadata CORS proxy. The desktop app uses native effects only.

import { invoke as publicInvoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";

// Keep erasable syntax only so node type-stripping can read this file.

export const PROTOCOL_MIN = "2.0" as const;
export const PROTOCOL_MAX = "2.0" as const;
export const PROTOCOL_VERSION = "2.0" as const;
export const NATIVE_HOST_NAME = "dev.ophir.dezoomify.native_host" as const;
export const APP_IDENTIFIER = "dev.ophir.dezoomify" as const;

export const NATIVE_ENCODERS = ["png", "jpeg", "tiff", "zif", "webp"] as const;
export type NativeEncoder = (typeof NATIVE_ENCODERS)[number];

// Native output formats accepted by the save destination grant. File
// encoders plus the IIIF directory output exposed by the desktop picker.
export type NativeFormat = NativeEncoder | "iiif-dir";
export const NATIVE_FORMATS: readonly NativeFormat[] = [...NATIVE_ENCODERS, "iiif-dir"];
const SUPPORTED_SAVE_FORMATS: readonly NativeFormat[] = NATIVE_FORMATS;

// Exact Tauri command registry. Must match
// apps/desktop/src-tauri/src/commands.rs COMMANDS and the generated
// capability documents.
export const DESKTOP_COMMANDS = [
  "answer_choice",
  "cancel_job",
  "open_saved_output",
  "pause_job",
  "query_capabilities",
  "request_destination",
  "resume_job",
  "start_job",
] as const;

export type DesktopCommand = (typeof DESKTOP_COMMANDS)[number];

// The event channels are owned by apps/desktop/src/events.ts (the IPC
// redaction guards live there); this module re-exports the single registry
// so capability checks share one source without an import cycle.
export { DESKTOP_EVENT_CHANNELS } from "./events.ts";
export type { DesktopEventChannel } from "./events.ts";

export interface DesktopCapabilities {
  readonly nativeAvailable: true;
  readonly extensionAvailable: boolean;
  readonly browserCanSave: boolean;
  readonly proxyAllowed: false;
  readonly encoders: readonly string[];
  readonly protocolMin: string;
  readonly protocolMax: string;
  readonly bulkSupported: true;
}

export interface SaveRequest {
  readonly jobId: string;
  readonly suggestedName: string;
  readonly format: NativeFormat;
}

export type SaveOutcome = "granted" | "denied" | "cancelled";

export interface SaveResult {
  readonly outcome: SaveOutcome;
  readonly reason?: string;
  readonly code?: string;
}

export interface HandoffRequest {
  readonly sourceUrl: string;
  readonly provenanceLabel: string;
}

// Structural counterpart of the shared UI AppIntegration contract:
// capabilities, save behavior, external links, and handoff requests.
// Routing and component composition stay shared.
export interface AppIntegration {
  readonly kind: "desktop";
  getCapabilities(): DesktopCapabilities;
  requestSaveDestination(req: SaveRequest): Promise<SaveResult>;
  requestHandoff(handoff: HandoffRequest): Promise<{ accepted: boolean; reason: string }>;
  openExternalLink(url: string): Promise<{ opened: boolean; reason: string }>;
  describe(): string;
}

const SECRET_FRAGMENTS = [
  "cookie",
  "authorization",
  "bearer",
  "token",
  "signature",
  "sig",
  "auth",
  "key",
  "secret",
  "password",
  "session",
];

function hasUserinfo(urlString: string): boolean {
  try {
    const u = new URL(urlString);
    return u.username !== "" || u.password !== "";
  } catch {
    return true;
  }
}

function hasSecretQuery(urlString: string): boolean {
  try {
    const u = new URL(urlString);
    for (const k of u.searchParams.keys()) {
      if (SECRET_FRAGMENTS.includes(k.toLowerCase())) return true;
    }
    return false;
  } catch {
    return true;
  }
}

function isValidJobId(jobId: string): boolean {
  return jobId.startsWith("job:") && jobId.length > 4 && jobId.length <= 128;
}

function extensionFor(format: NativeFormat): string {
  if (format === "png") return ".png";
  if (format === "jpeg") return ".jpg";
  if (format === "iiif-dir") return ".iiif";
  if (format === "tiff") return ".tif";
  if (format === "zif") return ".zif";
  return ".webp";
}

// Tauri IPC access goes through the public guest binding only. Tests inject
// an explicit `invoke` double; the default calls the real host and reports
// typed denials when the host is unreachable. No host globals are read here.
export type DesktopInvoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

interface DestinationCommandResult {
  readonly outcome: SaveOutcome;
  readonly reason?: string;
  readonly code?: string;
}

export function createDesktopIntegration(opts?: {
  extensionAvailable?: boolean;
  invoke?: DesktopInvoke;
}): AppIntegration {
  const extensionAvailable = opts?.extensionAvailable ?? false;
  const invoke: DesktopInvoke =
    opts?.invoke ?? ((cmd, args) => publicInvoke(cmd, args));

  function getCapabilities(): DesktopCapabilities {
    return {
      nativeAvailable: true,
      extensionAvailable,
      browserCanSave: true,
      proxyAllowed: false,
      encoders: [...NATIVE_ENCODERS],
      protocolMin: PROTOCOL_MIN,
      protocolMax: PROTOCOL_MAX,
      // Todo 5.3: the desktop integration runs a sequential multi-job queue
      // (apps/desktop/src/queue.ts) over the single-job engine, so the queue
      // is always offered here. The engine still validates each queued
      // request on its own; the flag only gates the controls.
      bulkSupported: true,
    };
  }

  // Native save path: validate the request, then route through the real
  // Tauri command, which shows the native save dialog, grants the
  // destination through the validated dispatch, and reports completion only
  // after atomic output finalization. Unreachable hosts report a typed
  // denial; validation runs before any IPC.
  async function requestSaveDestination(req: SaveRequest): Promise<SaveResult> {
    if (!isValidJobId(req.jobId)) {
      return { outcome: "denied", reason: "invalid-job-id" };
    }
    if (!SUPPORTED_SAVE_FORMATS.includes(req.format)) {
      return { outcome: "denied", reason: "unsupported-format" };
    }
    const wanted = extensionFor(req.format);
    if (!req.suggestedName.toLowerCase().endsWith(wanted)) {
      return { outcome: "denied", reason: "invalid-extension" };
    }
    if (req.suggestedName.includes("\0") || req.suggestedName.includes("..")) {
      return { outcome: "denied", reason: "invalid-path" };
    }
    try {
      const raw = (await invoke("request_destination", {
        job: req.jobId,
        format: req.format,
        suggestedName: req.suggestedName,
      })) as DestinationCommandResult | null;
      if (!raw || typeof raw !== "object") {
        return { outcome: "denied", reason: "destination-failed" };
      }
      if (raw.outcome === "granted") {
        return { outcome: "granted" };
      }
      if (raw.outcome === "cancelled") {
        return {
          outcome: "cancelled",
          reason: typeof raw.reason === "string" ? raw.reason : "user-cancelled",
        };
      }
      if (raw.outcome === "denied") {
        return {
          outcome: "denied",
          reason: typeof raw.reason === "string" ? raw.reason : "destination-denied",
          ...(typeof raw.code === "string" && raw.code.length > 0 ? { code: raw.code } : {}),
        };
      }
      return { outcome: "denied", reason: "destination-failed" };
    } catch (error) {
      return {
        outcome: "denied",
        reason: error instanceof Error ? error.message : "destination-failed",
      };
    }
  }

  // Handoff request validation: bounded non-secret source only, returning
  // pending-confirmation. The caller must confirm before starting work;
  // this function never starts work here.
  async function requestHandoff(
    handoff: HandoffRequest,
  ): Promise<{ accepted: boolean; reason: string }> {
    const src = handoff.sourceUrl;
    if (typeof src !== "string" || src.length === 0 || src.length > 2048) {
      return { accepted: false, reason: "handoff.rejected:oversize" };
    }
    let u: URL;
    try {
      u = new URL(src);
    } catch {
      return { accepted: false, reason: "handoff.rejected:invalid-url" };
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") {
      return { accepted: false, reason: "handoff.rejected:scheme" };
    }
    if (hasUserinfo(src)) {
      return { accepted: false, reason: "handoff.rejected:userinfo" };
    }
    if (hasSecretQuery(src)) {
      return { accepted: false, reason: "handoff.rejected:secret-query" };
    }
    const lower = src.toLowerCase();
    for (const needle of ["cookie", "authorization", "bearer", "file://", "/etc/", "c:\\"]) {
      if (lower.includes(needle)) {
        return { accepted: false, reason: `handoff.rejected:${needle}` };
      }
    }
    return { accepted: true, reason: "pending-confirmation" };
  }

  // Only explicit https links leave the app, through the opener plugin.
  // No remote content navigates inside the privileged window. Validation
  // runs first; the Tauri opener is invoked only for valid https URLs and
  // opened:true is returned only on invoke success.
  async function openExternalLink(url: string): Promise<{ opened: boolean; reason: string }> {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return { opened: false, reason: "invalid-url" };
    }
    if (u.protocol !== "https:") {
      return { opened: false, reason: "scheme-denied" };
    }
    if (u.username !== "" || u.password !== "") {
      return { opened: false, reason: "userinfo-denied" };
    }
    // Use the official guest binding rather than hand-written plugin IPC.
    // It targets the registered opener plugin while the capability document
    // grants `opener:allow-open-url` for this window. Failures (including an
    // unreachable host) report a typed denial.
    try {
      await openUrl(url);
      return { opened: true, reason: "external" };
    } catch (error) {
      return {
        opened: false,
        reason: error instanceof Error ? error.message : "open-failed",
      };
    }
  }

  function describe(): string {
    return `desktop native=${String(getCapabilities().nativeAvailable)} protocol=${PROTOCOL_MIN}`;
  }

  return { kind: "desktop", getCapabilities, requestSaveDestination, requestHandoff, openExternalLink, describe };
}
