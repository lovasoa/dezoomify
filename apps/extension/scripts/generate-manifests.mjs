// Generate apps/extension/generated/manifest.{chromium,firefox}.json as
// deterministic merges of src/manifest/base.json plus the per-browser
// overlay. Underscore-prefixed overlay keys (e.g. `_compatNote`) are
// documentation-only and never ship. Run: node scripts/generate-manifests.mjs
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "../src/manifest");
const OUT = path.join(HERE, "../generated");

function merge(base, overlay) {
  if (Array.isArray(overlay)) return [...overlay];
  if (overlay !== null && typeof overlay === "object" && base !== null && typeof base === "object" && !Array.isArray(base)) {
    const out = { ...base };
    for (const [k, v] of Object.entries(overlay)) out[k] = merge(base[k], v);
    return out;
  }
  return overlay;
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, sortKeys(v)]),
    );
  }
  return value;
}

const base = JSON.parse(readFileSync(path.join(SRC, "base.json"), "utf8"));
for (const browser of ["chromium", "firefox"]) {
  const overlay = JSON.parse(readFileSync(path.join(SRC, `${browser}.json`), "utf8"));
  const merged = Object.fromEntries(
    Object.entries(merge(base, overlay)).filter(([k]) => !k.startsWith("_")),
  );
  writeFileSync(path.join(OUT, `manifest.${browser}.json`), JSON.stringify(sortKeys(merged), null, 2) + "\n");
  console.log(`generated manifest.${browser}.json`);
}
