// Desktop integration: the desktop app implementation connecting the
// shared UI to its runtime and host capabilities.
//
// No imports from apps/web, apps/extension, browser-session fetch, or the
// metadata CORS proxy. The desktop app uses native effects only.

import { openUrl } from "@tauri-apps/plugin-opener";

// Keep erasable syntax only so node type-stripping can read this file.

export const PROTOCOL_MIN = "2.0" as const;
export const PROTOCOL_MAX = "2.0" as const;
export const PROTOCOL_VERSION = "2.0" as const;
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
  "job_command",
  "open_saved_output",
  "release_job",
  "query_capabilities",
  "request_destination",
  "start_job",
] as const;

export type DesktopCommand = (typeof DESKTOP_COMMANDS)[number];

export type { DesktopEventChannel } from "./events.ts";
// The event channels are owned by apps/desktop/src/events.ts (the IPC
// redaction guards live there); this module re-exports the single registry
// so capability checks share one source without an import cycle.
export { DESKTOP_EVENT_CHANNELS } from "./events.ts";

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
      protocolMin: PROTOCOL_MIN,
      protocolMax: PROTOCOL_MAX,
      // Todo 5.3: the desktop integration runs a sequential multi-job queue
      // (apps/desktop/src/queue.ts) over the single-job engine, so the queue
      // is always offered here. The engine still validates each queued
      // request on its own; the flag only gates the controls.
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
    return `desktop native=${String(getCapabilities().nativeAvailable)} protocol=${PROTOCOL_MIN}`;
  }

  return { kind: "desktop", getCapabilities, openExternalLink, describe };
}
