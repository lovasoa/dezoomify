import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const sourceDirectories = [
  "src",
  "functions",
  "apps/desktop/src",
  "apps/extension/src",
  "apps/extension/entrypoints",
];

function product(file) {
  if (/^(src|functions)\//.test(file) || file === "dezoomify" || file.startsWith("dezoomify/")) {
    return "website";
  }
  for (const name of ["desktop", "extension"]) {
    if (
      file.startsWith(`apps/${name}/`) ||
      file === `@dezoomify/${name}` ||
      file.startsWith(`@dezoomify/${name}/`)
    ) {
      return name;
    }
  }
  return undefined;
}

function crossings(metafile) {
  return Object.values(metafile.outputs).flatMap(({ entryPoint, imports }) => {
    const source = product(entryPoint);
    return imports.flatMap(({ path: specifier }) => {
      const resolved = specifier.startsWith(".")
        ? path.posix.normalize(path.posix.join(path.posix.dirname(entryPoint), specifier))
        : specifier;
      const target = product(resolved);
      return source && target && source !== target
        ? [`${entryPoint} (${source}) imports ${specifier} (${target})`]
        : [];
    });
  });
}

function imports(options) {
  return buildSync({
    absWorkingDir: root,
    bundle: false,
    write: false,
    metafile: true,
    format: "esm",
    logLevel: "silent",
    tsconfigRaw: { compilerOptions: { verbatimModuleSyntax: true } },
    ...options,
  }).metafile;
}

test("production product imports remain inside their product or shared packages", () => {
  const entryPoints = sourceDirectories.flatMap((directory) =>
    fs
      .readdirSync(path.join(root, directory), { recursive: true })
      .filter((file) => /\.[jt]sx?$/.test(file) && !file.endsWith(".d.ts"))
      .map((file) => path.posix.join(directory, file.replaceAll(path.sep, "/")))
      .filter((file) => !file.startsWith("apps/extension/src/test/")),
  );
  const failures = crossings(imports({ entryPoints, outdir: "out", outbase: "." }));
  assert.deepEqual(failures, [], `Product imports cross a boundary:\n${failures.join("\n")}`);
});

test("import inventory rejects sibling products, nested relative paths, reexports and dynamic imports", () => {
  for (const [sourcefile, contents] of [
    ["src/main.ts", 'import "../apps/desktop/src/main.ts";'],
    ["apps/desktop/src/main.ts", 'export * from "../../../src/main.ts";'],
    ["apps/extension/src/job/index.ts", 'void import("../../../../src/main.ts");'],
    ["apps/desktop/src/nested/index.ts", 'import "../../../extension/src/job/index.ts";'],
    ["apps/extension/entrypoints/background.ts", 'import "@dezoomify/desktop";'],
  ]) {
    assert.equal(crossings(imports({ stdin: { sourcefile, contents } })).length, 1, contents);
  }
});

test("same-product imports, shared dependencies and deployed proxy entrypoints are allowed", () => {
  for (const [sourcefile, contents] of [
    ["src/main.ts", 'import "@dezoomify/browser-runtime";'],
    ["apps/desktop/src/main.ts", 'import "@dezoomify/shared-ui";'],
    ["apps/extension/entrypoints/job/job.ts", 'import "../../src/job/index.ts";'],
    ["functions/api/proxy.ts", 'export * from "../../src/server/proxy.ts";'],
    ["functions/proxy.js", 'export * from "../legacy/functions/proxy.js";'],
  ]) {
    assert.deepEqual(crossings(imports({ stdin: { sourcefile, contents } })), [], contents);
  }
});
