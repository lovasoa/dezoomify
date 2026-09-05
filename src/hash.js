// GENERATED from src/hash.ts by scripts/sync-web-js.mjs. Do not hand-edit.
// Source of truth: src/hash.ts (erasable-syntax TypeScript). Regenerate with:
//   node scripts/sync-web-js.mjs

// Legacy-compatible shareable URL hash.
// Legacy app (`migration-sources/dezoomify-web/browser-init.js`) did:
//   window.location.hash = url;            // on submit
//   var startURL = window.location.hash.slice(1); // on load
// Keep that exact contract: the hash body IS the target URL, raw, not
// wrapped in `?url=` or JSON. New code additionally accepts the
// percent-encoded and `#!/` variants so copied links keep working.
//
// Keep this file erasable-syntax-only so node type-stripping can import it
// directly in tests. The browser `./hash.js` mirror is generated from this
// file by `scripts/sync-web-js.mjs`; never edit the `.js` by hand.

export function parseHash(hash                           )                {
  if (hash === null || hash === undefined) return null;
  let body = String(hash);
  if (body.startsWith("#")) body = body.slice(1);
  // Tolerate hashbang links (`#!/https://...`) shared in the wild.
  if (body.startsWith("!")) body = body.slice(1);
  if (body.startsWith("/")) body = body.slice(1);
  body = body.trim();
  if (body.length === 0) return null;
  // Legacy wrote the raw URL; modern copies may be percent-encoded.
  // Prefer the decoded form only when it looks like a usable URL.
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

export function buildHash(url        )         {
  return `#${String(url ?? "").trim()}`;
}

export function readLocationHash(loc                    )                {
  if (!loc || typeof loc.hash !== "string") return null;
  return parseHash(loc.hash);
}

export function looksLikeUsableUrl(value                           )          {
  if (!value) return false;
  try {
    const u = new URL(String(value).trim());
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}
