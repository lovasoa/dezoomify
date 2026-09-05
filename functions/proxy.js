// Cloudflare Pages Function: binds the legacy site's proxy route (GET
// /proxy?url=…, see legacy/functions/proxy.js) by re-exporting the vendored
// legacy handlers. The legacy tree stays the single canonical copy; explicit
// named re-exports are required (a bare `export *` does not register routes).
import * as legacyProxy from "../legacy/functions/proxy.js";

export const onRequestGet = legacyProxy.onRequestGet;
export const onRequestHead = legacyProxy.onRequestHead;
export const onRequestOptions = legacyProxy.onRequestOptions;
