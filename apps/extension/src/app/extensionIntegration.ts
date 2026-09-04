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
export function createExtensionIntegration(deps) {
  if (!deps || typeof deps.validateMessage !== "function") {
    throw new Error("validateMessage required");
  }
  /** @type {string|null} */
  let currentScanId = null;
  /** @type {string|null} */
  let currentJobId = null;

  function bind(scanId, jobId) {
    currentScanId = scanId ?? null;
    currentJobId = jobId ?? null;
  }

  /**
   * Handle an inbound internal message. Unknown/stale messages rejected.
   * @param {unknown} raw
   */
  async function handleMessage(raw) {
    const v = deps.validateMessage(raw, { currentScanId, currentJobId });
    if (!v.ok) return { ok: false, code: v.code ?? "rejected" };
    const msg = /** @type {{ kind: string }} */ (raw);
    switch (msg.kind) {
      case "StartScan":
        if (typeof deps.startScan !== "function") return { ok: false, code: "no-handler" };
        return { ok: true, result: await deps.startScan() };
      case "FetchResource": {
        if (typeof deps.fetchResource !== "function") return { ok: false, code: "no-handler" };
        const payload = /** @type {{ url?: string }} */ (/** @type {any} */ (raw).payload ?? {});
        return { ok: true, result: await deps.fetchResource(String(payload.url ?? ""), { userIntent: true }) };
      }
      case "StartNativeHandoff":
        if (typeof deps.requestNativeHandoff !== "function") return { ok: false, code: "no-handler" };
        return { ok: true, result: await deps.requestNativeHandoff((/** @type {any} */ (raw)).payload ?? {}) };
      default:
        // ScanStarted/CandidateFound/ScanSettled/... are notifications: accept.
        return { ok: true, notified: true };
    }
  }

  return { bind, handleMessage, getBinding: () => ({ currentScanId, currentJobId }) };
}
