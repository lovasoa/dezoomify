// Sync browser JS mirrors from their TypeScript sources of truth.
//
// The website is served as static ES modules with no bundler, so browsers
// need plain `.js`. The `.ts` files are the single source of truth:
// type-checked (`tsc --noEmit`) and unit-tested (node type-stripping).
// This script regenerates each `.js` mirror from its `.ts` twin, so the two
// can never drift apart again. Never hand-edit a generated `.js` file.
//
// Usage:
//   node scripts/sync-web-js.mjs          # regenerate in place
//   node scripts/sync-web-js.mjs --check  # fail (exit 1) when drifted
//
// Constraint: sources must stay erasable-syntax-only TypeScript (no enums,
// namespaces, parameter properties, or other non-erasable syntax), so the
// transform is a pure type-strip plus a `.ts` -> `.js` import rewrite.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripTypeScriptTypes } from "node:module";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// (ts, js) pairs: the js mirror is served to browsers, the ts is tested.
// This list is exactly the browser-served module graph (index.html ->
// src/main.js -> ...); node-only modules (caches, surfaces, save helpers)
// stay TypeScript-only and are never shipped.
const PAIRS = [
  ["src/discovery.ts", "src/discovery.js"],
  ["src/hash.ts", "src/hash.js"],
  ["src/main.ts", "src/main.js"],
  ["src/webIntegration.ts", "src/webIntegration.js"],
  ["src/proxyTransport.ts", "src/proxyTransport.js"],
  ["packages/shared-ui/src/components.ts", "packages/shared-ui/src/components.js"],
  ["packages/shared-ui/src/controller.ts", "packages/shared-ui/src/controller.js"],
  ["packages/shared-ui/src/history.ts", "packages/shared-ui/src/history.js"],
  ["packages/shared-ui/src/view.ts", "packages/shared-ui/src/view.js"],
  ["packages/shared-ui/src/saveName.ts", "packages/shared-ui/src/saveName.js"],
  ["packages/browser-runtime/src/types.ts", "packages/browser-runtime/src/types.js"],
  ["packages/browser-runtime/src/limits.ts", "packages/browser-runtime/src/limits.js"],
  ["packages/browser-runtime/src/queue.ts", "packages/browser-runtime/src/queue.js"],
  ["packages/browser-runtime/src/session.ts", "packages/browser-runtime/src/session.js"],
  ["packages/browser-runtime/src/crop.ts", "packages/browser-runtime/src/crop.js"],
  ["packages/browser-runtime/src/preview.ts", "packages/browser-runtime/src/preview.js"],
  ["packages/browser-runtime/src/transport-labels.ts", "packages/browser-runtime/src/transport-labels.js"],
  ["packages/browser-runtime/src/save-name.ts", "packages/browser-runtime/src/save-name.js"],
  ["packages/shared-ui/src/i18n.ts", "packages/shared-ui/src/i18n.js"],
  ["packages/shared-ui/src/locales/fr.ts", "packages/shared-ui/src/locales/fr.js"],
  ["packages/shared-ui/src/locales/de.ts", "packages/shared-ui/src/locales/de.js"],
  ["packages/shared-ui/src/locales/it.ts", "packages/shared-ui/src/locales/it.js"],
];

// No-bundler extension page mirrors: `apps/extension/src/page/vendor/`
// carries flattened copies of the canonical `.js` mirrors above (plus the
// canonical theme), so the page tests the same logic the website serves.
// (canonJs, vendorJs) pairs; the vendor file must equal the canonical file
// with cross-package `../../browser-runtime/src/` specifiers flattened to
// `./` siblings. Locale mirrors keep their `./locales/` structure under
// `vendor/locales/`.
const VENDOR_PAIRS = [
  ["packages/shared-ui/src/controller.js", "apps/extension/src/page/vendor/controller.js"],
  ["packages/shared-ui/src/view.js", "apps/extension/src/page/vendor/view.js"],
  ["packages/shared-ui/src/components.js", "apps/extension/src/page/vendor/components.js"],
  ["packages/shared-ui/src/history.js", "apps/extension/src/page/vendor/history.js"],
  ["packages/shared-ui/src/saveName.js", "apps/extension/src/page/vendor/saveName.js"],
  ["packages/shared-ui/src/i18n.js", "apps/extension/src/page/vendor/i18n.js"],
  ["packages/shared-ui/src/locales/fr.js", "apps/extension/src/page/vendor/locales/fr.js"],
  ["packages/shared-ui/src/locales/de.js", "apps/extension/src/page/vendor/locales/de.js"],
  ["packages/shared-ui/src/locales/it.js", "apps/extension/src/page/vendor/locales/it.js"],
  ["packages/browser-runtime/src/limits.js", "apps/extension/src/page/vendor/limits.js"],
  ["packages/browser-runtime/src/transport-labels.js", "apps/extension/src/page/vendor/transport-labels.js"],
  ["packages/browser-runtime/src/save-name.js", "apps/extension/src/page/vendor/save-name.js"],
  ["packages/browser-runtime/src/crop.js", "apps/extension/src/page/vendor/crop.js"],
];

const VENDOR_CSS_PAIRS = [
  ["packages/shared-ui/src/styles/theme.css", "apps/extension/src/page/vendor/theme.css"],
];

function flattenVendor(source) {
  return source.replaceAll('"../../browser-runtime/src/', '"./');
}

function headerFor(tsRel) {
  return (
    `// GENERATED from ${tsRel} by scripts/sync-web-js.mjs. Do not hand-edit.\n` +
    `// Source of truth: ${tsRel} (erasable-syntax TypeScript). Regenerate with:\n` +
    `//   node scripts/sync-web-js.mjs\n`
  );
}

function normalize(body) {
  return body
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+/, "")
    .replace(/\s+$/, "\n");
}

export function generate(tsRel) {
  const src = fs.readFileSync(path.join(ROOT, tsRel), "utf8");
  // Pure type-strip: throws on non-erasable syntax, which keeps sources
  // honest (see the module header for the constraint).
  const stripped = stripTypeScriptTypes(src, { mode: "strip" });
  // Browsers resolve `.js` specifiers; sources import their `.ts` twins so
  // node type-stripping and tsc resolve the same graph.
  const rewritten = stripped.replace(
    /(from\s+["'])(\.{1,2}\/[^"']*?)\.ts(["'])/g,
    "$1$2.js$3",
  );
  if (/\.ts(["'])/.test(rewritten)) {
    throw new Error(
      `${tsRel}: a ".ts" import specifier survived stripping; ` +
        `browser modules must import ".js" mirrors`,
    );
  }
  return headerFor(tsRel) + "\n" + normalize(rewritten);
}

function main() {
  const check = process.argv.includes("--check");
  let drifted = [];
  for (const [tsRel, jsRel] of PAIRS) {
    const want = generate(tsRel);
    const jsPath = path.join(ROOT, jsRel);
    if (check) {
      const have = fs.readFileSync(jsPath, "utf8");
      if (have !== want) drifted.push(jsRel);
    } else {
      fs.mkdirSync(path.dirname(jsPath), { recursive: true });
      fs.writeFileSync(jsPath, want);
      console.log(`sync-web-js: ${tsRel} -> ${jsRel}`);
    }
  }
  // Extension vendor mirrors follow the canonical `.js` mirrors (never the
  // `.ts` sources directly), so `--check` covers them in the same run.
  const vendorWant = new Map();
  for (const [canonRel, vendorRel] of VENDOR_PAIRS) {
    const canon = fs.readFileSync(path.join(ROOT, canonRel), "utf8");
    vendorWant.set(vendorRel, flattenVendor(canon));
  }
  for (const [canonRel, vendorRel] of VENDOR_CSS_PAIRS) {
    vendorWant.set(vendorRel, fs.readFileSync(path.join(ROOT, canonRel), "utf8"));
  }
  for (const [vendorRel, want] of vendorWant) {
    const vendorPath = path.join(ROOT, vendorRel);
    if (check) {
      let have;
      try {
        have = fs.readFileSync(vendorPath, "utf8");
      } catch {
        drifted.push(vendorRel);
        continue;
      }
      if (have !== want) drifted.push(vendorRel);
    } else {
      fs.mkdirSync(path.dirname(vendorPath), { recursive: true });
      fs.writeFileSync(vendorPath, want);
      console.log(`sync-web-js: vendor ${vendorRel}`);
    }
  }
  if (check && drifted.length > 0) {
    console.error(
      `sync-web-js: drifted mirrors (run \`node scripts/sync-web-js.mjs\`):\n` +
        drifted.map((f) => `  - ${f}`).join("\n"),
    );
    process.exit(1);
  }
  if (check) console.log(`sync-web-js: ${PAIRS.length} mirrors in sync`);
}

main();
