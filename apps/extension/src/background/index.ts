/**
 * Background service-worker entry (Phase 12).
 *
 * Wires the finite scanner, candidate store, session fetch, handoff
 * validation, one-use native sessions, and redaction. No global browser work
 * happens at import time; `createBackground` takes every browser effect as an
 * injected dependency so unit tests run with fakes and production wires real
 * `chrome.*` APIs in one place.
 *
 * Plain JavaScript + JSDoc (import-free; concrete wiring lives in the host).
 */

/** Background wiring descriptor (documents expected deps, no imports). */
export const BACKGROUND_WIRING = Object.freeze([
  "scan:startScan(explicit-action-only)",
  "scan:observer-before-reload(exact-tabId)",
  "candidates:bounded-memory-only",
  "fetch:browser-session-no-proxy",
  "handoff:validate-then-confirm",
  "native:one-use-consented",
  "redaction:memory-only-best-effort",
]);

/**
 * Create a background controller descriptor. Real browser wiring is provided
 * by the caller; this function only validates the dependency surface.
 * @param {Record<string, unknown>} deps must provide the named factories/effects
 */
export function createBackground(deps) {
  const required = [
    "queryActiveTab",
    "addWebRequestListener",
    "removeWebRequestListener",
    "reloadTab",
    "fetchImpl",
    "hasPermission",
    "requestPermission",
    "isAllowedSender",
    "isExtensionIdAllowed",
  ];
  const missing = required.filter((k) => !(k in (deps ?? {})));
  if (missing.length > 0) {
    throw Object.assign(new Error(`missing background deps: ${missing.join(",")}`), {
      code: "bad-deps",
    });
  }
  return Object.freeze({
    wiring: BACKGROUND_WIRING,
    // Note: no listeners/timers are installed here. Scans start only via an
    // explicit action calling the scanner's startScan().
    started: false,
  });
}
