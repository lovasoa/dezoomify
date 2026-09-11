#!/usr/bin/env node
// Single website builder: regenerates every derived artifact (help pages,
// wasm glue) and assembles one deployable tree under dist/: the legacy site
// (vendored under legacy/, copied verbatim) serves /, and the Vite+React app
// serves /beta. The website-deploy workflow runs this on GitHub Actions and
// uploads dist/ to Cloudflare Pages with wrangler; `cargo xtask build web`
// runs the same script locally. Nothing under dist/ is committed. See
// plans/website-deploy.md for the deployment contract.
//
// Usage:
//   node scripts/build-site.mjs            # full build (help, wasm glue,
//                                           # Vite app, dist/)
//   node scripts/build-site.mjs --no-wasm  # help + Vite + dist/, using the
//                                           # existing wasm/ glue (used by
//                                           # test lanes that never load the
//                                           # worker)
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

/** True when Vite emitted at least one hashed JS asset under dist/beta/assets. */
function hasViteJsAsset() {
  const assets = path.join(DIST, BETA, "assets");
  if (!fs.existsSync(assets)) return false;
  return fs.readdirSync(assets).some((name) => name.endsWith(".js"));
}

function main() {
  const noWasm = process.argv.includes("--no-wasm");

  // 1. Help pages from docs/user.
  run(process.execPath, ["scripts/build-help.mjs"]);

  // 2. Wasm adapter (release profile: the deployed artifact) and its glue.
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

  // 3. Vite production build: hashed assets, worker, and the wasm glue the
  //    worker imports (emitted under dist/beta/).
  fs.rmSync(DIST, { recursive: true, force: true });
  run(process.execPath, ["node_modules/vite/bin/vite.js", "build"]);

  // 4. Assemble the rest of dist/: the legacy site at / (verbatim), help and
  //    the canonical wasm paths below dist/beta/, and the Functions routing
  //    manifest.
  copyLegacy();
  copyTree("help", path.join(BETA, "help"));
  copy("wasm/dezoomify-wasm.js", BETA);
  copy("wasm/dezoomify-wasm_bg.wasm", BETA);
  fs.writeFileSync(path.join(DIST, "_routes.json"), JSON.stringify(ROUTES, null, 2) + "\n");

  // 5. Sanity: the served tree must contain the deployed contract's keys.
  for (const must of [
    "index.html",
    "404.html",
    "zoommanager.js",
    path.join("dezoomers", "zoomify.js"),
    path.join(BETA, "index.html"),
    path.join(BETA, "privacy.html"),
    path.join(BETA, "terms.html"),
    path.join(BETA, "wasm", "dezoomify-wasm.js"),
    path.join(BETA, "wasm", "dezoomify-wasm_bg.wasm"),
    path.join(BETA, "help", "index.html"),
    "_routes.json",
  ]) {
    if (!fs.existsSync(path.join(DIST, must))) {
      throw new Error(`assembled dist/ is missing ${must}`);
    }
  }
  if (!hasViteJsAsset()) {
    throw new Error("assembled dist/beta/assets is missing the Vite JavaScript bundle");
  }
  const count = spawnSync("find", [DIST, "-type", "f"], { encoding: "utf8" });
  const files = count.stdout.trim().split("\n").length;
  console.log(
    `build-site: dist/ assembled (${files} files; legacy at /, Vite+React app at /${BETA})`,
  );
}

main();
