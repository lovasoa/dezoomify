/**
 * Extension-scoped compiled entrypoint graph. Store staging invokes this
 * script; it replaces source renames and export stripping with the same
 * dependency graph used by development builds.
 */
import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "src");
const repository = path.resolve(root, "../..");
const outputArg = process.argv.indexOf("--out");
const output = outputArg >= 0 ? path.resolve(process.argv[outputArg + 1] ?? "") : path.join(root, "dist");
if (!output || output === path.resolve(".")) throw new Error("build requires a non-empty --out path");

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

const entries = [
  ["background/index.ts", "background/index.js", "iife"],
  ["content/modal.js", "content/modal.js", "iife"],
  ["job/index.ts", "job/index.js", "esm"],
  ["job/worker.ts", "job/worker.js", "esm"],
];
for (const [entry, outfile, format] of entries) {
  await build({
    entryPoints: [path.join(source, entry)],
    bundle: true,
    format,
    platform: "browser",
    target: "es2022",
    outfile: path.join(output, outfile),
    legalComments: "none",
    // The Rust-generated WASM glue is an application artifact, not a JS
    // source module. Keep its runtime-relative import and stage it below.
    external: ["../wasm/dezoomify-wasm.js"],
    sourcemap: false,
    logLevel: "silent",
  });
}

for (const directory of ["icons", "vendor"]) {
  await cp(path.join(source, directory), path.join(output, directory), { recursive: true });
}
for (const file of ["job/job.html", "content/modal.css"]) {
  const to = path.join(output, file);
  await mkdir(path.dirname(to), { recursive: true });
  await cp(path.join(source, file), to);
}
await cp(path.join(repository, "wasm"), path.join(output, "wasm"), { recursive: true });
