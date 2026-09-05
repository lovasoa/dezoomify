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
const PAIRS = [
  ["src/discovery.ts", "src/discovery.js"],
  ["src/hash.ts", "src/hash.js"],
  ["src/main.ts", "src/main.js"],
  ["packages/shared-ui/src/components.ts", "packages/shared-ui/src/components.js"],
  ["packages/shared-ui/src/controller.ts", "packages/shared-ui/src/controller.js"],
  ["packages/shared-ui/src/view.ts", "packages/shared-ui/src/view.js"],
  ["packages/browser-runtime/src/session.ts", "packages/browser-runtime/src/session.js"],
];

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
      fs.writeFileSync(jsPath, want);
      console.log(`sync-web-js: ${tsRel} -> ${jsRel}`);
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
