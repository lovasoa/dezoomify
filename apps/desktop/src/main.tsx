// Desktop entry: render the shared UI through the desktop integration.
// Routing and component composition stay shared; this file only wires the
// desktop host. Pixels stay native; only protocol progress and job events
// cross IPC, guarded by assertNoTileBytes and redactForEvent.
//
// Tauri commands used here: start_job, answer_choice, cancel_job,
// request_destination (via integration.requestSaveDestination).
// Event channels subscribed here: dezoomify://job-state,
// dezoomify://job-progress, dezoomify://job-output, dezoomify://job-error,
// dezoomify://deep-link-pending.
//
// Controller mapping (TRANSITIONS in packages/shared-ui/src/controller.ts):
// discovering -> images-found -> image-chosen -> level-chosen ->
// preflight-ok -> progress -> save-start -> save-done -> completed, plus
// preflight-display-only -> display-only, fail -> failed, cancel ->
// cancelled, reset -> idle. Recovery-requested (destination/partial) events
// surface typed choices (retry / choose-output / keep-partial /
// discard-partial / handoff-to-native) wired to answer_choice (RetryReady /
// PartialKeep), request_destination, and requestHandoff.
import { createController } from "../../../packages/shared-ui/src/controller.ts";
import { renderView } from "../../../packages/shared-ui/src/view.ts";
import type { ViewContext } from "../../../packages/shared-ui/src/view.ts";
import {
  createDesktopIntegration,
  NATIVE_ENCODERS,
  PROTOCOL_MAX,
  PROTOCOL_MIN,
  PROTOCOL_VERSION,
} from "./desktopIntegration.ts";
import type { NativeEncoder } from "./desktopIntegration.ts";
import { DESKTOP_EVENT_CHANNELS, assertNoTileBytes, redactForEvent } from "./events.ts";
import type { DesktopEventChannel } from "./events.ts";
import {
  describeSettingsForLog,
  loadSettings,
  parseHeadersText,
  pickDirectory,
  saveSettings,
  settingsToInvokeArgs,
  validateSettings,
} from "./settings.ts";
import type { DesktopSettings } from "./settings.ts";
import "./desktop.css";

const root = typeof document !== "undefined" ? document.getElementById("root") : null;
const integration = createDesktopIntegration();

// Desktop app version mirrors apps/desktop/package.json. Kept as a literal
// so the TS layer stays host-neutral (no JSON import, no I/O); bump both
// together. Used only for copy-diagnostics provenance, never for logic.
const DESKTOP_APP_VERSION = "3.0.0";

// Transport reported for every desktop controller transition. Pixels stay
// native, so the badge never claims a browser transport.
const NATIVE_TRANSPORT = "native";

// Per-request timeout shown in the job view (native parity: 30 s request,
// 6 s connect; the view renders the single per-request figure).
const REQUEST_TIMEOUT_MS = 30000;

// Capped technical log (oldest dropped first), web parity.
const MAX_LOG_LINES = 60;

// Large-image preflight bounds (native parity, docs/native-apps.md):
// the canvas holds 4 bytes per pixel plus transient encode buffers,
// budgeted at 8 GiB. JPEG addresses at most 65535 px per side.
const CANVAS_BYTES_PER_PIXEL = 4;
const CANVAS_LIMIT_BYTES = 8 * 1024 * 1024 * 1024;
const JPEG_MAX_SIDE = 65535;

// Opaque desktop choice strings. They must keep matching the shell mapping
// (apps/desktop/src-tauri/src/jobs.rs map_choice_kind) and the engine
// response shapes (RetryReady needs att:<suffix>, PartialKeep derives keep
// from keep/discard/partial markers):
// - retry -> RetryReady ("att:" prefix)
// - keep-partial / discard-partial -> PartialKeep ("partial:" + keep/discard)
const RETRY_CHOICE = "att:0:ready";
const KEEP_PARTIAL_CHOICE = "partial:keep";
const DISCARD_PARTIAL_CHOICE = "partial:discard";

let sessionId = "sess:desktop-1";
const controller = createController(sessionId);
// Outbound UI seq namespace for controller.dispatch (stale/foreign guarded
// by the controller). Inbound IPC seqs live in remoteSeqByJob below: the two
// namespaces are independent and must not be mixed.
let currentSeq = 0;
let currentJobId: string | null = null;
// Job id abandoned by a newer submit. Late events for it are ignored even
// before the new job id is known (Rust mints job:n monotonically, never
// reused, so this can never collide with the new job).
let retiredJobId: string | null = null;
// Inbound IPC seq high-water per job id. Events with seq <= stored are stale
// duplicates or reordered redeliveries and are ignored.
let remoteSeqByJob: Record<string, number> = {};
let submitToken = 0;
let lastInputUrl = "";
let grantedFormat: NativeEncoder = "png";

// Native output formats (todo 4.4): single source is NATIVE_ENCODERS in
// desktopIntegration.ts (png/jpeg/tiff), matching SUPPORTED_FORMATS in
// commands.rs and the tauri_shell.rs dialog filters. The 3-radio selector
// below writes grantedFormat; requestOutputAndResume reads it so the Save
// and choose-output paths never hard-code a format.
function normalizeNativeFormat(value: unknown): NativeEncoder {
  if (typeof value === "string") {
    const lower = value.toLowerCase();
    if ((NATIVE_ENCODERS as readonly string[]).includes(lower)) {
      return lower as NativeEncoder;
    }
  }
  return "png";
}

function extensionForFormat(format: NativeEncoder): string {
  if (format === "jpeg") return ".jpg";
  if (format === "tiff") return ".tif";
  return ".png";
}

function suggestedNameForFormat(format: NativeEncoder): string {
  return `dezoomify${extensionForFormat(format)}`;
}

// Minimal settings (task 3.5): persisted locally, validated with fail-closed
// bounds, and sent on the next start_job. Header values never enter logs;
// use describeSettingsForLog for any diagnostics.
let desktopSettings: DesktopSettings = loadSettings();
let settingsError: string | null = null;

interface PendingDecision {
  kind: "destination-request" | "destination-recovery" | "partial-recovery";
  reason: string;
  recovery?: string;
  attempt?: string;
  missingTiles?: Array<string>;
  failedCount?: number;
  totalCount?: number;
}

let pendingDecision: PendingDecision | null = null;

// Catalog auto-choice notice (todo 4.3): reuses the pendingDecision aux
// pattern as local-only state, never a new protocol event. The native
// pipeline auto-saves images[0] at the largest fitting level; the shared job
// view renders this honestly from controller imageCount plus this aux
// (WxH/K tiles). No picker is offered.
let catalogNotice: { imageCount: number; width?: number; height?: number; tiles?: number } | null =
  null;

// Accessibility (Task 5.2): dialog focus state. Each modal stores the element
// focused before it opened so focus returns on close. Recovery tracks its key
// so a new decision moves focus once without stealing it on every tick.
let deepLinkReturnFocus: HTMLElement | null = null;
let recoveryReturnFocus: HTMLElement | null = null;
let lastRecoveryKey: string | null = null;

// Focusable selectors for trap cycles. All desktop actions are native
// buttons, inputs, textareas, links, or summaries, so Tab reaches submit,
// save, cancel, reset, choices, settings, browse, and confirm without
// positive tabindex or div click handlers.
const FOCUSABLE_SELECTOR =
  "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), " +
  "textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

function focusableIn(container: HTMLElement): Array<HTMLElement> {
  const nodes = container.querySelectorAll(FOCUSABLE_SELECTOR);
  const out: Array<HTMLElement> = [];
  for (const node of Array.from(nodes)) {
    const el = node as HTMLElement;
    if (el.tabIndex < 0 && el.getAttribute("tabindex") === "-1") continue;
    out.push(el);
  }
  return out;
}

function activeElementOf(doc: Document): HTMLElement | null {
  const active = doc.activeElement;
  if (active && active instanceof HTMLElement) return active;
  return null;
}

function restoreFocus(target: HTMLElement | null): void {
  if (!target) return;
  try {
    if (target.isConnected && typeof target.focus === "function") target.focus();
  } catch {
    // Focus restore is best effort; a detached node stays ignored.
  }
}

function recoveryKeyFor(decision: PendingDecision | null): string | null {
  if (!decision) return null;
  const missing = (decision.missingTiles ?? []).join(",");
  return `${decision.kind}:${decision.reason}:${missing}:${decision.failedCount ?? ""}:${decision.totalCount ?? ""}`;
}

// Marked partial completion: a kept partial output stays distinguishable
// from a complete save. Set only on a partial-completed event; cleared on
// submit and reset. The missing list is redacted tile ids only, never URLs.
let completedPartial = false;
let completedMissing: Array<string> = [];

// Live heartbeat for the loading view: advances now and longestPendingMs
// so the pending box and smooth track stay current between IPC snapshots.
// The desktop shell reports snapshots (acquired/total), not per-request
// start/end, so the longest wait derives from last visible progress.
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

function nextSeq(): number {
  currentSeq += 1;
  return currentSeq;
}

function categoryFor(code: string): string {
  if (code === "INVALID_URL" || code === "INVALID_SETTINGS") return "validation";
  if (code === "NO_IMAGE_FOUND") return "discovery";
  if (code.indexOf("OUTPUT_") === 0 || code === "OUTPUT_DENIED") return "output";
  if (code === "WORKER_FAILED" || code === "PLAN_INVALID") return "internal";
  const lower = String(code ?? "").toLowerCase();
  if (lower.indexOf("protocol.incompatible") === 0 || lower.indexOf("handoff.rejected") === 0) return "validation";
  if (lower.indexOf("discovery.") === 0 || lower.indexOf("job.discovery") >= 0) return "discovery";
  if (lower.indexOf("output.") === 0) return "output";
  if (lower.indexOf("internal") >= 0 || lower === "native.internal") return "internal";
  if (lower.indexOf("job.invalid") >= 0 || lower.indexOf("command.") === 0) return "validation";
  return "transport";
}

function phaseFor(code: string): string {
  if (code === "NO_IMAGE_FOUND") return "discovery";
  if (code.indexOf("OUTPUT_") === 0 || code === "OUTPUT_DENIED") return "output";
  const lower = String(code ?? "").toLowerCase();
  if (lower === "protocol.incompatible") return "handshake";
  if (lower === "handoff.rejected") return "validation";
  if (lower.indexOf("discovery.") === 0 || lower.indexOf("job.discovery") >= 0) return "discovery";
  if (lower === "tile.decode-failed" || lower.indexOf("decode.") === 0) return "decode";
  if (lower === "tile.processing-failed") return "processing";
  if (lower.indexOf("output.") === 0) return "output";
  if (lower === "job.cancelled") return "cleanup";
  if (lower.indexOf("job.resource") === 0 || lower.indexOf("job.plan") === 0 || lower.indexOf("job.probe") === 0) return "acquisition";
  if (lower.indexOf("command.") === 0 || lower.indexOf("job.invalid") >= 0 || lower.indexOf("job.post-terminal") >= 0 || lower.indexOf("job.unknown") >= 0 || lower.indexOf("job.stale") >= 0) return "validation";
  return "acquisition";
}

function isTerminalStatus(status: string): boolean {
  return status === "completed" || status === "cancelled" || status === "failed";
}

function isValidInputUrl(url: string): boolean {
  if (typeof url !== "string") return false;
  const trimmed = url.trim();
  if (trimmed.length === 0 || trimmed.length > 2048) return false;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (parsed.username !== "" || parsed.password !== "") return false;
  return true;
}

// Redacted origin (scheme://host[:port]) for diagnostics and bug reports.
// Never includes userinfo, path, query, or fragment; "" when unparseable.
function redactedOriginOnly(url: string): string {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    const host = u.hostname.toLowerCase();
    if (!host) return "";
    const defaultPort = u.protocol === "https:" ? "443" : "80";
    const port = u.port && u.port !== defaultPort ? `:${u.port}` : "";
    return `${u.protocol}//${host}${port}`;
  } catch {
    return "";
  }
}

function hostOf(url: string): string {
  const origin = redactedOriginOnly(url);
  if (origin) {
    const withoutScheme = origin.split("://")[1] ?? "";
    if (withoutScheme) return withoutScheme;
  }
  return "the server";
}

// Idle prefill: read an initial URL from the launch location without ever
// treating it as a started job. Supports ?url=/ ?src= and legacy #url= or
// bare hash payloads. Invalid or secret-bearing candidates return null.
function readInitialUrl(): string | null {
  try {
    const loc = (globalThis as Record<string, unknown>)["location"] as
      | { search?: string; hash?: string }
      | undefined;
    if (!loc) return null;
    const search = typeof loc.search === "string" ? loc.search : "";
    if (search) {
      const params = new URLSearchParams(search);
      for (const key of ["url", "src", "input_url", "inputUrl"]) {
        const v = params.get(key);
        if (v && isValidInputUrl(v.trim())) return v.trim();
      }
    }
    const hash = typeof loc.hash === "string" ? loc.hash : "";
    if (hash && hash.startsWith("#")) {
      const body = hash.slice(1);
      if (body.startsWith("?")) {
        const params = new URLSearchParams(body.slice(1));
        const v = params.get("url") ?? params.get("src");
        if (v && isValidInputUrl(v.trim())) return v.trim();
      } else if (body.startsWith("url=")) {
        try {
          const v = decodeURIComponent(body.slice(4).replace(/\+/g, " "));
          if (isValidInputUrl(v.trim())) return v.trim();
        } catch {
          return null;
        }
      } else if (body.length > 0 && body.length <= 2048) {
        try {
          const v = decodeURIComponent(body.replace(/\+/g, " "));
          if (isValidInputUrl(v.trim())) return v.trim();
        } catch {
          return null;
        }
      }
    }
  } catch {
    return null;
  }
  return null;
}

// Redact full http(s) URLs inside free-form technical text down to their
// redacted origin, so diagnostics never carry paths, queries, or fragments.
function redactUrlsInText(text: string): string {
  return String(text ?? "").replace(/https?:\/\/[^\s"'<>]+/g, (match) => {
    const origin = redactedOriginOnly(match);
    return origin === "" ? "the server" : origin;
  });
}

function trimTechnical(text: string, max = 2000): string {
  const redacted = redactUrlsInText(text);
  if (redacted.length <= max) return redacted;
  return `${redacted.slice(0, max)}…`;
}

function formatGiB(bytes: number): string {
  const gib = bytes / (1024 * 1024 * 1024);
  if (gib >= 10) return `${Math.round(gib)} GiB`;
  return `${(Math.round(gib * 10) / 10).toFixed(1)} GiB`;
}

// Layered error copy: every code has plain jargon-free wording that names
// the step, the picture source, and the single best next action. Technical
// vocabulary (transport names, statuses, raw engine chains) stays out of
// this sentence; it belongs in the collapsible detail built beside it.
function plainMessageFor(code: string, engineMessage: string): string {
  const host = hostOf(lastInputUrl || activity().url || "");
  const engine = String(engineMessage ?? "");
  const lowerCode = String(code ?? "").toLowerCase();
  if (code === "INVALID_URL") {
    return "That address does not look like a web page address. Enter an address starting with http:// or https://.";
  }
  if (code === "INVALID_SETTINGS") {
    return "These download settings cannot be used. Adjust the highlighted settings and try again.";
  }
  if (code === "OUTPUT_DENIED") {
    return "The save destination was not accepted. Choose a different file to continue.";
  }
  if (lowerCode === "protocol.incompatible") {
    return `This app version cannot open this picture from ${host}. Update the app and try again.`;
  }
  if (lowerCode === "handoff.rejected") {
    return `This link cannot be opened from ${host}. Try a different address without sign-in details.`;
  }
  if (lowerCode === "output.exists") {
    return `A file already exists at the save destination from ${host}. Choose a different file or confirm overwriting to continue.`;
  }
  if (lowerCode === "output.destination-denied" || lowerCode === "output.unsupported-extension") {
    return `The save destination was not accepted from ${host}. Choose a different file to continue.`;
  }
  if (lowerCode === "job.post-terminal" || lowerCode === "job.unknown" || lowerCode === "job.stale") {
    return `This job is no longer active from ${host}. Start again with a fresh address.`;
  }
  if (lowerCode === "output.canvas-limit" || lowerCode.indexOf("canvas-limit") >= 0) {
    const dim = engine.match(/(\d+)\s*x\s*(\d+)/);
    const needMatch = engine.match(/needs\s+([0-9.]+\s*GiB[^,;]*|[0-9,]+\s*bytes[^,;]*)/i);
    const dims = dim ? `${dim[1]} by ${dim[2]} pixels` : "this picture";
    const need = needMatch ? ` It needs about ${needMatch[1].trim()} of memory` : "";
    return (
      `This picture is too large to assemble on this computer (${dims},` +
      `${need} at 4 bytes per pixel, limit ${formatGiB(CANVAS_LIMIT_BYTES)}).` +
      ` Save a smaller version with Max width (CLI: --max-width).` +
      ` Note: JPEG saves at most ${JPEG_MAX_SIDE} pixels per side; keep PNG for larger pictures. From ${host}.`
    );
  }
  if (lowerCode === "output.encode-failed" && /65535|jpeg/i.test(engine)) {
    const dim = engine.match(/(\d+)\s*x\s*(\d+)/);
    const dims = dim ? `${dim[1]} by ${dim[2]} pixels` : "this picture";
    return (
      `This picture (${dims}) is too large for JPEG, which allows at most` +
      ` ${JPEG_MAX_SIDE} pixels per side. Save it as PNG instead. From ${host}.`
    );
  }
  if (
    lowerCode.indexOf("tile.") === 0 ||
    lowerCode === "tile.download-failed" ||
    lowerCode === "job.partial-discarded" ||
    lowerCode.indexOf("partial") >= 0
  ) {
    if (lowerCode === "job.partial-discarded") {
      return `The partial picture was discarded so no file was kept. Try again from ${host} with a steady connection.`;
    }
    return (
      `Some pieces of this picture from ${host} could not be saved.` +
      ` Retry the failed pieces, or keep the partial picture with blank areas.`
    );
  }
  if (
    code === "NO_IMAGE_FOUND" ||
    lowerCode.indexOf("discovery.no-image") >= 0 ||
    lowerCode.indexOf("discovery.failed") >= 0 ||
    lowerCode.indexOf("discovery.") === 0 ||
    lowerCode.indexOf("job.discovery") >= 0 ||
    lowerCode.indexOf("job.no-images") >= 0 ||
    lowerCode.indexOf("job.catalog") >= 0 ||
    lowerCode.indexOf("job.empty") >= 0 ||
    lowerCode.indexOf("unknown-dezoomer") >= 0
  ) {
    return `Could not find a zoomable image at this address from ${host}. Try a different page or check the address.`;
  }
  if (
    lowerCode.indexOf("plan") >= 0 ||
    lowerCode.indexOf("level") >= 0 ||
    lowerCode.indexOf("tile-plan") >= 0 ||
    lowerCode.indexOf("resource-limit") >= 0 ||
    lowerCode.indexOf("tile.limit") >= 0
  ) {
    return `This picture has no usable size to save from ${host}. Try a different picture or a smaller Max width.`;
  }
  if (
    lowerCode.indexOf("transport.") === 0 ||
    lowerCode.indexOf("network") >= 0 ||
    lowerCode.indexOf("http-error") >= 0 ||
    lowerCode.indexOf("timeout") >= 0 ||
    lowerCode.indexOf("tls") >= 0 ||
    lowerCode.indexOf("redirect") >= 0
  ) {
    return `Saving stalled while contacting ${host}. Check your connection and try again.`;
  }
  if (lowerCode.indexOf("output.") === 0 || code.indexOf("OUTPUT_") === 0) {
    return `Could not write this picture from ${host}. Choose a different save destination and try again.`;
  }
  if (lowerCode.indexOf("job.cancelled") >= 0) {
    return `The image save was stopped. Any unfinished file was removed.`;
  }
  if (
    code === "START_FAILED" ||
    code === "CHOICE_FAILED" ||
    lowerCode.indexOf("invalid") >= 0 ||
    lowerCode.indexOf("stale") >= 0 ||
    lowerCode.indexOf("unknown") >= 0
  ) {
    if (code === "START_FAILED") return `Could not start saving this picture from ${host}. Try again.`;
    if (code === "CHOICE_FAILED") return "That choice was not accepted. Try again.";
    return `Could not save this picture from ${host}. Try again with a different address.`;
  }
  if (lowerCode.indexOf("internal") >= 0 || code === "WORKER_FAILED" || code === "PLAN_INVALID") {
    return `Something unexpected stopped this save from ${host}. Try again, and copy diagnostics if it keeps happening.`;
  }
  return `Could not save this picture from ${host}. Try again.`;
}

// Technical chain for the collapsible detail only: code, phase, transport,
// resource kind, status, trimmed origin, and the trimmed non-secret engine
// text. Never shown as the first message. Phase/transport/resource-kind come
// from the backend payload when present (stable codes), falling back to the
// local code mapping only for legacy payloads.
function technicalDetailFor(
  code: string,
  engineMessage: string,
  extraDetail: string | undefined,
  opts?: { phase?: string; transport?: string; resourceKind?: string },
): string {
  const state = controller.getState();
  const origin = redactedOriginOnly(lastInputUrl || activity().url || "");
  const lines = [
    `Code: ${code}`,
    `Phase: ${opts?.phase ?? phaseFor(code)}`,
    `Transport: ${opts?.transport ?? NATIVE_TRANSPORT}`,
  ];
  if (opts?.resourceKind) lines.push(`Resource: ${opts.resourceKind}`);
  lines.push(`Status: ${state.status}`);
  lines.push(`Origin: ${origin === "" ? "n/a" : origin}`);
  const engine = trimTechnical(engineMessage || "");
  if (engine) lines.push(`Engine: ${engine}`);
  if (extraDetail && extraDetail !== engineMessage) {
    const extra = trimTechnical(extraDetail);
    if (extra && extra !== engine) lines.push(`Detail: ${extra}`);
  }
  return lines.join("\n");
}

// Missing-tile ids for the partial view: typed fields first, then
// tile ids inside free-form detail text. Ids are short tokens only;
// URLs and paths never enter the list.
function extractMissingTiles(
  payload: Record<string, unknown>,
  detailObj: Record<string, unknown> | null,
  detailRaw: string,
): Array<string> {
  const out: Array<string> = [];
  const pushToken = (v: unknown): void => {
    if (typeof v !== "string") return;
    const t = v.trim();
    if (t.length === 0 || t.length > 128) return;
    if (t.indexOf("http://") >= 0 || t.indexOf("https://") >= 0) return;
    if (t.indexOf("/") >= 0 && t.indexOf(":") < 0) return;
    if (out.indexOf(t) < 0) out.push(t);
  };
  const tables: Array<Record<string, unknown> | null | undefined> = [payload, detailObj ?? undefined];
  for (const table of tables) {
    if (!table) continue;
    for (const key of ["missing", "missingTiles", "missing_tiles", "failedTiles", "failed_tiles", "tiles", "failed"]) {
      const v = (table as Record<string, unknown>)[key];
      if (Array.isArray(v)) {
        for (const item of v) {
          if (typeof item === "string") pushToken(item);
          else if (item && typeof item === "object") {
            const obj = item as Record<string, unknown>;
            pushToken(obj["tile"] ?? obj["id"] ?? obj["name"]);
          }
        }
      } else if (typeof v === "string" && v.length > 0 && v.length <= 2048) {
        for (const part of v.split(/[\s,;]+/)) pushToken(part);
      }
    }
  }
  const text = String(detailRaw ?? "");
  const tileRe = /tile[:#\s]*([A-Za-z0-9._-]{1,64})/gi;
  let m: RegExpExecArray | null;
  while ((m = tileRe.exec(text)) !== null) {
    pushToken(m[1]);
    if (out.length >= 60) break;
  }
  return out.slice(0, 60);
}

function formatMissingSummary(missing: Array<string>, failedCount?: number): string {
  const count = missing.length > 0 ? missing.length : (failedCount ?? 0);
  if (count <= 0) return "Some tiles could not be saved.";
  if (missing.length === 0) return `${count} tile${count === 1 ? "" : "s"} could not be saved.`;
  const shown = missing.slice(0, 20).join(", ");
  const rest = missing.length > 20 ? ` and ${missing.length - 20} more` : "";
  return `${missing.length} tile${missing.length === 1 ? "" : "s"} missing: ${shown}${rest}.`;
}

interface TauriInvokeFn {
  (cmd: string, args?: Record<string, unknown>): Promise<unknown>;
}

function tauriInvoke(): TauriInvokeFn | null {
  const internals = (globalThis as Record<string, unknown>)["__TAURI_INTERNALS__"] as
    | { invoke?: unknown }
    | undefined;
  if (internals && typeof internals.invoke === "function") {
    return internals.invoke as TauriInvokeFn;
  }
  return null;
}

type TauriListenFn = (
  channel: string,
  handler: (event: { payload: unknown }) => void,
) => Promise<unknown> | unknown;

function tauriListen(): TauriListenFn | null {
  const g = globalThis as Record<string, unknown>;
  const candidates: Array<unknown> = [g["__TAURI_EVENT__"], g["__TAURI_INTERNALS__"], g["__TAURI__"]];
  for (const cand of candidates) {
    if (cand && typeof (cand as Record<string, unknown>)["listen"] === "function") {
      return (cand as { listen: TauriListenFn }).listen;
    }
  }
  return null;
}

// --- Live job activity (drives the progressive-disclosure job view) ---

function activity(): NonNullable<ViewContext["jobActivity"]> {
  if (!viewCtx.jobActivity) viewCtx.jobActivity = { timeoutMs: REQUEST_TIMEOUT_MS };
  return viewCtx.jobActivity as NonNullable<ViewContext["jobActivity"]>;
}

function refreshLongestPending(): void {
  const a = viewCtx.jobActivity;
  if (!a) return;
  const now = Date.now();
  a.now = now;
  if ((a.pendingRequests ?? 0) > 0) {
    const base = a.lastProgressAt ?? a.startedAt ?? now;
    a.longestPendingMs = Math.max(0, now - base);
  } else {
    a.longestPendingMs = 0;
  }
}

function startHeartbeat(): void {
  stopHeartbeat();
  try {
    heartbeatTimer = setInterval(() => {
      if (isTerminalStatus(controller.getState().status)) {
        stopHeartbeat();
        return;
      }
      if (!viewCtx.jobActivity) return;
      refreshLongestPending();
      update();
    }, 500);
    const t = heartbeatTimer as unknown as { unref?: () => void };
    if (t && typeof t.unref === "function") {
      try {
        t.unref();
      } catch {
        // Browser timers lack unref.
      }
    }
  } catch {
    heartbeatTimer = null;
  }
}

function stopHeartbeat(): void {
  if (heartbeatTimer) {
    try {
      clearInterval(heartbeatTimer);
    } catch {
      // Ignore timer errors.
    }
    heartbeatTimer = null;
  }
}

function resetActivity(url: string): void {
  const now = Date.now();
  viewCtx.jobActivity = {
    url,
    startedAt: now,
    now,
    stepLabel: "Finding the zoomable image…",
    detail: `Contacting ${hostOf(url)}…`,
    pendingRequests: 0,
    completedRequests: 0,
    failedRequests: 0,
    longestPendingMs: 0,
    timeoutMs: REQUEST_TIMEOUT_MS,
    lastProgressAt: now,
    log: [],
  };
  startHeartbeat();
}

function touchProgress(): void {
  const a = activity();
  const now = Date.now();
  a.now = now;
  a.lastProgressAt = now;
}

function setStep(label: string, detail?: string): void {
  const a = activity();
  a.stepLabel = label;
  if (detail !== undefined) a.detail = detail;
  touchProgress();
  update();
}

function pushLog(line: string): void {
  const a = activity();
  if (!a.log) a.log = [];
  const elapsed = a.startedAt ? Math.round((Date.now() - a.startedAt) / 1000) : 0;
  a.log.push(`${elapsed}s: ${line}`);
  if (a.log.length > MAX_LOG_LINES) a.log.splice(0, a.log.length - MAX_LOG_LINES);
  a.now = Date.now();
}

function noteProgress(current: number, total: number): void {
  const a = activity();
  const now = Date.now();
  a.now = now;
  a.lastProgressAt = now;
  a.completedRequests = current;
  a.pendingRequests = total > current ? total - current : 0;
  if (typeof a.failedRequests !== "number") a.failedRequests = 0;
  refreshLongestPending();
  // Keep lastProgressAt as the freshness anchor: longestPendingMs derives
  // from it on the heartbeat, so the pending box shows live waiting time.
  a.now = Date.now();
}

// --- Controller transitions ---

function dispatchFail(
  code: string,
  message: string,
  opts?: {
    transport?: string;
    phase?: string;
    detail?: string;
    retryable?: boolean;
    resourceKind?: string;
  },
): void {
  const transport = opts?.transport ?? NATIVE_TRANSPORT;
  const phase = opts?.phase ?? phaseFor(code);
  // Prefer the backend's retryable verdict when present (stable codes);
  // fall back to the legacy local heuristic only for payloads without it.
  const retryable =
    opts?.retryable ?? (code !== "INVALID_URL" && code !== "NO_IMAGE_FOUND" && code !== "OUTPUT_DENIED");
  // Layered presentation: the first message stays a plain jargon-free
  // sentence naming the step, picture source, and single best action.
  // The technical chain (transport, status, trimmed origin, engine text)
  // lives only in the collapsible detail.
  const plain = plainMessageFor(code, message);
  const technical = technicalDetailFor(code, message, opts?.detail, {
    phase,
    transport,
    ...(opts?.resourceKind ? { resourceKind: opts.resourceKind } : {}),
  });
  controller.dispatch({
    seq: nextSeq(),
    sessionId,
    kind: "fail",
    transport,
    error: {
      code,
      category: categoryFor(code),
      retryable,
      message: plain,
      transport,
      phase,
      detail: technical,
    },
  });
  pushLog(`Failed (${code}): ${trimTechnical(message, 160)}`);
  pendingDecision = null;
  catalogNotice = null;
  stopHeartbeat();
  update();
}

function clearJobViewState(): void {
  viewCtx.currentProgress = undefined;
  viewCtx.completedInfo = undefined;
  viewCtx.jobActivity = undefined;
  viewCtx.imageChoice = undefined;
  pendingDecision = null;
  catalogNotice = null;
  completedPartial = false;
  completedMissing = [];
  grantedFormat = "png";
  stopHeartbeat();
}

function handleSubmitUrl(url: string): void {
  const token = ++submitToken;
  const trimmed = typeof url === "string" ? url.trim() : "";
  if (!isValidInputUrl(trimmed)) {
    controller.dispatch({
      seq: nextSeq(),
      sessionId,
      kind: "fail",
      transport: NATIVE_TRANSPORT,
      error: {
        code: "INVALID_URL",
        category: "validation",
        retryable: false,
        message: "Please enter a valid web address starting with http:// or https://",
        transport: NATIVE_TRANSPORT,
        phase: "discovery",
      },
    });
    update();
    return;
  }
  // A submit after a terminal state starts a fresh job on the same session:
  // reset to idle first (completed/cancelled only accept reset; failed also
  // accepts start-discovery, and reset is valid there too).
  if (isTerminalStatus(controller.getState().status)) {
    controller.reset();
    currentSeq = 0;
    currentJobId = null;
    retiredJobId = null;
    remoteSeqByJob = {};
    clearJobViewState();
  } else {
    retiredJobId = currentJobId;
    clearJobViewState();
  }
  lastInputUrl = trimmed;
  controller.dispatch({ seq: nextSeq(), sessionId, kind: "start-discovery", transport: NATIVE_TRANSPORT });
  resetActivity(trimmed);
  pushLog(`Starting job for ${redactedOriginOnly(trimmed) || "the server"}`);
  // Minimal settings are validated fail-closed here: invalid settings fail
  // the submit before any start_job effect. The redacted summary never
  // includes header values.
  const effective = getEffectiveSettings();
  if (!effective.ok || !effective.settings) {
    const detail = effective.errors.join("; ") || "Invalid settings.";
    settingsError = detail;
    const technical = technicalDetailFor("INVALID_SETTINGS", "These download settings are invalid.", detail);
    controller.dispatch({
      seq: nextSeq(),
      sessionId,
      kind: "fail",
      transport: NATIVE_TRANSPORT,
      error: {
        code: "INVALID_SETTINGS",
        category: "validation",
        retryable: false,
        message: "These download settings are invalid. Adjust them and try again.",
        transport: NATIVE_TRANSPORT,
        phase: "discovery",
        detail: technical,
      },
    });
    pushLog("Settings invalid; job not started");
    stopHeartbeat();
    update();
    return;
  }
  settingsError = null;
  desktopSettings = effective.settings;
  pushLog(`Settings: ${describeSettingsForLog(desktopSettings)}`);
  update();
  const invoke = tauriInvoke();
  if (!invoke) {
    return;
  }
  const settingsArgs = settingsToInvokeArgs(desktopSettings);
  void invoke("start_job", { input_url: trimmed, settings: settingsArgs }).then(
    (raw) => {
      if (token !== submitToken) return;
      const res = raw as { job?: unknown; seq?: unknown } | null;
      const job = res && typeof res.job === "string" ? res.job : null;
      if (job) {
        currentJobId = job;
        retiredJobId = null;
      }
      update();
    },
    (error: unknown) => {
      if (token !== submitToken) return;
      const message = error instanceof Error ? error.message : "Could not start the job.";
      dispatchFail("START_FAILED", message);
    },
  );
}

function answerChoice(choice: string, onGranted: () => void, failureLabel: string): void {
  const job = currentJobId;
  const invoke = tauriInvoke();
  if (!job || !invoke) {
    onGranted();
    return;
  }
  void invoke("answer_choice", { job, choice }).then(
    () => {
      onGranted();
    },
    (error: unknown) => {
      const message = error instanceof Error ? error.message : failureLabel;
      dispatchFail("CHOICE_FAILED", message);
    },
  );
}

function handleSelectImage(index: number): void {
  if (isTerminalStatus(controller.getState().status)) return;
  const choice = `img:${index}`;
  pushLog(`Chose image ${index}`);
  answerChoice(
    choice,
    () => {
      controller.dispatch({ seq: nextSeq(), sessionId, kind: "image-chosen" });
      update();
    },
    "The image choice was rejected.",
  );
}

function handleSelectLevel(level: number): void {
  if (isTerminalStatus(controller.getState().status)) return;
  const choice = `level:${level}`;
  pushLog(`Chose level ${level}`);
  answerChoice(
    choice,
    () => {
      controller.dispatch({ seq: nextSeq(), sessionId, kind: "level-chosen" });
      update();
    },
    "The level choice was rejected.",
  );
}

function handleCancel(): void {
  if (isTerminalStatus(controller.getState().status)) return;
  const job = currentJobId;
  const invoke = tauriInvoke();
  // Cancellation waits for cleanup acknowledgement before reaching
  // cancelled: show the cleaning step now, dispatch the terminal only
  // after the shell acknowledges (cancelled event or cancel_job success).
  // The shell removes uncommitted output best-effort; the cancelled view
  // notes that removal.
  pushLog("Cancelling… cleaning up…");
  setStep("Working…", "Cleaning up… removing unfinished file…");
  pendingDecision = null;
  catalogNotice = null;
  if (job && invoke) {
    void invoke("cancel_job", { job }).then(
      () => {
        if (isTerminalStatus(controller.getState().status)) return;
        // Shell acknowledged cleanup: reach cancelled exactly once.
        // The event channel usually delivers the same transition first;
        // the controller guard makes the second a no-op.
        controller.dispatch({ seq: nextSeq(), sessionId, kind: "cancel" });
        pushLog("Cancelled; unfinished file removed");
        stopHeartbeat();
        update();
      },
      () => {
        if (isTerminalStatus(controller.getState().status)) return;
        controller.dispatch({ seq: nextSeq(), sessionId, kind: "cancel" });
        pushLog("Cancelled; unfinished file removed");
        stopHeartbeat();
        update();
      },
    );
    return;
  }
  controller.dispatch({ seq: nextSeq(), sessionId, kind: "cancel" });
  pushLog("Cancelled by user; unfinished file removed");
  stopHeartbeat();
  update();
}

// Shared save-destination grant path for the Save button and the
// choose-output recovery choice. On grant, walks the controller into saving;
// completion itself arrives via dezoomify://job-output (exactly-once
// terminal guard ignores any duplicate).
function requestOutputAndResume(origin: string): void {
  const job = currentJobId;
  if (!job || isTerminalStatus(controller.getState().status)) return;
  const format = normalizeNativeFormat(grantedFormat);
  const suggestedName = suggestedNameForFormat(format);
  pushLog(origin === "choose-output" ? "Requesting save destination…" : "Requesting save destination (save)…");
  void integration
    .requestSaveDestination({ jobId: job, format, suggestedName })
    .then(
      (result) => {
        if (isTerminalStatus(controller.getState().status)) return;
        if (result.outcome === "granted") {
          grantedFormat = format;
          if (pendingDecision && pendingDecision.reason === "destination") {
            pendingDecision = null;
          }
          pushLog("Save destination granted");
          ensureChosenThroughPreflight();
          controller.dispatch({ seq: nextSeq(), sessionId, kind: "save-start" });
          setStep("Assembling the final picture…", "Encoding in the native app");
          if (!tauriInvoke()) {
            // Validation-only fallback (no Tauri host): no native worker
            // will emit job-output, so close the loop locally.
            controller.dispatch({ seq: nextSeq(), sessionId, kind: "save-done" });
          }
          update();
        } else if (result.outcome === "denied") {
          // Stable backend code rides `code` when present (output.exists,
          // output.destination-denied, ...); fall back to the legacy
          // OUTPUT_DENIED only for payloads without it.
          const denied = result as { reason?: string; code?: string };
          const code = typeof denied.code === "string" && denied.code.length > 0 ? denied.code : "OUTPUT_DENIED";
          dispatchFail(code, denied.reason ?? "The save destination was denied.");
        } else {
          pushLog("Save destination request cancelled");
          update();
        }
      },
      (error: unknown) => {
        if (isTerminalStatus(controller.getState().status)) return;
        const message = error instanceof Error ? error.message : "Could not request the save destination.";
        dispatchFail("OUTPUT_DENIED", message);
      },
    );
}

function handleSave(): void {
  requestOutputAndResume("save");
}

// Recovery: retry the outstanding decision (destination -> back to
// awaiting-destination; partial -> retry failed tiles). Wired to the engine
// RetryReady response via the att:<suffix> choice shape.
function handleRecoveryRetry(): void {
  const decision = pendingDecision;
  if (!decision || isTerminalStatus(controller.getState().status)) return;
  pushLog(`Retry requested (${decision.reason})`);
  answerChoice(
    RETRY_CHOICE,
    () => {
      pendingDecision = null;
      setStep("Saving image tiles…", "Retrying");
      update();
    },
    "The retry request was rejected.",
  );
}

// Recovery: keep or discard a partial result. Wired to the engine PartialKeep
// response via the partial:keep / partial:discard choice shapes. The terminal
// outcome (partial-completed / failed) arrives as an event; nothing is
// dispatched locally so the terminal stays exactly-once.
function handlePartialChoice(keep: boolean): void {
  const decision = pendingDecision;
  if (!decision || decision.kind !== "partial-recovery") return;
  if (isTerminalStatus(controller.getState().status)) return;
  pushLog(keep ? "Keeping partial image…" : "Discarding partial image…");
  answerChoice(
    keep ? KEEP_PARTIAL_CHOICE : DISCARD_PARTIAL_CHOICE,
    () => {
      pendingDecision = null;
      setStep(
        keep ? "Assembling the final picture…" : "Working…",
        keep ? "Encoding partial image in the native app" : "Discarding partial image",
      );
      update();
    },
    "The partial-image choice was rejected.",
  );
}

// Recovery: hand the job to another app. The desktop app is already native,
// so this validates the bounded non-secret source and records the outcome;
// the user keeps working here afterwards.
function handleHandoffToNative(): void {
  const decision = pendingDecision;
  if (!decision || isTerminalStatus(controller.getState().status)) return;
  if (!lastInputUrl) return;
  pushLog("Checking handoff to another app…");
  void integration
    .requestHandoff({ sourceUrl: lastInputUrl, provenanceLabel: "desktop" })
    .then(
      (result) => {
        pushLog(
          result.accepted
            ? `Handoff ready: ${result.reason}`
            : `Handoff rejected: ${result.reason}`,
        );
        const a = activity();
        a.detail = result.accepted
          ? "This picture can be handed to another app. You are already in the native app, so you can continue here."
          : "This picture cannot be handed to another app. Continue here or try a different picture.";
        touchProgress();
        update();
      },
      (error: unknown) => {
        pushLog(`Handoff check failed: ${error instanceof Error ? error.message : "unknown error"}`);
        update();
      },
    );
}

function handleReset(): void {
  submitToken += 1;
  sessionId = `sess:desktop-${Date.now()}`;
  controller.reset(sessionId);
  currentSeq = 0;
  currentJobId = null;
  retiredJobId = null;
  remoteSeqByJob = {};
  lastInputUrl = "";
  clearJobViewState();
  dismissDeepLinkConfirm(false);
  deepLinkReturnFocus = null;
  recoveryReturnFocus = null;
  lastRecoveryKey = null;
  // Idle prefill survives reset: a launch URL stays available for the next
  // empty form without ever starting a job on its own.
  const prefilled = readInitialUrl();
  if (prefilled) viewCtx.initialUrl = prefilled;
  else viewCtx.initialUrl = undefined;
  stopHeartbeat();
  update();
}

function handleOpenExternalLink(url: string): void {
  void integration.openExternalLink(url).then(
    () => undefined,
    () => undefined,
  );
}

// --- Minimal settings (task 3.5) ---

// Read the current settings draft from the panel inputs when present,
// otherwise the last persisted settings. Always validated fail-closed;
// callers must not start a job when `ok` is false. Header values are never
// logged; only describeSettingsForLog leaves this layer.
function getEffectiveSettings(): { ok: boolean; settings: DesktopSettings | null; errors: Array<string> } {
  if (typeof document === "undefined" || !root) {
    const validated = validateSettings({
      outputDir: desktopSettings.outputDir,
      compression: desktopSettings.compression,
      maxWidth: desktopSettings.maxWidth,
      maxHeight: desktopSettings.maxHeight,
      retries: desktopSettings.retries,
      cacheDir: desktopSettings.cacheDir,
      headers: { ...desktopSettings.headers },
    });
    if (!validated.ok || !validated.settings) return { ok: false, settings: null, errors: validated.errors };
    return { ok: true, settings: validated.settings, errors: [] };
  }
  const panel = document.getElementById("dz-desktop-settings");
  if (!panel) {
    return { ok: true, settings: desktopSettings, errors: [] };
  }
  const readInput = (id: string): string => {
    const el = panel.querySelector(`#${id}`) as HTMLInputElement | HTMLTextAreaElement | null;
    return el && typeof el.value === "string" ? el.value : "";
  };
  const headersRaw = readInput("dz-settings-headers");
  const parsedHeaders = parseHeadersText(headersRaw);
  const raw = {
    outputDir: readInput("dz-settings-output-dir"),
    compression: readInput("dz-settings-compression"),
    maxWidth: readInput("dz-settings-max-width"),
    maxHeight: readInput("dz-settings-max-height"),
    retries: readInput("dz-settings-retries"),
    cacheDir: readInput("dz-settings-cache-dir"),
    headers: parsedHeaders.headers,
  };
  const errors: Array<string> = [...parsedHeaders.errors];
  const validated = validateSettings(raw);
  for (const e of validated.errors) errors.push(e);
  if (!validated.ok || !validated.settings) return { ok: false, settings: null, errors };
  return { ok: true, settings: validated.settings, errors: [] };
}

// Persist the panel draft when valid; show validation errors otherwise.
// Invalid drafts never overwrite the last good persisted payload.
function persistSettingsFromPanel(): void {
  const effective = getEffectiveSettings();
  if (!effective.ok || !effective.settings) {
    settingsError = effective.errors.join("; ") || "Invalid settings.";
    update();
    return;
  }
  settingsError = null;
  desktopSettings = effective.settings;
  const saveErrors = saveSettings(desktopSettings);
  if (saveErrors.length > 0) {
    settingsError = saveErrors.join("; ");
  } else {
    pushLog(`Settings saved: ${describeSettingsForLog(desktopSettings)}`);
  }
  update();
}

function resetDesktopSettings(): void {
  const fresh = validateSettings(null);
  desktopSettings = fresh.settings ?? desktopSettings;
  settingsError = null;
  saveSettings(desktopSettings);
  pushLog("Settings reset to defaults");
  update();
}

// Copy-diagnostics provenance: typed error context, job and attempt ids, app
// and protocol versions, and the redacted source origin only. Never the full
// URL, credentials, or response content.
function buildCopyDiagnostics(): string {
  const state = controller.getState();
  const error = state.error;
  const origin = redactedOriginOnly(lastInputUrl);
  const lines = [
    `Status: ${state.status}`,
    `Transport: ${state.transport ?? NATIVE_TRANSPORT}`,
    `Job: ${currentJobId ?? "none"}`,
    `Attempt: ${pendingDecision?.attempt ?? "n/a"}`,
    `Session: ${sessionId}`,
    `App: dezoomify-desktop ${DESKTOP_APP_VERSION}`,
    `Protocol: ${PROTOCOL_VERSION} (min ${PROTOCOL_MIN}, max ${PROTOCOL_MAX})`,
  ];
  if (error) {
    lines.push(`Code: ${error.code}`);
    lines.push(`Category: ${error.category}`);
    lines.push(`Phase: ${error.phase ?? phaseFor(error.code)}`);
    lines.push(`Retryable: ${String(error.retryable)}`);
    lines.push(`Message: ${error.message}`);
    if (error.detail) lines.push(`Detail: ${error.detail}`);
  }
  const progress = viewCtx.currentProgress;
  if (progress) lines.push(`Tiles: ${progress.current} of ${progress.total}`);
  lines.push(`Origin: ${origin === "" ? "n/a" : origin}`);
  return lines.join("\n");
}

function handleCopyDiagnostics(): void {
  const text = buildCopyDiagnostics();
  const done = () => {
    const btn = typeof document !== "undefined" ? document.getElementById("dz-btn-copy-diag") : null;
    if (btn) {
      btn.textContent = "Copied!";
      setTimeout(() => {
        try {
          if (btn.isConnected) btn.textContent = "Copy diagnostics";
        } catch {
          // Button may be gone after re-render; ignore.
        }
      }, 2000);
    }
  };
  try {
    const nav = globalThis as Record<string, unknown>;
    const clipboard = nav["navigator"] as unknown as
      | { clipboard?: { writeText?: (text: string) => Promise<unknown> } }
      | undefined;
    if (clipboard?.clipboard?.writeText) {
      void (clipboard.clipboard.writeText(text) as Promise<unknown>).then(done, done);
      return;
    }
    if (typeof document !== "undefined") {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
      done();
    }
  } catch {
    // Copy failures stay silent; the technical-details section still shows
    // the same diagnostics for manual copying.
  }
}

// No onCopyShareLink: desktop output is a native file handle, so there is no
// shareable browser link to copy. The job view hides the share button when
// the callback is absent; diagnostics copying has its own explicit button.

// Idempotent walk from discovering through selection into downloading. Each
// dispatch is accepted only when the controller transition is legal, so
// calling this on every running/progress signal is safe and duplicate
// signals never double-advance.
function ensureChosenThroughPreflight(imageCount?: number): void {
  controller.dispatch({
    seq: nextSeq(),
    sessionId,
    kind: "images-found",
    ...(typeof imageCount === "number" ? { imageCount } : {}),
    transport: NATIVE_TRANSPORT,
  });
  controller.dispatch({ seq: nextSeq(), sessionId, kind: "image-chosen" });
  controller.dispatch({ seq: nextSeq(), sessionId, kind: "level-chosen" });
  controller.dispatch({ seq: nextSeq(), sessionId, kind: "preflight-ok", transport: NATIVE_TRANSPORT });
}

function completeJob(
  completedInfo?: { width: number; height: number; mime: string },
  partial?: boolean,
  missing?: Array<string>,
): void {
  if (isTerminalStatus(controller.getState().status)) return;
  ensureChosenThroughPreflight();
  if (completedInfo) viewCtx.completedInfo = completedInfo;
  const info = viewCtx.completedInfo;
  if (info && info.width > 0 && info.height > 0) {
    const prevCount = catalogNotice?.imageCount ?? controller.getState().imageCount ?? 0;
    catalogNotice = {
      ...(catalogNotice ?? {}),
      imageCount: prevCount,
      width: info.width,
      height: info.height,
      ...(typeof viewCtx.currentProgress?.total === "number" && viewCtx.currentProgress.total > 0
        ? { tiles: viewCtx.currentProgress.total }
        : {}),
    };
    viewCtx.imageChoice = {
      width: info.width,
      height: info.height,
      ...(typeof viewCtx.currentProgress?.total === "number" && viewCtx.currentProgress.total > 0
        ? { tiles: viewCtx.currentProgress.total }
        : {}),
    };
  }
  pendingDecision = null;
  completedPartial = partial === true;
  completedMissing = Array.isArray(missing) ? missing.slice(0, 60) : [];
  if (info) {
    if (completedPartial) {
      const summary = formatMissingSummary(completedMissing, completedMissing.length);
      pushLog(`Partial done: ${info.width}x${info.height} (${info.mime}); ${summary}`);
      setStep("Assembling the final picture…", `Partial image ${info.width} by ${info.height} pixels; ${summary}`);
    } else {
      pushLog(`Done: ${info.width}x${info.height} (${info.mime})`);
      setStep("Assembling the final picture…", `Finished ${info.width} by ${info.height} pixels`);
    }
  } else if (completedPartial) {
    const summary = formatMissingSummary(completedMissing, completedMissing.length);
    pushLog(`Partial done; ${summary}`);
    setStep("Assembling the final picture…", `Partial image saved; ${summary}`);
  } else {
    pushLog("Done");
    setStep("Assembling the final picture…", "Finished");
  }
  controller.dispatch({ seq: nextSeq(), sessionId, kind: "save-start" });
  controller.dispatch({ seq: nextSeq(), sessionId, kind: "save-done" });
  stopHeartbeat();
  update();
}

// --- IPC payload parsing ---

type PayloadTable = Record<string, unknown>;

function asPayload(raw: unknown): PayloadTable {
  if (typeof raw === "object" && raw !== null) return raw as PayloadTable;
  return { value: raw };
}

function payloadText(payload: PayloadTable): string {
  const parts: Array<string> = [];
  for (const key of ["kind", "event", "detail", "state", "reason", "status", "phase"]) {
    const v = payload[key];
    if (typeof v === "string" && v.length > 0) parts.push(v);
  }
  return parts.join(" ").toLowerCase();
}

function payloadJob(payload: PayloadTable): string | null {
  for (const key of ["job", "jobId", "job_id"]) {
    const v = payload[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

function payloadSeq(payload: PayloadTable): number | null {
  for (const key of ["seq", "seqNo", "sequence", "eventSeq"]) {
    const v = payload[key];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) return Math.floor(v);
    if (typeof v === "string" && v.trim() !== "") {
      const n = Number(v.trim());
      if (Number.isFinite(n) && n >= 0) return Math.floor(n);
    }
  }
  return null;
}

function strField(payload: PayloadTable, keys: Array<string>): string | undefined {
  for (const key of keys) {
    const v = payload[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

// Numeric field from a payload key (number or numeric string) or from a
// "k=v"/"k: v" pair inside free-form detail text (the shell joins pipeline
// detail maps as "acquired=3 total=10").
function numField(payload: PayloadTable, detailText: string, keys: Array<string>): number | undefined {
  for (const key of keys) {
    const v = payload[key];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) return Math.floor(v);
    if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v.trim()))) {
      const n = Math.floor(Number(v.trim()));
      if (n >= 0) return n;
    }
  }
  for (const key of keys) {
    const m = detailText.match(new RegExp(`(?:^|\\s)${key}\\s*[:=]\\s*(\\d+)`, "i"));
    if (m) {
      const n = Math.floor(Number(m[1]));
      if (Number.isFinite(n) && n >= 0) return n;
    }
  }
  return undefined;
}

// Structured detail attached to an event: JSON object string, "k=v" pairs,
// or a plain technical sentence. Returns the parsed object when the detail
// is shaped, so reason/recovery/attempt/code/message stay typed (never
// branched from display strings elsewhere).
function parseDetailObject(detail: string): PayloadTable | null {
  const trimmed = detail.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === "object" && parsed !== null) return parsed as PayloadTable;
    } catch {
      return null;
    }
  }
  return null;
}

function payloadReason(payload: PayloadTable, text: string): "destination" | "partial" | null {
  const direct = strField(payload, ["reason", "recoveryReason", "recovery_reason"]);
  if (direct) {
    const lower = direct.toLowerCase();
    if (lower.indexOf("destination") >= 0) return "destination";
    if (lower.indexOf("partial") >= 0) return "partial";
  }
  const detail = strField(payload, ["detail"]);
  if (detail) {
    const obj = parseDetailObject(detail);
    if (obj) {
      const inner = strField(obj, ["reason"]);
      if (inner) {
        const lower = inner.toLowerCase();
        if (lower.indexOf("destination") >= 0) return "destination";
        if (lower.indexOf("partial") >= 0) return "partial";
      }
    }
  }
  if (text.indexOf("destination") >= 0) return "destination";
  if (text.indexOf("partial") >= 0) return "partial";
  return null;
}

function encoderToMime(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  const lower = value.toLowerCase();
  if (lower.indexOf("image/") === 0) return value;
  if (lower === "png") return "image/png";
  if (lower === "jpeg" || lower === "jpg") return "image/jpeg";
  if (lower === "tiff" || lower === "tif") return "image/tiff";
  return fallback;
}

function grantedMime(): string {
  return encoderToMime(grantedFormat, "image/png");
}

function extractDeepLinkUrl(payload: PayloadTable): string | null {
  for (const key of ["url", "sourceUrl", "source_url", "input_url", "inputUrl", "href", "detail"]) {
    const v = payload[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

interface ValidatedDeepLink {
  sourceUrl: string;
  hint: string | null;
  version: number;
}

const DEEP_LINK_SECRET_QUERY_KEYS = new Set([
  "cookie",
  "cookies",
  "authorization",
  "proxy-authorization",
  "bearer",
  "token",
  "signature",
  "sig",
  "auth",
  "secret",
  "password",
  "session",
  "sid",
  "apikey",
  "api_key",
  "key",
]);

function hasSecretQueryParams(urlString: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    return true;
  }
  for (const key of parsed.searchParams.keys()) {
    if (DEEP_LINK_SECRET_QUERY_KEYS.has(key.toLowerCase())) return true;
  }
  return false;
}

// Deep-link source check: the shared input-URL shape plus the deep-link
// non-secret rule (no secret query keys, no local-file/path markers).
function isValidDeepLinkSource(source: unknown): source is string {
  if (typeof source !== "string") return false;
  const trimmed = source.trim();
  if (!isValidInputUrl(trimmed)) return false;
  if (hasSecretQueryParams(trimmed)) return false;
  const lower = trimmed.toLowerCase();
  for (const needle of ["file://", "/etc/", "c:\\"]) {
    if (lower.includes(needle)) return false;
  }
  return true;
}

function normalizeDeepLinkHint(hint: unknown): string | null | undefined {
  if (hint === undefined || hint === null) return null;
  if (typeof hint !== "string") return undefined;
  if (hint.includes("\0")) return undefined;
  if (hint.length === 0) return null;
  if (hint.length > 256) return undefined;
  return hint;
}

function normalizeDeepLinkVersion(version: unknown): number | null {
  if (typeof version === "number" && Number.isInteger(version)) {
    return version === 1 || version === 2 ? version : null;
  }
  if (typeof version === "string" && (version === "1" || version === "2")) {
    return Number(version);
  }
  return null;
}

// Re-parse one raw `dezoomify://open` URL in the frontend (defense in depth:
// the Rust shell already validated it with `deep_link::parse_deep_link`).
// Rejects oversize, wrong scheme, duplicate/unknown/secret fields,
// unsupported versions, and malformed percent-encoding. Null means reject.
function parseRawDeepLinkUrl(raw: string): ValidatedDeepLink | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 2048) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "dezoomify:") return null;
  if (parsed.hostname !== "open") return null;
  if (parsed.username !== "" || parsed.password !== "") return null;
  const query = trimmed.split("?")[1]?.split("#")[0] ?? "";
  if (query.length === 0) return null;
  let versionRaw: string | null = null;
  let srcRaw: string | null = null;
  let hintRaw: string | null = null;
  let seenV = false;
  let seenSrc = false;
  let seenHint = false;
  for (const pair of query.split("&")) {
    if (pair.length === 0) continue;
    const eq = pair.indexOf("=");
    if (eq < 0) return null;
    const name = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    if (name.includes("%")) return null;
    if (name === "v") {
      if (seenV) return null;
      seenV = true;
      versionRaw = value;
    } else if (name === "src") {
      if (seenSrc) return null;
      seenSrc = true;
      srcRaw = value;
    } else if (name === "hint") {
      if (seenHint) return null;
      seenHint = true;
      hintRaw = value;
    } else {
      return null;
    }
  }
  if (versionRaw !== "1" && versionRaw !== "2") return null;
  if (srcRaw === null) return null;
  let sourceUrl: string;
  try {
    sourceUrl = decodeURIComponent(srcRaw.replace(/\+/g, " "));
  } catch {
    return null;
  }
  if (!isValidDeepLinkSource(sourceUrl)) return null;
  let hint: string | null = null;
  if (hintRaw !== null) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(hintRaw.replace(/\+/g, " "));
    } catch {
      return null;
    }
    const normalized = normalizeDeepLinkHint(decoded);
    if (normalized === undefined) return null;
    hint = normalized;
  }
  return { sourceUrl: sourceUrl.trim(), hint, version: Number(versionRaw) };
}

// Validate a `dezoomify://deep-link-pending` payload again in the frontend
// before showing the confirm UI. Accepts the redacted
// `{source_url, hint, version}` triple emitted by the Rust shell, or a raw
// `dezoomify://open` URL in legacy shapes. Null means reject (no-op).
function validateDeepLinkPayload(payload: PayloadTable): ValidatedDeepLink | null {
  const sourceRaw =
    payload["source_url"] ?? payload["sourceUrl"] ?? extractDeepLinkUrl(payload);
  if (typeof sourceRaw === "string" && sourceRaw.trim().startsWith("dezoomify://")) {
    return parseRawDeepLinkUrl(sourceRaw);
  }
  const version = normalizeDeepLinkVersion(payload["version"] ?? payload["v"]);
  if (version === null) return null;
  if (!isValidDeepLinkSource(sourceRaw)) return null;
  const hint = normalizeDeepLinkHint(payload["hint"] ?? null);
  if (hint === undefined) return null;
  return { sourceUrl: (sourceRaw as string).trim(), hint, version };
}

function dismissDeepLinkConfirm(restore = true): void {
  if (typeof document === "undefined") return;
  document.getElementById("dz-deep-link-confirm")?.remove();
  if (restore) {
    restoreFocus(deepLinkReturnFocus);
    deepLinkReturnFocus = null;
  }
}

// Confirm UI for deep links: shows the validated source plus provenance
// (envelope version, hint, reception channel). Confirm starts the normal
// `start_job` flow; decline dismisses with no effect. Uses the shared modal
// geometry (backdrop + card, architectural radius) so the dialog matches the
// parchment/walnut theme with no nested status card.
//
// Accessibility: role dialog with aria-modal, labelledby/describedby, Escape
// dismisses, Tab traps inside the dialog, focus starts on the confirm action
// and returns to the opener on close. Both actions are native buttons with
// the crisp 2px architectural focus ring (never a neon halo).
function showDeepLinkConfirm(info: ValidatedDeepLink): void {
  if (typeof document === "undefined") return;
  dismissDeepLinkConfirm(false);
  const doc = document;
  deepLinkReturnFocus = activeElementOf(doc);
  const overlay = doc.createElement("div");
  overlay.id = "dz-deep-link-confirm";
  overlay.className = "dz-modal-backdrop";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-labelledby", "dz-deep-link-title");
  overlay.setAttribute("aria-describedby", "dz-deep-link-desc");
  const card = doc.createElement("div");
  card.className = "dz-modal-card";
  const title = doc.createElement("h2");
  title.className = "dz-modal-title";
  title.id = "dz-deep-link-title";
  title.tabIndex = -1;
  title.textContent = "Another app wants to open an image in Dezoomify.";
  const source = doc.createElement("p");
  source.className = "dz-modal-subtitle";
  source.id = "dz-deep-link-desc";
  source.textContent = `Source: ${info.sourceUrl}`;
  const provenance = doc.createElement("p");
  provenance.className = "dz-notice-message";
  provenance.textContent =
    `Provenance: dezoomify:// link (v${info.version})` + (info.hint ? ` · ${info.hint}` : "");
  const note = doc.createElement("p");
  note.className = "dz-notice-message";
  note.textContent = "Nothing runs until you confirm. Declining does nothing.";
  const row = doc.createElement("div");
  row.className = "dz-modal-actions";
  const declineButton = doc.createElement("button");
  declineButton.type = "button";
  declineButton.className = "dz-btn-secondary";
  declineButton.textContent = "Dismiss";
  const close = (): void => {
    doc.removeEventListener("keydown", onKeyDown, true);
    dismissDeepLinkConfirm(true);
  };
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    if (e.key !== "Tab") return;
    const focusables = focusableIn(overlay);
    if (focusables.length === 0) {
      e.preventDefault();
      return;
    }
    const first = focusables[0] as HTMLElement;
    const last = focusables[focusables.length - 1] as HTMLElement;
    const active = doc.activeElement as HTMLElement | null;
    if (e.shiftKey) {
      if (active === first || !overlay.contains(active)) {
        e.preventDefault();
        last.focus();
      }
    } else if (active === last) {
      e.preventDefault();
      first.focus();
    }
  };
  declineButton.addEventListener("click", close);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  doc.addEventListener("keydown", onKeyDown, true);
  const confirmButton = doc.createElement("button");
  confirmButton.type = "button";
  confirmButton.className = "dz-btn-tactile";
  confirmButton.textContent = "Open image";
  confirmButton.addEventListener("click", () => {
    doc.removeEventListener("keydown", onKeyDown, true);
    dismissDeepLinkConfirm(true);
    handleSubmitUrl(info.sourceUrl);
  });
  row.append(declineButton, confirmButton);
  card.append(title, source, provenance, note, row);
  overlay.appendChild(card);
  doc.body.appendChild(overlay);
  if (typeof confirmButton.focus === "function") {
    confirmButton.focus();
  }
}

function handleDesktopEvent(channel: DesktopEventChannel, raw: unknown): void {
  const table = asPayload(raw);
  assertNoTileBytes(table);
  const payload = redactForEvent(table);

  if (channel === "dezoomify://deep-link-pending") {
    // Deep links never auto-start: validate again in the frontend, then wait
    // for explicit user confirmation (source + provenance). Declining, or a
    // rejected payload, performs no effect.
    const validated = validateDeepLinkPayload(payload);
    if (validated) {
      showDeepLinkConfirm(validated);
    }
    return;
  }

  // Stale-job guard: events for a job we are no longer following are
  // ignored. A submit retires the previous job id so its late events can
  // never be mistaken for the new job, even before the new id is known.
  const job = payloadJob(payload);
  if (job && job === retiredJobId && job !== currentJobId) return;
  if (job && currentJobId && job !== currentJobId) return;
  if (job && !currentJobId && !retiredJobId) {
    currentJobId = job;
  } else if (job && !currentJobId && retiredJobId && job !== retiredJobId) {
    currentJobId = job;
    retiredJobId = null;
  } else if (job && !currentJobId) {
    return;
  }

  // Stale-seq guard: per-job monotonic IPC seq; old or reordered events are
  // ignored. Events without a seq still apply (command responses and legacy
  // payloads carry none).
  const remoteSeq = payloadSeq(payload);
  const seqKey = job ?? currentJobId ?? "";
  if (remoteSeq !== null && seqKey !== "") {
    const seen = remoteSeqByJob[seqKey] ?? 0;
    if (remoteSeq <= seen) return;
    remoteSeqByJob[seqKey] = remoteSeq;
    const keys = Object.keys(remoteSeqByJob);
    if (keys.length > 8) {
      for (const k of keys) {
        if (k !== seqKey && k !== (currentJobId ?? "")) delete remoteSeqByJob[k];
      }
    }
  }

  // Exactly-once terminal: once the controller reaches completed, cancelled,
  // or failed, later job events are ignored (the controller itself also
  // rejects post-terminal transitions; this additionally freezes progress,
  // activity, and diagnostics at the terminal snapshot).
  if (isTerminalStatus(controller.getState().status)) return;

  const text = `${channel} ${payloadText(payload)}`.toLowerCase();
  const kind = typeof payload["kind"] === "string" ? (payload["kind"] as string).toLowerCase() : "";
  const detailRaw = strField(payload, ["detail"]) ?? "";
  const detailObj = detailRaw !== "" ? parseDetailObject(detailRaw) : null;

  // Recovery-requested (destination / partial): surface typed choices and
  // wait for the user. Nothing is auto-answered and no terminal is
  // dispatched here.
  // `flat` strips hyphens/underscores so PascalCase engine states
  // (`AwaitingRecovery`, `AwaitingPartialDecision`, ...) match the same
  // branches as kebab-case (`awaiting-recovery`, ...).
  const flat = text.replace(/[-_]/g, "");
  if (
    kind === "recovery-requested" ||
    text.indexOf("recovery-requested") >= 0 ||
    text.indexOf("request-decision") >= 0 ||
    text.indexOf("awaiting-recovery") >= 0 ||
    flat.indexOf("awaitingrecovery") >= 0 ||
    text.indexOf("awaitingpartialdecision") >= 0 ||
    flat.indexOf("awaitingpartialdecision") >= 0 ||
    text.indexOf("awaiting-partial") >= 0 ||
    flat.indexOf("awaitingpartial") >= 0
  ) {
    const reason = payloadReason(payload, text) ?? "destination";
    const recovery =
      strField(payload, ["recovery", "recoveryId", "recovery_id"]) ??
      (detailObj ? strField(detailObj, ["recovery", "recoveryId", "recovery_id"]) : undefined);
    const attempt =
      strField(payload, ["attempt", "attemptId", "attempt_id"]) ??
      (detailObj ? strField(detailObj, ["attempt", "attemptId", "attempt_id"]) : undefined);
    const missing = reason === "partial" ? extractMissingTiles(payload, detailObj, detailRaw) : [];
    const failedCount =
      numField(payload, detailRaw, ["failed", "failedRequests", "failures"]) ??
      (detailObj ? numField(detailObj, "", ["failed", "failedRequests", "failures"]) : undefined);
    const totalCount =
      numField(payload, detailRaw, ["total", "tiles", "tileCount"]) ??
      (detailObj ? numField(detailObj, "", ["total", "tiles", "tileCount"]) : undefined);
    pendingDecision = {
      kind: reason === "partial" ? "partial-recovery" : "destination-recovery",
      reason,
      ...(recovery ? { recovery } : {}),
      ...(attempt ? { attempt } : {}),
      ...(reason === "partial" ? { missingTiles: missing } : {}),
      ...(typeof failedCount === "number" ? { failedCount } : {}),
      ...(typeof totalCount === "number" ? { totalCount } : {}),
    };
    if (reason === "partial") {
      const summary = formatMissingSummary(missing, failedCount);
      setStep("Some tiles could not be saved…", "Choose whether to keep the partial image, discard it, or retry.");
      pushLog(`Recovery requested: partial (${summary} keep-partial / discard-partial / retry)`);
      if (typeof failedCount === "number") {
        const a = activity();
        a.failedRequests = failedCount;
        a.now = Date.now();
      }
    } else {
      setStep("Choose where to save…", "The save destination needs attention before the job can continue.");
      pushLog("Recovery requested: destination (choose-output / retry)");
    }
    update();
    return;
  }

  // Failure: typed StructuredError with code, category, retryable, message,
  // detail, transport, and phase. The engine technical chain arrives in
  // detail; the first message stays a plain actionable sentence.
  if (
    channel === "dezoomify://job-error" ||
    kind === "failed" ||
    text.indexOf("fail") >= 0
  ) {
    if (kind === "progress" || kind === "downloading" || kind === "discovery" || kind === "encoding") {
      // Progress detail text never signals failure; fall through.
    } else {
      const detailCode = detailObj ? strField(detailObj, ["code"]) : undefined;
      let code = strField(payload, ["code"]) ?? detailCode ?? "JOB_FAILED";
      let message =
        strField(payload, ["message"]) ??
        (detailObj ? strField(detailObj, ["message"]) : undefined);
      let detail: string | undefined;
      if (detailRaw !== "") {
        if (detailObj) {
          detail = detailCode && message ? detailRaw : undefined;
          if (!message) {
            message = detailCode ? detailRaw : undefined;
          }
        } else if (message) {
          detail = detailRaw;
        } else {
          // "code: message" technical chains split back into typed fields.
          const split = detailRaw.indexOf(":");
          if (split > 0 && split < 80) {
            const maybeCode = detailRaw.slice(0, split).trim();
            const maybeMessage = detailRaw.slice(split + 1).trim();
            if (maybeCode && maybeMessage && /^[a-z0-9][a-z0-9._-]*$/i.test(maybeCode)) {
              code = maybeCode;
              message = maybeMessage;
              detail = detailRaw;
            } else {
              message = detailRaw;
            }
          } else {
            message = detailRaw;
          }
        }
      }
      if (!message) message = "The job failed.";
      // A "code: message" detail that duplicates the message adds no
      // technical value; keep detail only when it carries more.
      if (detail === message) detail = undefined;
      const transport = strField(payload, ["transport"]) ?? NATIVE_TRANSPORT;
      const phase = strField(payload, ["phase"]) ?? phaseFor(code);
      // Stable backend verdicts ride the payload (phase/transport/resource-kind
      // plus retryable); the frontend never recomputes them from messages.
      const rawRetryable = payload["retryable"];
      const retryable = typeof rawRetryable === "boolean" ? rawRetryable : undefined;
      const resourceKind =
        strField(payload, ["resource-kind", "resource_kind", "resourceKind"]) ??
        (detailObj ? strField(detailObj, ["resource-kind", "resource_kind", "resourceKind"]) : undefined);
      const failedCount = numField(payload, `${kind} ${detailRaw}`, ["failed", "failedRequests", "failures"]);
      if (typeof failedCount === "number") {
        const a = activity();
        a.failedRequests = failedCount;
        a.now = Date.now();
      }
      dispatchFail(code, message, {
        transport,
        phase,
        ...(typeof retryable === "boolean" ? { retryable } : {}),
        ...(resourceKind ? { resourceKind } : {}),
        ...(detail ? { detail } : {}),
      });
      return;
    }
  }
  if (kind === "error" || text.indexOf("error") >= 0) {
    const code = strField(payload, ["code"]) ?? "JOB_FAILED";
    const message = strField(payload, ["message"]) ?? (detailRaw !== "" ? detailRaw : "The job failed.");
    const transport = strField(payload, ["transport"]) ?? NATIVE_TRANSPORT;
    const rawRetryable = payload["retryable"];
    const retryable = typeof rawRetryable === "boolean" ? rawRetryable : undefined;
    const resourceKind = strField(payload, ["resource-kind", "resource_kind", "resourceKind"]);
    dispatchFail(code, message, {
      transport,
      phase: strField(payload, ["phase"]) ?? phaseFor(code),
      ...(typeof retryable === "boolean" ? { retryable } : {}),
      ...(resourceKind ? { resourceKind } : {}),
    });
    return;
  }

  // Cancellation echoes back through job-state; clamp to one transition.
  // Intermediate cleaning states keep the loading view with a cleanup note;
  // only an acknowledged cancelled terminal reaches cancelled, after the
  // shell has removed uncommitted output.
  if (
    kind === "cancelled" ||
    text.indexOf("cancelled") >= 0 ||
    text.indexOf("canceled") >= 0
  ) {
    if (isTerminalStatus(controller.getState().status)) return;
    controller.dispatch({ seq: nextSeq(), sessionId, kind: "cancel" });
    pushLog("Cancelled; unfinished file removed");
    pendingDecision = null;
    stopHeartbeat();
    update();
    return;
  }
  if (kind === "cancelling" || text.indexOf("cancelling") >= 0 || text.indexOf("cleaning") >= 0) {
    setStep("Working…", "Cleaning up… removing unfinished file…");
    update();
    return;
  }
  if (text.indexOf("cancel") >= 0) {
    if (kind === "progress" || kind === "downloading" || kind === "discovery" || kind === "encoding") {
      // Progress text never signals cancellation; fall through.
    } else {
      setStep("Working…", "Cleaning up… removing unfinished file…");
      update();
      return;
    }
  }

  // Completion: output digest plus optional geometry. Only positive geometry
  // becomes completedInfo (the view renders "W by H" verbatim); the mime
  // falls back to the granted encoder. A partial-completed terminal stays
  // distinguishable: the aux panel marks the partial output and its missing
  // tiles instead of claiming a complete save.
  if (
    channel === "dezoomify://job-output" ||
    kind === "completed" ||
    kind === "partial-completed" ||
    kind === "output" ||
    text.indexOf("complet") >= 0 ||
    (text.indexOf("output") >= 0 && kind !== "progress")
  ) {
    const isPartial =
      kind === "partial-completed" ||
      text.indexOf("partial-completed") >= 0 ||
      text.indexOf("partial completed") >= 0;
    const width =
      numField(payload, detailRaw, ["width", "imageWidth", "w"]) ??
      (detailObj
        ? numField(detailObj, "", ["width", "imageWidth", "w"])
        : undefined);
    const height =
      numField(payload, detailRaw, ["height", "imageHeight", "h"]) ??
      (detailObj
        ? numField(detailObj, "", ["height", "imageHeight", "h"])
        : undefined);
    const mime = encoderToMime(
      strField(payload, ["mime", "mimeType", "contentType", "encoder", "format"]) ??
        (detailObj ? strField(detailObj, ["mime", "mimeType", "contentType", "encoder", "format"]) : undefined),
      grantedMime(),
    );
    const outputHash = strField(payload, ["outputHash", "output_hash", "output", "digest"]);
    const missing = isPartial ? extractMissingTiles(payload, detailObj, detailRaw) : [];
    if (outputHash) {
      const short = outputHash.slice(0, 24);
      pushLog(isPartial ? `Partial output ready (${short}…)` : `Output ready (${short}…)`);
    }
    completeJob(
      typeof width === "number" && typeof height === "number" && width > 0 && height > 0
        ? { width, height, mime }
        : undefined,
      isPartial,
      missing,
    );
    return;
  }

  // Save destination granted on the host side (request_destination emits a
  // destination event): record the format and walk into saving. The user
  // grant itself arrives via requestOutputAndResume; this covers host-side
  // grants observed as events.
  if (kind === "destination" || text.indexOf("destination") >= 0) {
    if (text.indexOf("denied") >= 0) {
      dispatchFail("OUTPUT_DENIED", "The save destination was denied.");
      return;
    }
    const format = strField(payload, ["format"]) ?? detailRaw;
    if (format === "png" || format === "jpeg" || format === "tiff") grantedFormat = format;
    if (text.indexOf("awaiting") >= 0 || text.indexOf("request-destination") >= 0) {
      if (!pendingDecision) {
        pendingDecision = { kind: "destination-request", reason: "destination" };
      }
      setStep("Choose where to save…", "Pick the output file to continue.");
      pushLog("Save destination requested");
      update();
      return;
    }
    ensureChosenThroughPreflight(
      numField(payload, detailRaw, ["imageCount", "images", "count"]),
    );
    controller.dispatch({ seq: nextSeq(), sessionId, kind: "save-start" });
    setStep("Assembling the final picture…", "Encoding in the native app");
    update();
    return;
  }

  // Catalog / image selection: the native pipeline auto-saves images[0] at
  // the largest fitting level. Record the honest auto-choice notice in local
  // aux (pendingDecision pattern, no protocol event); the shared job view
  // renders "Found N images, saving largest that fits (WxH, K tiles)".
  if (
    kind === "catalog" ||
    kind === "images-found" ||
    text.indexOf("images-found") >= 0 ||
    text.indexOf("awaiting-choice") >= 0 ||
    flat.indexOf("awaitingchoice") >= 0 ||
    text.indexOf("awaiting-image") >= 0 ||
    flat.indexOf("awaitingimage") >= 0 ||
    flat.indexOf("awaitingimageselection") >= 0 ||
    text.indexOf("choosing") >= 0
  ) {
    const found = numField(payload, detailRaw, ["imageCount", "images", "count"]);
    controller.dispatch({
      seq: nextSeq(),
      sessionId,
      kind: "images-found",
      ...(found !== undefined ? { imageCount: found } : {}),
      transport: NATIVE_TRANSPORT,
    });
    if (found !== undefined) {
      catalogNotice = { ...(catalogNotice ?? {}), imageCount: found };
    } else if (!catalogNotice && controller.getState().imageCount > 0) {
      catalogNotice = { imageCount: controller.getState().imageCount };
    }
    const noun = (catalogNotice?.imageCount ?? found ?? 0) === 1
      ? "1 image"
      : `${catalogNotice?.imageCount ?? found ?? 0} images`;
    if ((catalogNotice?.imageCount ?? found ?? 0) > 0) {
      pushLog(`Found ${noun}; auto-saving largest that fits`);
      setStep(
        `Found ${noun}, saving largest that fits…`,
        "The app saves the first image automatically; no picker is offered.",
      );
    } else {
      setStep("Image found; picking the best one…");
    }
    update();
    return;
  }

  // Level selection offered: record image-chosen (legal from
  // choosing-image), then wait for the running signal before level-chosen.
  if (
    kind === "levels" ||
    text.indexOf("levels") >= 0 ||
    flat.indexOf("levels") >= 0 ||
    text.indexOf("awaiting-level") >= 0 ||
    flat.indexOf("awaitinglevel") >= 0
  ) {
    controller.dispatch({ seq: nextSeq(), sessionId, kind: "image-chosen" });
    setStep("Choosing the highest resolution…");
    update();
    return;
  }

  // Display-only preview: no bytes will be readable, so no save is offered.
  if (text.indexOf("display-only") >= 0 || text.indexOf("display_only") >= 0) {
    if (isTerminalStatus(controller.getState().status)) return;
    ensureChosenThroughPreflight(
      numField(payload, detailRaw, ["imageCount", "images", "count"]),
    );
    controller.dispatch({ seq: nextSeq(), sessionId, kind: "preflight-display-only" });
    setStep("Display-only preview…", "This picture can only be viewed here.");
    pushLog("Display-only preview");
    update();
    return;
  }

  // Progress snapshots: discovery (resources), downloading (acquired/total),
  // encoding. Each ensures the selection chain first so a progress signal
  // alone walks discovering -> downloading.
  if (
    channel === "dezoomify://job-progress" ||
    kind === "progress" ||
    kind === "downloading" ||
    kind === "discovery" ||
    kind === "encoding" ||
    text.indexOf("progress") >= 0 ||
    numField(payload, detailRaw, ["acquired", "completed", "current", "done"]) !== undefined
  ) {
    const current =
      numField(payload, detailRaw, ["current", "acquired", "completed", "done", "resources"]) ?? 0;
    const total = numField(payload, detailRaw, ["total"]) ?? 0;
    const message = strField(payload, ["message"]);
    const progressCount = numField(payload, detailRaw, ["imageCount", "images", "count"]);
    ensureChosenThroughPreflight(progressCount);
    if (progressCount !== undefined || total > 0) {
      const prevCount = catalogNotice?.imageCount ?? controller.getState().imageCount ?? 0;
      catalogNotice = {
        ...(catalogNotice ?? {}),
        imageCount: progressCount ?? prevCount,
        ...(total > 0 ? { tiles: total } : {}),
      };
    }
    viewCtx.currentProgress = { current, total, ...(message ? { message } : {}) };
    noteProgress(current, total);
    if (kind === "discovery" || text.indexOf("discover") >= 0) {
      setStep("Finding the zoomable image…", `Contacting ${hostOf(lastInputUrl || activity().url || "")}…`);
    } else if (kind === "encoding" || text.indexOf("encod") >= 0) {
      setStep("Assembling the final picture…", "Encoding in the native app");
    } else {
      setStep(
        "Saving image tiles…",
        total > 0 ? `${current} of ${total} tiles at full resolution` : undefined,
      );
    }
    controller.dispatch({ seq: nextSeq(), sessionId, kind: "progress" });
    update();
    return;
  }

  // Running / planning / acquisition phases without counts.
  if (
    kind === "job-state" ||
    text.indexOf("running") >= 0 ||
    text.indexOf("downloading") >= 0 ||
    text.indexOf("acquiring") >= 0 ||
    text.indexOf("planning") >= 0 ||
    text.indexOf("processing") >= 0 ||
    text.indexOf("discovering") >= 0 ||
    text.indexOf("job-state") >= 0
  ) {
    if (text.indexOf("running") >= 0 || text.indexOf("downloading") >= 0 || text.indexOf("acquiring") >= 0) {
      const runningCount = numField(payload, detailRaw, ["imageCount", "images", "count"]);
      ensureChosenThroughPreflight(runningCount);
      if (runningCount !== undefined && !catalogNotice) {
        catalogNotice = { imageCount: runningCount };
      }
      controller.dispatch({ seq: nextSeq(), sessionId, kind: "progress" });
      setStep("Saving image tiles…");
    } else if (text.indexOf("cancelling") >= 0 || text.indexOf("cleaning") >= 0) {
      setStep("Working…", "Cleaning up…");
    }
    update();
    return;
  }
  update();
}

function subscribeToDesktopEvents(): void {
  const listen = tauriListen();
  if (!listen) return;
  for (const channel of DESKTOP_EVENT_CHANNELS) {
    const name: DesktopEventChannel = channel;
    try {
      const maybe = listen(name, (event) => {
        const raw = (event as { payload?: unknown }).payload ?? event;
        try {
          handleDesktopEvent(name, raw);
        } catch {
          // Guards already threw for tile bytes; never break rendering.
        }
      });
      if (maybe && typeof (maybe as Promise<unknown>).catch === "function") {
        (maybe as Promise<unknown>).catch(() => undefined);
      }
    } catch {
      // No host listener available; validation-only fallback stays usable.
    }
  }
}

const viewCtx: ViewContext = {
  capabilities: {
    nativeAvailable: integration.getCapabilities().nativeAvailable,
    extensionAvailable: integration.getCapabilities().extensionAvailable,
    browserCanSave: integration.getCapabilities().browserCanSave,
    proxyAllowed: integration.getCapabilities().proxyAllowed,
  },
};

// Idle prefill is launch input only: set once at startup and on reset, never
// from a submitted job. The shared input section prefills the empty field
// from this value and never overwrites user typing.
function initInitialUrl(): void {
  const prefilled = readInitialUrl();
  if (prefilled) viewCtx.initialUrl = prefilled;
}

function syncInitialUrlFromLocation(): void {
  if (controller.getState().status !== "idle") return;
  const prefilled = readInitialUrl();
  const current = viewCtx.initialUrl;
  if (prefilled && prefilled !== current) {
    viewCtx.initialUrl = prefilled;
    update();
  } else if (!prefilled && current) {
    viewCtx.initialUrl = undefined;
    update();
  }
}

// Output format selector (todo 4.4): 3 native radios (PNG/JPEG/TIFF) bound
// to grantedFormat. Flat flow inside the aux panel, native inputs so Tab and
// screen readers work; the crisp 2px focus ring comes from desktop.css.
// Changing a radio only updates grantedFormat — requestOutputAndResume reads
// it when building { format, suggestedName } for requestSaveDestination.
function appendOutputFormatRadios(parent: HTMLElement, doc: Document): void {
  const group = doc.createElement("fieldset");
  group.id = "dz-output-format-group";
  group.className = "dz-actions-row";
  group.style.border = "none";
  group.style.padding = "0";
  group.style.margin = "0";
  const legend = doc.createElement("legend");
  legend.className = "dz-notice-message";
  legend.textContent = "Output format";
  group.appendChild(legend);
  for (const value of NATIVE_ENCODERS) {
    const label = doc.createElement("label");
    label.style.display = "inline-flex";
    label.style.alignItems = "center";
    label.style.gap = "0.35rem";
    label.style.marginRight = "1rem";
    const input = doc.createElement("input");
    input.type = "radio";
    input.name = "dz-output-format";
    input.value = value;
    if (normalizeNativeFormat(grantedFormat) === value) input.checked = true;
    input.addEventListener("change", () => {
      if (input.checked) grantedFormat = normalizeNativeFormat(input.value);
    });
    const text = doc.createElement("span");
    text.textContent = value === "png" ? "PNG" : value === "jpeg" ? "JPEG" : "TIFF";
    label.append(input, text);
    group.appendChild(label);
  }
  parent.appendChild(group);
}

// Desktop auxiliary panel: typed recovery choices, partial and cancelled
// notices, plus a copy-diagnostics button. The shared view owns the card
// layout; this panel is re-applied after every render (idempotent by stable
// id) so phase remounts cannot lose a pending decision, and in-place job
// updates keep it without flicker.
// Visuals stay flat inside the single status card: transparent flow with a
// top separator, left-aligned copy, theme buttons. Never a nested box.
//
// Accessibility (Task 5.2): the pending decision renders as an inline
// role="dialog" with aria-modal="false" (inline, not a modal overlay),
// labelledby/describedby, and an assertive description so screen readers
// announce recovery without a separate alert. A new decision moves focus to
// its primary button once; later ticks preserve the focused button instead
// of dropping focus. Resolving the decision returns focus to the opener.
// Tab cycles inside the decision buttons; Escape moves focus out to the job
// Cancel action (when present) without clearing the decision, since recovery
// must keep waiting for an explicit choice. Partial and cancelled notes use
// role="status" with aria-live polite; the shared job view owns the single
// role="progressbar" with aria-valuenow/min/max, so no second progressbar
// lives here. All buttons are native and keyboard reachable.
function ensureDesktopAuxPanel(): void {
  if (typeof document === "undefined" || !root) return;
  const state = controller.getState();
  const doc = root.ownerDocument;
  const decision = pendingDecision;
  const decisionKey = recoveryKeyFor(decision);
  const prevKey = lastRecoveryKey;
  const existing = doc.getElementById("dz-desktop-aux");
  const focusedInside = existing && existing.contains(doc.activeElement)
    ? (doc.activeElement as HTMLElement)
    : null;
  const focusedLabel = focusedInside && focusedInside instanceof HTMLButtonElement
    ? focusedInside.textContent
    : null;
  const focusedFormat =
    focusedInside &&
    focusedInside instanceof HTMLInputElement &&
    focusedInside.type === "radio" &&
    focusedInside.name === "dz-output-format"
      ? focusedInside.value
      : null;
  if (decisionKey && decisionKey !== prevKey && !recoveryReturnFocus) {
    const opener = activeElementOf(doc);
    recoveryReturnFocus = opener && existing?.contains(opener) ? null : opener;
    if (recoveryReturnFocus === null && opener && !existing?.contains(opener)) {
      recoveryReturnFocus = opener;
    }
    if (existing && existing.contains(opener as Node) && prevKey === null) {
      recoveryReturnFocus = null;
    }
  }
  existing?.remove();
  const showCopy = state.status !== "idle";
  const showPartialDone = state.status === "completed" && completedPartial;
  const showCancelledNote = state.status === "cancelled";
  if (!decision && !showCopy && !showPartialDone && !showCancelledNote) {
    if (prevKey !== null) {
      restoreFocus(recoveryReturnFocus);
      recoveryReturnFocus = null;
    }
    lastRecoveryKey = decisionKey;
    return;
  }
  const card = root.querySelector(".dz-card");
  if (!card) {
    lastRecoveryKey = decisionKey;
    return;
  }

  const aux = doc.createElement("div");
  aux.id = "dz-desktop-aux";
  aux.className = "dz-view-body dz-desktop-aux";
  aux.setAttribute("role", "region");
  aux.setAttribute("aria-label", "Desktop job actions");
  appendOutputFormatRadios(aux, doc);

  let decisionBox: HTMLElement | null = null;

  if (decision) {
    decisionBox = doc.createElement("div");
    decisionBox.className = "dz-recovery-dialog";
    decisionBox.setAttribute("role", "dialog");
    decisionBox.setAttribute("aria-modal", "false");
    decisionBox.setAttribute("aria-labelledby", "dz-recovery-title");
    decisionBox.setAttribute("aria-describedby", "dz-recovery-desc");
    const title = doc.createElement("h2");
    title.className = "dz-notice-title";
    title.id = "dz-recovery-title";
    title.tabIndex = -1;
    const desc = doc.createElement("p");
    desc.className = "dz-notice-message";
    desc.id = "dz-recovery-desc";
    desc.setAttribute("aria-live", "assertive");
    const row = doc.createElement("div");
    row.className = "dz-actions-row";

    function addButton(label: string, primary: boolean, onClick: () => void): void {
      const btn = doc.createElement("button");
      btn.type = "button";
      btn.className = primary ? "dz-btn-tactile" : "dz-btn-secondary";
      btn.textContent = label;
      btn.addEventListener("click", onClick);
      row.appendChild(btn);
    }

    if (decision.kind === "partial-recovery") {
      title.textContent = "Some tiles could not be saved";
      const missing = decision.missingTiles ?? [];
      const summary = formatMissingSummary(missing, decision.failedCount);
      desc.textContent =
        `Part of the image is missing. ${summary} Keep the partial image` +
        ` (blank areas stay empty), discard it, or retry the failed tiles.`;
      decisionBox.append(title, desc);
      if (missing.length > 0) {
        const list = doc.createElement("p");
        list.className = "dz-notice-message dz-missing-list";
        const shown = missing.slice(0, 20).join(", ");
        const rest = missing.length > 20 ? ` and ${missing.length - 20} more` : "";
        list.textContent = `Missing tiles: ${shown}${rest}.`;
        decisionBox.appendChild(list);
      }
      decisionBox.appendChild(row);
      addButton("Keep partial image", true, () => handlePartialChoice(true));
      addButton("Discard partial", false, () => handlePartialChoice(false));
      addButton("Retry failed tiles", false, () => handleRecoveryRetry());
    } else if (decision.kind === "destination-recovery") {
      title.textContent = "Save destination needs attention";
      desc.textContent =
        "The save destination was not accepted. Choose an output file, try again, or use another app.";
      decisionBox.append(title, desc, row);
      addButton("Choose output…", true, () => requestOutputAndResume("choose-output"));
      addButton("Try again", false, () => handleRecoveryRetry());
      addButton("Use another app", false, () => handleHandoffToNative());
    } else {
      title.textContent = "Choose where to save";
      desc.textContent = "Pick the output file to continue saving this image.";
      decisionBox.append(title, desc, row);
      addButton("Choose output…", true, () => requestOutputAndResume("choose-output"));
      addButton("Use another app", false, () => handleHandoffToNative());
    }
    decisionBox.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        const cancelBtn = doc.getElementById("dz-btn-cancel") as HTMLElement | null;
        if (cancelBtn && typeof cancelBtn.focus === "function") cancelBtn.focus();
        else {
          const firstOutside = focusableIn(aux).filter((el) => !decisionBox?.contains(el))[0];
          if (firstOutside) firstOutside.focus();
        }
        return;
      }
      if (e.key !== "Tab") return;
      const box = decisionBox as HTMLElement;
      const focusables = focusableIn(box);
      if (focusables.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusables[0] as HTMLElement;
      const last = focusables[focusables.length - 1] as HTMLElement;
      const active = doc.activeElement as HTMLElement | null;
      if (e.shiftKey) {
        if (active === first || !box.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else if (active === last) {
        e.preventDefault();
        first.focus();
      }
    });
    aux.appendChild(decisionBox);
  }

  if (showPartialDone) {
    const doneBox = doc.createElement("div");
    doneBox.className = "dz-partial-note";
    doneBox.setAttribute("role", "status");
    doneBox.setAttribute("aria-live", "polite");
    const title = doc.createElement("h2");
    title.className = "dz-notice-title";
    title.textContent = "Partial image saved";
    const desc = doc.createElement("p");
    desc.className = "dz-notice-message";
    const summary = formatMissingSummary(completedMissing, completedMissing.length);
    desc.textContent =
      `This file is marked as partial: ${summary} Missing areas are left` +
      ` blank. This distinguishes it from a complete save.`;
    doneBox.append(title, desc);
    if (completedMissing.length > 0) {
      const list = doc.createElement("p");
      list.className = "dz-notice-message dz-missing-list";
      const shown = completedMissing.slice(0, 20).join(", ");
      const rest = completedMissing.length > 20 ? ` and ${completedMissing.length - 20} more` : "";
      list.textContent = `Missing tiles: ${shown}${rest}.`;
      doneBox.appendChild(list);
    }
    aux.appendChild(doneBox);
  }

  if (showCancelledNote) {
    const note = doc.createElement("p");
    note.className = "dz-notice-message";
    note.id = "dz-cancel-cleanup-note";
    note.setAttribute("role", "status");
    note.setAttribute("aria-live", "polite");
    note.textContent = "Save cancelled. Cleanup is done and any unfinished file was removed.";
    aux.appendChild(note);
  }

  if (showCopy) {
    const copyRow = doc.createElement("div");
    copyRow.className = "dz-actions-row";
    const copyBtn = doc.createElement("button");
    copyBtn.type = "button";
    copyBtn.id = "dz-btn-copy-diag";
    copyBtn.className = "dz-btn-secondary";
    copyBtn.textContent = "Copy diagnostics";
    copyBtn.addEventListener("click", () => handleCopyDiagnostics());
    copyRow.appendChild(copyBtn);
    aux.appendChild(copyRow);
  }

  card.appendChild(aux);
  if (decisionKey && decisionKey !== prevKey) {
    const primary = decisionBox?.querySelector("button.dz-btn-tactile") as HTMLElement | null;
    if (primary && typeof primary.focus === "function") primary.focus();
    else {
      const firstBtn = decisionBox ? focusableIn(decisionBox)[0] : undefined;
      if (firstBtn) firstBtn.focus();
    }
  } else if (focusedFormat) {
    const radio = aux.querySelector(
      `input[name="dz-output-format"][value="${focusedFormat}"]`,
    ) as HTMLElement | null;
    if (radio && typeof radio.focus === "function") radio.focus();
  } else if (focusedLabel && decisionBox) {
    const candidates = focusableIn(decisionBox);
    for (const candidate of candidates) {
      if (candidate.textContent === focusedLabel && typeof candidate.focus === "function") {
        candidate.focus();
        break;
      }
    }
  } else if (focusedLabel) {
    const candidates = focusableIn(aux);
    for (const candidate of candidates) {
      if (candidate.textContent === focusedLabel && typeof candidate.focus === "function") {
        candidate.focus();
        break;
      }
    }
  }
  if (!decisionKey && prevKey !== null) {
    restoreFocus(recoveryReturnFocus);
    recoveryReturnFocus = null;
  }
  lastRecoveryKey = decisionKey;
}

// Minimal settings panel: simple section inside the single status card,
// re-applied after every render by stable id. Skips re-render while focus
// sits inside the panel so typing never loses focus. All values validate
// fail-closed; header values never enter logs or diagnostics.
//
// Accessibility: region labelled by its heading, every input wrapped in an
// explicit label (name + control), browse buttons carry distinct aria-labels
// so the two "Browse" actions stay distinguishable, and validation errors
// use role="alert" with aria-live assertive. All controls are native and Tab
// reachable with the crisp 2px focus ring.
function ensureDesktopSettingsPanel(): void {
  if (typeof document === "undefined" || !root) return;
  const card = root.querySelector(".dz-card");
  if (!card) return;
  const existing = document.getElementById("dz-desktop-settings");
  if (existing && existing.contains(document.activeElement)) return;
  existing?.remove();

  const doc = root.ownerDocument;
  const panel = doc.createElement("div");
  panel.id = "dz-desktop-settings";
  panel.className = "dz-view-body dz-desktop-settings";
  panel.setAttribute("role", "region");
  panel.setAttribute("aria-labelledby", "dz-settings-title");

  const title = doc.createElement("h2");
  title.className = "dz-notice-title";
  title.id = "dz-settings-title";
  title.textContent = "Settings";
  const desc = doc.createElement("p");
  desc.className = "dz-notice-message";
  desc.textContent =
    "Minimal download settings. Saved on this device and used for the next job. Headers are sent to the image origin only and never logged.";
  panel.append(title, desc);

  const form = doc.createElement("div");
  form.className = "dz-settings-form";

  function addLabeledInput(
    id: string,
    label: string,
    value: string,
    opts: { inputMode?: string; placeholder?: string; type?: string },
  ): HTMLInputElement {
    const wrap = doc.createElement("label");
    wrap.className = "dz-settings-field";
    wrap.setAttribute("for", id);
    const span = doc.createElement("span");
    span.textContent = label;
    const input = doc.createElement("input");
    input.id = id;
    input.name = id;
    input.type = opts.type ?? "text";
    if (opts.inputMode) input.inputMode = opts.inputMode;
    if (opts.placeholder) input.placeholder = opts.placeholder;
    input.value = value;
    input.addEventListener("change", () => persistSettingsFromPanel());
    wrap.append(span, input);
    form.appendChild(wrap);
    return input;
  }

  const outputInput = addLabeledInput(
    "dz-settings-output-dir",
    "Output directory (optional)",
    desktopSettings.outputDir ?? "",
    { placeholder: "/home/you/Pictures" },
  );
  const compressionInput = addLabeledInput(
    "dz-settings-compression",
    "Compression 0-100 (default 5)",
    String(desktopSettings.compression),
    { inputMode: "numeric" },
  );
  const maxWidthInput = addLabeledInput(
    "dz-settings-max-width",
    "Max width px (optional)",
    desktopSettings.maxWidth === null ? "" : String(desktopSettings.maxWidth),
    { inputMode: "numeric", placeholder: "empty = largest" },
  );
  const maxHeightInput = addLabeledInput(
    "dz-settings-max-height",
    "Max height px (optional)",
    desktopSettings.maxHeight === null ? "" : String(desktopSettings.maxHeight),
    { inputMode: "numeric", placeholder: "empty = largest" },
  );
  const retriesInput = addLabeledInput(
    "dz-settings-retries",
    "Retries 0-100 (default 3, 0 = none)",
    String(desktopSettings.retries),
    { inputMode: "numeric" },
  );
  const cacheInput = addLabeledInput(
    "dz-settings-cache-dir",
    "Cache directory (optional resume cache)",
    desktopSettings.cacheDir ?? "",
    { placeholder: "/home/you/.cache/dezoomify" },
  );
  void compressionInput;
  void maxWidthInput;
  void maxHeightInput;
  void retriesInput;

  function addBrowseButton(forInput: HTMLInputElement, label: string): void {
    const btn = doc.createElement("button");
    btn.type = "button";
    btn.className = "dz-btn-secondary";
    btn.textContent = "Browse…";
    btn.setAttribute("aria-label", label);
    btn.addEventListener("click", () => {
      void pickDirectory(forInput.value || null).then((picked) => {
        if (picked) {
          forInput.value = picked;
          persistSettingsFromPanel();
          try {
            forInput.focus();
          } catch {
            // Focus restore is best effort.
          }
        } else {
          try {
            btn.focus();
          } catch {
            // Keep focus where it is when the picker cancels.
          }
        }
      });
    });
    form.appendChild(btn);
  }
  addBrowseButton(outputInput, "Browse for output directory");
  addBrowseButton(cacheInput, "Browse for cache directory");

  const headersLabel = doc.createElement("label");
  headersLabel.className = "dz-settings-field";
  headersLabel.setAttribute("for", "dz-settings-headers");
  const headersSpan = doc.createElement("span");
  headersSpan.textContent = "Request headers, one per line as Name: value (optional, trusted)";
  const headersInput = doc.createElement("textarea");
  headersInput.id = "dz-settings-headers";
  headersInput.name = "dz-settings-headers";
  headersInput.rows = 3;
  headersInput.placeholder = "Referer: https://example.com/viewer";
  headersInput.value = Object.entries(desktopSettings.headers)
    .map(([name, value]) => `${name}: ${value}`)
    .join("\n");
  headersInput.addEventListener("change", () => persistSettingsFromPanel());
  headersLabel.append(headersSpan, headersInput);
  form.appendChild(headersLabel);

  panel.appendChild(form);

  if (settingsError) {
    const err = doc.createElement("p");
    err.className = "dz-notice-message";
    err.id = "dz-settings-error";
    err.setAttribute("role", "alert");
    err.setAttribute("aria-live", "assertive");
    err.textContent = settingsError;
    panel.appendChild(err);
  }

  const row = doc.createElement("div");
  row.className = "dz-actions-row";
  const resetBtn = doc.createElement("button");
  resetBtn.type = "button";
  resetBtn.className = "dz-btn-secondary";
  resetBtn.textContent = "Reset settings";
  resetBtn.addEventListener("click", () => resetDesktopSettings());
  row.appendChild(resetBtn);
  panel.appendChild(row);

  card.appendChild(panel);
}

// Pinned bottom footer: the static markup in index.html carries the five
// legal/repo links only. Wire its anchors to the native opener so remote
// content never navigates inside the privileged window. Idempotent.
function ensureDesktopFooter(): void {
  if (typeof document === "undefined") return;
  const footer = document.querySelector(".dz-site-footer");
  if (!footer) return;
  if (footer.getAttribute("data-dz-wired") === "true") return;
  footer.setAttribute("data-dz-wired", "true");
  footer.querySelectorAll("a[href]").forEach((anchor) => {
    anchor.addEventListener("click", (e) => {
      const href = anchor.getAttribute("href") ?? "";
      if (href.startsWith("https://")) {
        e.preventDefault();
        handleOpenExternalLink(href);
      }
    });
  });
}

function update() {
  if (!root) return;
  const state = controller.getState();
  const caps = integration.getCapabilities();
  if (viewCtx.jobActivity && !isTerminalStatus(state.status)) refreshLongestPending();
  const auxTiles = catalogNotice?.tiles ?? viewCtx.imageChoice?.tiles ?? viewCtx.currentProgress?.total;
  const auxWidth = catalogNotice?.width ?? viewCtx.imageChoice?.width ?? viewCtx.completedInfo?.width;
  const auxHeight = catalogNotice?.height ?? viewCtx.imageChoice?.height ?? viewCtx.completedInfo?.height;
  const auxChoice =
    catalogNotice || viewCtx.imageChoice || auxTiles !== undefined || auxWidth !== undefined
      ? {
          ...(typeof auxWidth === "number" ? { width: auxWidth } : {}),
          ...(typeof auxHeight === "number" ? { height: auxHeight } : {}),
          ...(typeof auxTiles === "number" ? { tiles: auxTiles } : {}),
        }
      : undefined;

  renderView(
    root,
    state,
    {
      onSubmitUrl(url: string) {
        handleSubmitUrl(url);
      },
      onCancel() {
        handleCancel();
      },
      onReset() {
        handleReset();
      },
      onSave() {
        handleSave();
      },
      onSelectImage(index: number) {
        handleSelectImage(index);
      },
      onSelectLevel(level: number) {
        handleSelectLevel(level);
      },
      onOpenExternalLink(url: string) {
        handleOpenExternalLink(url);
      },
    },
    {
      capabilities: {
        nativeAvailable: caps.nativeAvailable,
        extensionAvailable: caps.extensionAvailable,
        browserCanSave: caps.browserCanSave,
        proxyAllowed: caps.proxyAllowed,
      },
      ...(viewCtx.currentProgress ? { currentProgress: viewCtx.currentProgress } : {}),
      ...(viewCtx.completedInfo ? { completedInfo: viewCtx.completedInfo } : {}),
      ...(viewCtx.jobActivity ? { jobActivity: viewCtx.jobActivity } : {}),
      ...(viewCtx.initialUrl ? { initialUrl: viewCtx.initialUrl } : {}),
      ...(auxChoice ? { imageChoice: auxChoice } : {}),
    },
  );
  ensureDesktopAuxPanel();
  ensureDesktopSettingsPanel();
  ensureDesktopHelpAbout();
  ensureDesktopExternalNav();
  ensureDesktopFooter();
}

initInitialUrl();
subscribeToDesktopEvents();

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("hashchange", () => syncInitialUrlFromLocation());
}

if (root !== null) {
  update();
}

function getCurrentJobId(): string | null {
  return currentJobId;
}

function getSessionId(): string {
  return sessionId;
}

function getSeq(): number {
  return currentSeq;
}

function getPendingDecision(): PendingDecision | null {
  if (!pendingDecision) return null;
  return {
    ...pendingDecision,
    ...(pendingDecision.missingTiles ? { missingTiles: [...pendingDecision.missingTiles] } : {}),
  };
}

function getCatalogNotice(): { imageCount: number; width?: number; height?: number; tiles?: number } | null {
  return catalogNotice ? { ...catalogNotice } : null;
}

function getCompletedPartial(): boolean {
  return completedPartial;
}

function getCompletedMissing(): Array<string> {
  return [...completedMissing];
}

function getRemoteSeq(jobId: string): number {
  return remoteSeqByJob[jobId] ?? 0;
}

export {
  controller,
  integration,
  update,
  getCurrentJobId,
  getSessionId,
  getSeq,
  getPendingDecision,
  getCatalogNotice,
  getCompletedPartial,
  getCompletedMissing,
  getRemoteSeq,
  getEffectiveSettings,
  buildCopyDiagnostics,
  handleCopyDiagnostics,
  handleDesktopEvent,
  validateDeepLinkPayload,
  showDeepLinkConfirm,
  dismissDeepLinkConfirm,
};
