// Legacy-compatible shareable URL hash (browser ES module mirror of ./hash.ts).
// Keep the two files byte-equivalent in logic; this file drops types so the
// live site served without a build step behaves exactly like the tested TS.

export function parseHash(hash) {
  if (hash === null || hash === undefined) return null;
  let body = String(hash);
  if (body.startsWith("#")) body = body.slice(1);
  if (body.startsWith("!")) body = body.slice(1);
  if (body.startsWith("/")) body = body.slice(1);
  body = body.trim();
  if (body.length === 0) return null;
  try {
    if (body.includes("%")) {
      const decoded = decodeURIComponent(body);
      if (/^https?:\/\//i.test(decoded)) return decoded;
    }
  } catch {
    // Undecodable bodies fall through to the raw value.
  }
  return body;
}

export function buildHash(url) {
  return `#${String(url ?? "").trim()}`;
}

export function readLocationHash(loc) {
  if (!loc || typeof loc.hash !== "string") return null;
  return parseHash(loc.hash);
}

export function looksLikeUsableUrl(value) {
  if (!value) return false;
  try {
    const u = new URL(String(value).trim());
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}
