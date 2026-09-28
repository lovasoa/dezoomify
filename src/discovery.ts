// Rate-limit copy. The two cases are genuinely different and must never be
// blurred: an upstream 429 seen through the metadata proxy means OUR server's
// IP was throttled, so the fix is an app that fetches from the user's own IP.
// A direct 429 means the user's own connection was throttled, so waiting is
// the only fix. Keep both free of jargon (no "HTTP 429", "upstream", "proxy").
export const RATE_LIMITED_BY_SITE_MESSAGE =
  "The website hosting this image limits how many pages our server may request from it, and that limit was just reached, so the page could not be opened. " +
  "The browser extension and the desktop app download from your own internet connection instead of our server, so they are not affected by this limit: try one of them below, or try again later.";
export const SITE_BUSY_MESSAGE =
  "The website hosting this image is receiving too many requests right now. Wait a few minutes and try again.";
