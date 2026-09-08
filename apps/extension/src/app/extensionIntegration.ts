/**
 * Extension `AppIntegration` (Phase 12).
 *
 * Host-neutral binding between the shared UI and the extension runtime/host
 * capabilities. Never touches native, extension globals, or raw browser APIs
 * directly: all effects (`startScan`, `fetchResource`, `requestNativeHandoff`)
 * are injected. Internal messages are validated with the `messages.ts`
 * envelope rules via an injected `validateMessage` (keeps this module
 * import-free for deterministic unit tests).
 *
 * Plain JavaScript + JSDoc.
 *
 * Status: covered by unit tests; the shipped modal drives the guarded session
 * fetcher directly. The integration remains host-neutral test infrastructure.
 */

/**
 * Create the extension integration.
 * @param {{
 *   validateMessage: (raw: unknown, ctx?: any) => { ok: boolean, code?: string },
 *   startScan?: () => Promise<any>,
 *   fetchResource?: (url: string, opts?: any) => Promise<any>,
 *   requestNativeHandoff?: (req: any) => Promise<any>,
 * }} deps
 */
interface ExtensionIntegrationDeps {
  validateMessage: (raw: unknown, ctx?: { currentScanId?: string | null; currentJobId?: string | null }) => { ok: boolean; code?: string };
  startScan?: () => Promise<unknown>;
  fetchResource?: (url: string, opts?: { userIntent: boolean }) => Promise<unknown>;
  requestNativeHandoff?: (req: unknown) => Promise<unknown>;
}

export function createExtensionIntegration(deps: ExtensionIntegrationDeps) {
  if (!deps || typeof deps.validateMessage !== "function") {
    throw new Error("validateMessage required");
  }
  /** @type {string|null} */
  let currentScanId: string | null = null;
  /** @type {string|null} */
  let currentJobId: string | null = null;

  function bind(scanId?: string | null, jobId?: string | null) {
    currentScanId = scanId ?? null;
    currentJobId = jobId ?? null;
  }

  /**
   * Handle an inbound internal message. Unknown/stale messages rejected.
   * @param {unknown} raw
   */
  async function handleMessage(raw: unknown) {
    const v = deps.validateMessage(raw, { currentScanId, currentJobId });
    if (!v.ok) return { ok: false, code: v.code ?? "rejected" };
    const msg = raw as { kind: string; payload?: unknown };
    switch (msg.kind) {
      case "StartScan":
        if (typeof deps.startScan !== "function") return { ok: false, code: "no-handler" };
        return { ok: true, result: await deps.startScan() };
      case "FetchResource": {
        if (typeof deps.fetchResource !== "function") return { ok: false, code: "no-handler" };
        const payload = (msg.payload ?? {}) as { url?: string };
        return { ok: true, result: await deps.fetchResource(String(payload.url ?? ""), { userIntent: true }) };
      }
      case "StartNativeHandoff":
        if (typeof deps.requestNativeHandoff !== "function") return { ok: false, code: "no-handler" };
        return { ok: true, result: await deps.requestNativeHandoff(msg.payload ?? {}) };
      default:
        // ScanStarted/CandidateFound/ScanSettled/... are notifications: accept.
        return { ok: true, notified: true };
    }
  }

  return { bind, handleMessage, getBinding: () => ({ currentScanId, currentJobId }) };
}
