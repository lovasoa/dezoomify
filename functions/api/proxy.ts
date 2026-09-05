// Cloudflare Pages Functions entrypoint. The Pages project publishes the
// repository root as its output directory, so Pages requires this repo-root
// functions/ directory; it re-exports the tested adapter in apps/web.
export { onRequestPost, onRequestOptions } from "../../apps/web/functions/api/proxy.ts";
