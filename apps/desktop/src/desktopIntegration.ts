import { openUrl } from "@tauri-apps/plugin-opener";

// Keep erasable syntax only so node type-stripping can read this file.

export const APP_IDENTIFIER = "dev.ophir.dezoomify" as const;

export const NATIVE_ENCODERS = ["png", "jpeg", "tiff", "zif", "webp"] as const;
export type NativeEncoder = (typeof NATIVE_ENCODERS)[number];

// Native output formats accepted by the save destination grant. File
// encoders plus the IIIF directory output exposed by the desktop picker.
export type NativeFormat = NativeEncoder | "iiif-dir";
export const NATIVE_FORMATS: readonly NativeFormat[] = [...NATIVE_ENCODERS, "iiif-dir"];

// Exact Tauri command registry. Must match
// apps/desktop/src-tauri/src/commands.rs COMMANDS and the generated
// capability documents.
export const DESKTOP_COMMANDS = [
  "get_job_diagnostics",
  "answer_partial",
  "cancel_job",
  "dezoomify",
  "pause_job",
  "resume_job",
  "open_saved_output",
  "release_job",
  "query_capabilities",
] as const;

export type DesktopCommand = (typeof DESKTOP_COMMANDS)[number];

export type { DesktopEventChannel } from "./events.ts";
// The event channels are owned by apps/desktop/src/events.ts (the IPC
// payload guards live there); this module re-exports the single registry
// so capability checks share one source without an import cycle.
export { DESKTOP_EVENT_CHANNELS } from "./events.ts";

export interface DesktopCapabilities {
  readonly nativeAvailable: true;
  readonly extensionAvailable: boolean;
  readonly browserCanSave: boolean;
  readonly proxyAllowed: false;
  readonly encoders: readonly string[];
  readonly bulkSupported: true;
}

// Structural counterpart of the shared UI AppIntegration contract:
// capabilities, external links, and handoff requests.
// Routing and component composition stay shared.
export interface AppIntegration {
  readonly kind: "desktop";
  getCapabilities(): DesktopCapabilities;
  openExternalLink(url: string): Promise<{ opened: boolean; reason: string }>;
  describe(): string;
}

export function createDesktopIntegration(opts?: { extensionAvailable?: boolean }): AppIntegration {
  const extensionAvailable = opts?.extensionAvailable ?? false;

  function getCapabilities(): DesktopCapabilities {
    return {
      nativeAvailable: true,
      extensionAvailable,
      browserCanSave: true,
      proxyAllowed: false,
      encoders: [...NATIVE_ENCODERS],
      bulkSupported: true,
    };
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
    return `desktop native=${String(getCapabilities().nativeAvailable)}`;
  }

  return { kind: "desktop", getCapabilities, openExternalLink, describe };
}
