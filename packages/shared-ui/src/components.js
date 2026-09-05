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
