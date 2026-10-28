// Cargo supplies OUT_DIR; dependency installation stays in the workspace setup.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const viewer = path.join(root, "crates/dezoomify-native/viewer");
const bundle = await build({
  absWorkingDir: root,
  entryPoints: [path.join(viewer, "viewer.js")],
  bundle: true,
  write: false,
  format: "iife",
  target: "es2022",
  minify: true,
  legalComments: "inline",
  metafile: true,
});
const html = readFileSync(path.join(viewer, "viewer.html"), "utf8").replace(
  "<!--VIEWER_SCRIPT-->",
  () => `<script>${bundle.outputFiles[0].text}</script>`,
);
writeFileSync(path.join(process.argv[2], "viewer.html"), html);
for (const input of Object.keys(bundle.metafile.inputs)) {
  console.log(`cargo:rerun-if-changed=${path.resolve(root, input)}`);
}
