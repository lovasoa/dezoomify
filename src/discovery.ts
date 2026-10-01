// Rate-limit copy. The two cases are genuinely different and must never be
// blurred: an upstream 429 seen through the metadata proxy means OUR server's
// IP was throttled, so the fix is an app that fetches from the user's own IP.
// A direct 429 means the user's own connection was throttled, so waiting is
// the only fix. Keep both free of jargon (no "HTTP 429", "upstream", "proxy").
//
// The shared UI renders the localized copy at display time from the stable
// error codes (`UPSTREAM_RATE_LIMITED` / `PROXY_RATE_LIMITED`, distinguished by
// the transport that saw them; see `failureMessageOf` in
// packages/shared-ui/src/view.tsx). These English strings come from the
// canonical i18n table and only back the thrown error facts: diagnostics and
// bug reports, which stay literal English. They are never the rendered copy.
import { t } from "@dezoomify/shared-ui";

/** `createWebFetcher` message contract, sourced from the i18n English table. */
export function webFetchMessages(): {
  rateLimitedBySite: string;
  siteBusy: string;
  discoveryFailed(via: string): string;
} {
  return {
    rateLimitedBySite: t("view.fail.rateProxy", undefined, "en"),
    siteBusy: t("view.fail.rateDirect", undefined, "en"),
    discoveryFailed: () => t("view.discovery.none", undefined, "en"),
  };
}
