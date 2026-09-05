// Minimal host-neutral shared-ui helpers (no React, no browser globals).

export function renderTransportLabel(transport) {
  if (transport === "direct") return "Direct from your browser";
  if (transport === "proxy") return "Metadata proxy";
  if (transport === "display") return "Display only";
  return transport;
}

export function renderSaveGuidance(originClean) {
  if (originClean) {
    return "You can save this picture in the format and name shown below.";
  }
  return (
    "This preview is display only. To keep a copy, right-click the image where " +
    "your browser supports it. Programmatic save needs readable tile bytes."
  );
}

export function renderErrorSummary(error) {
  const action = error.retryable ? "Please try again." : "Please try a different picture or app.";
  return `${error.message} ${action}`;
}

export function renderProgress(current, total) {
  if (total <= 0) return `Working: ${current} done.`;
  const pct = Math.max(0, Math.min(100, Math.round((current / total) * 100)));
  return `Working: ${current} of ${total} done (${pct} percent).`;
}

export function renderCompletion(width, height, mime) {
  return `Finished. Your picture is ${width} by ${height} pixels (${mime}).`;
}

/**
 * Authentic Dezoomify logo SVG: sapphire blue magnifying glass (#3c7bff)
 * with internal coral-salmon tile quadrants (#ff8080).
 */
export function getDezoomifyLogoSvg(size = 28) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 355 355" width="${size}" height="${size}" aria-hidden="true" style="vertical-align: middle; display: inline-block;">
    <path fill="#ff8080" d="m 154.32,21.09 v 100.89 h 108.07 C 256.62,85.76 234.66,54.13 202.73,36.06 187.84,27.7 171.34,22.59 154.32,21.09 Z m -30,0.9 C 88.2,27.78 56.66,49.67 38.6,81.48 31.5,94.03 26.72,107.75 24.46,121.99 h 99.86 z M 23.55,151.99 c 3.58,39.19 26.07,74.17 60.24,93.69 l 0.57,0.32 c 12.4,6.94 25.93,11.62 39.96,13.85 V 151.99 Z"/>
    <path fill="#3c7bff" d="M 140.35,8.62 C 56.27,8.37 -10.24,100.62 17.73,180.42 38.06,255.26 129.99,294.54 198.59,262.98 225.22,289.49 251.61,316.24 278.38,342.59 290.08,352.82 307.74,347.85 316.36,336.21 325.53,327.02 338.33,317.14 334.74,302.34 331.19,288.67 318.02,281.07 309.24,270.84 290.84,252.44 272.44,234.04 254.04,215.64 305.83,145.35 264.78,33.62 179.82,13.54 168.29,10.33 156.32,8.7 144.36,8.71 143.02,8.65 141.68,8.63 140.35,8.62 Z m 9.36,16.85 a 115.05,115.05 0 0 1 51.43,14.79 115.05,115.05 0 0 1 43.58,156.65 115.05,115.05 0 0 1 -156.59,43.79 l -0.54,-0.31 A 115.05,115.05 0 0 1 44.43,83.63 115.05,115.05 0 0 1 149.71,25.47 Z"/>
  </svg>`;
}
