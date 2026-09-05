#!/usr/bin/env node
// Single website builder: regenerates every derived artifact (browser JS
// mirrors, help pages, wasm glue) and assembles one deployable tree under
// dist/: the legacy site (vendored under legacy/, copied verbatim) serves /,
// and the new app serves /beta. The website-deploy workflow runs this on
// GitHub Actions and uploads dist/ to Cloudflare Pages with wrangler;
// `cargo xtask build web` runs the same script locally. Nothing under dist/
// is committed. See plans/website-deploy.md for the deployment contract.
//
// Usage:
//   node scripts/build-site.mjs            # full build (mirrors, help,
//                                           # wasm glue, dist/)
//   node scripts/build-site.mjs --no-wasm  # mirrors + help + dist/, using
//                                           # the existing wasm/ glue (used
//                                           # by test lanes that never load
//                                           # the worker)
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIST = path.join(ROOT, "dist");
const BETA = "beta";

// The legacy site serves / verbatim from legacy/ (vendored from master).
// These entries are the legacy repo's dev tooling, never served; everything
// else in legacy/ is copied byte-identical. legacy/functions/proxy.js is
// bound at /proxy by the functions/proxy.js re-export shim, not by dist/.
const LEGACY_EXCLUDE = new Set([
  ".github",
  ".gitignore",
  "AGENTS.md",
  "README.md",
  "LICENSE",
  "functions",
  "node-app",
  "tests",
]);

// New-app HTML entries copied verbatim under dist/beta/; every local asset
// they reference (stylesheets, favicons) is resolved and copied relative to
// them.
const HTML_ENTRIES = ["index.html", "privacy.html", "terms.html"];

// Function routes: the new app's metadata relay at /api/proxy
// (functions/api/proxy.ts) and the legacy site's proxy at /proxy
// (functions/proxy.js re-exporting legacy/functions/proxy.js).
// _routes.json in the output directory keeps every other path static-only.
const ROUTES = { version: 1, include: ["/api/proxy", "/proxy"], exclude: [] };

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: "inherit", cwd: ROOT, ...opts });
  if (res.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed (exit ${res.status})`);
  }
}

function localAssetsOf(htmlRel) {
  const html = fs.readFileSync(path.join(ROOT, htmlRel), "utf8");
  const dir = path.dirname(htmlRel);
  const refs = [
    ...html.matchAll(/(?:href|src)="([^"]+)"/g),
    ...html.matchAll(/(?:href|src)='([^']+)'/g),
  ]
    .map((m) => m[1].split("#")[0].split("?")[0])
    .filter((ref) => ref !== "");
  const assets = [];
  for (const ref of refs) {
    if (/^(https?:|mailto:|data:|#)/.test(ref)) continue;
    if (ref.endsWith(".html") || ref.endsWith("/")) continue; // pages are copied wholesale
    assets.push(path.normalize(path.join(dir, ref)));
  }
  return assets;
}

// Browser module graph: start at the page entry and the worker, then follow
// every relative import. wasm/dezoomify-wasm_bg.wasm is fetched by the glue
// at runtime (not an import specifier), so it is added explicitly.
function browserGraph(entryScripts) {
  const seen = new Set();
  const queue = [...entryScripts];
  while (queue.length > 0) {
    const rel = queue.pop();
    if (seen.has(rel)) continue;
    seen.add(rel);
    const text = fs.readFileSync(path.join(ROOT, rel), "utf8");
    const specifiers = [
      ...text.matchAll(/(?:import|export)[^'"]*?from\s*["'](\.[^"']+)["']/g),
      ...text.matchAll(/import\(\s*["'](\.[^"']+)["']\s*\)/g),
    ].map((m) => m[1]);
    for (const spec of specifiers) {
      queue.push(path.normalize(path.join(path.dirname(rel), spec)));
    }
  }
  return [...seen];
}

function copy(rel, prefix = "") {
  const src = path.join(ROOT, rel);
  if (!fs.existsSync(src)) {
    throw new Error(`site asset missing: ${rel} (run with the wasm build, or fix the reference)`);
  }
  const dest = path.join(DIST, prefix, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

// Copy a whole source tree into dist/ (destRel drops the source prefix).
function copyTree(srcRel, destRel) {
  fs.cpSync(path.join(ROOT, srcRel), path.join(DIST, destRel), { recursive: true });
}

// The legacy site serves /: everything in legacy/ except dev tooling,
// copied byte-identical (plans/website-deploy.md WD5).
function copyLegacy() {
  const legacyRoot = path.join(ROOT, "legacy");
  if (!fs.existsSync(path.join(legacyRoot, "functions", "proxy.js"))) {
    throw new Error("legacy/functions/proxy.js is missing (the /proxy route depends on it)");
  }
  for (const entry of fs.readdirSync(legacyRoot, { withFileTypes: true })) {
    if (LEGACY_EXCLUDE.has(entry.name)) continue;
    copyTree(path.join("legacy", entry.name), entry.name);
  }
}

function main() {
  const noWasm = process.argv.includes("--no-wasm");

  // 1. Browser JS mirrors from the TypeScript sources of truth.
  run(process.execPath, ["scripts/sync-web-js.mjs"]);

  // 2. Help pages from docs/user.
  run(process.execPath, ["scripts/build-help.mjs"]);

  // 3. Wasm adapter (release profile: the deployed artifact) and its glue.
  if (!noWasm) {
    const bindgen = spawnSync("wasm-bindgen", ["--version"], { encoding: "utf8" });
    if (bindgen.status !== 0) {
      throw new Error(
        "wasm-bindgen is required (install wasm-bindgen-cli matching the " +
          "wasm-bindgen version in Cargo.lock; the website-deploy workflow " +
          "does this via taiki-e/install-action)",
      );
    }
    run("cargo", [
      "build",
      "-p",
      "dezoomify-wasm",
      "--release",
      "--target",
      "wasm32-unknown-unknown",
    ]);
    run("wasm-bindgen", [
      "--target",
      "web",
      "--out-dir",
      "wasm",
      "--out-name",
      "dezoomify-wasm",
      "target/wasm32-unknown-unknown/release/dezoomify_wasm.wasm",
    ]);
  }

  // 4. Assemble dist/: the legacy site at / (verbatim), the new app under
  //    dist/beta/ (pages, assets, browser module graph, wasm glue), and the
  //    Functions routing manifest.
  fs.rmSync(DIST, { recursive: true, force: true });
  copyLegacy();
  const helpPages = fs
    .readdirSync(path.join(ROOT, "help"))
    .filter((f) => f.endsWith(".html"))
    .map((f) => path.join("help", f));
  const entries = [...HTML_ENTRIES, ...helpPages];
  const assets = new Set();
  for (const entry of entries) {
    for (const asset of localAssetsOf(entry)) assets.add(asset);
  }
  const entryScripts = ["src/main.js", "src/worker.js"];
  const graph = browserGraph(entryScripts);
  for (const rel of [...entries, ...assets, ...graph, "wasm/dezoomify-wasm_bg.wasm"]) {
    copy(rel, BETA);
  }
  fs.writeFileSync(
    path.join(DIST, "_routes.json"),
    JSON.stringify(ROUTES, null, 2) + "\n",
  );

  // 5. Sanity: the served tree must contain the deployed contract's keys.
  for (const must of [
    "index.html",
    "404.html",
    "zoommanager.js",
    path.join("dezoomers", "zoomify.js"),
    path.join(BETA, "index.html"),
    path.join(BETA, "src", "main.js"),
    path.join(BETA, "src", "worker.js"),
    path.join(BETA, "wasm", "dezoomify-wasm.js"),
    path.join(BETA, "wasm", "dezoomify-wasm_bg.wasm"),
    path.join(BETA, "help", "index.html"),
    "_routes.json",
  ]) {
    if (!fs.existsSync(path.join(DIST, must))) {
      throw new Error(`assembled dist/ is missing ${must}`);
    }
  }
  const count = spawnSync("find", [DIST, "-type", "f"], { encoding: "utf8" });
  const files = count.stdout.trim().split("\n").length;
  console.log(
    `build-site: dist/ assembled (${files} files; legacy at /, new app at /${BETA}; ` +
      `entry scripts: ${entryScripts.map((s) => `${BETA}/${s}`).join(", ")})`,
  );
}

main();
