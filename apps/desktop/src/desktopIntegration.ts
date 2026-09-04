// Desktop integration: the desktop app implementation connecting the
// shared UI to its runtime and host capabilities.
//
// No imports from apps/web, apps/extension, browser-session fetch, or the
// metadata CORS proxy. The desktop app uses native effects only.

// Keep erasable syntax only so node type-stripping can read this file.

export const PROTOCOL_MIN = "1.0" as const;
export const PROTOCOL_MAX = "1.0" as const;
export const PROTOCOL_VERSION = "1.0" as const;
export const NATIVE_HOST_NAME = "com.dezoomify.native_host" as const;
export const APP_IDENTIFIER = "com.dezoomify.app" as const;

export const NATIVE_ENCODERS = ["png", "jpeg", "tiff"] as const;
export type NativeEncoder = (typeof NATIVE_ENCODERS)[number];

// Exact Tauri command registry. Must match
// apps/desktop/src-tauri/src/commands.rs COMMANDS and the generated
// capability documents.
export const DESKTOP_COMMANDS = [
  "answer_choice",
  "cancel_job",
  "query_capabilities",
  "request_destination",
  "start_job",
] as const;

export type DesktopCommand = (typeof DESKTOP_COMMANDS)[number];

// Must match apps/desktop/src/events.ts DESKTOP_EVENT_CHANNELS.
export const DESKTOP_EVENT_CHANNELS = [
  "dezoomify://job-state",
  "dezoomify://job-progress",
  "dezoomify://job-output",
  "dezoomify://job-error",
  "dezoomify://deep-link-pending",
] as const;

export type DesktopEventChannel = (typeof DESKTOP_EVENT_CHANNELS)[number];

export interface DesktopCapabilities {
  readonly nativeAvailable: true;
  readonly extensionAvailable: boolean;
  readonly browserCanSave: boolean;
  readonly proxyAllowed: false;
  readonly encoders: readonly string[];
  readonly protocolMin: string;
  readonly protocolMax: string;
}

export interface SaveRequest {
  readonly jobId: string;
  readonly suggestedName: string;
  readonly format: NativeEncoder;
}

export type SaveOutcome = "granted" | "denied" | "cancelled";

export interface SaveResult {
  readonly outcome: SaveOutcome;
  readonly destinationId?: string;
  readonly reason?: string;
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

function extensionFor(format: NativeEncoder): string {
  if (format === "png") return ".png";
  if (format === "jpeg") return ".jpg";
  return ".tif";
}

export function createDesktopIntegration(opts?: {
  extensionAvailable?: boolean;
}): AppIntegration {
  const extensionAvailable = opts?.extensionAvailable ?? false;

  function getCapabilities(): DesktopCapabilities {
    return {
      nativeAvailable: true,
      extensionAvailable,
      browserCanSave: true,
      proxyAllowed: false,
      encoders: [...NATIVE_ENCODERS],
      protocolMin: PROTOCOL_MIN,
      protocolMax: PROTOCOL_MAX,
    };
  }

  // Native dialog stub: validate format and file name, then grant an opaque
  // destination handle. The real app shows a native save dialog, passes the
  // chosen path to the native runtime, and reports completion only after
  // atomic output finalization.
  async function requestSaveDestination(req: SaveRequest): Promise<SaveResult> {
    if (!isValidJobId(req.jobId)) {
      return { outcome: "denied", reason: "invalid-job-id" };
    }
    if ((NATIVE_ENCODERS as readonly string[]).includes(req.format) === false) {
      return { outcome: "denied", reason: "unsupported-format" };
    }
    const wanted = extensionFor(req.format);
    if (!req.suggestedName.toLowerCase().endsWith(wanted)) {
      return { outcome: "denied", reason: "invalid-extension" };
    }
    if (req.suggestedName.includes("\0") || req.suggestedName.includes("..")) {
      return { outcome: "denied", reason: "invalid-path" };
    }
    const suffix = req.jobId.slice("job:".length).replace(/[^a-zA-Z0-9_-]/g, "");
    if (suffix.length === 0) {
      return { outcome: "denied", reason: "invalid-job-id" };
    }
    return { outcome: "granted", destinationId: `dst:${suffix}` };
  }

  // Handoff request validation: bounded non-secret source only. The caller
  // still requires explicit user confirmation before starting work.
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

  // Only explicit https links leave the app, through the safe external-link
  // path. No remote content navigates inside the privileged window.
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
    return { opened: true, reason: "external" };
  }

  function describe(): string {
    return `desktop native=${String(getCapabilities().nativeAvailable)} protocol=${PROTOCOL_MIN}`;
  }

  return { kind: "desktop", getCapabilities, requestSaveDestination, requestHandoff, openExternalLink, describe };
}
