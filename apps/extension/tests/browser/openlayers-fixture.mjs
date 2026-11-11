import { fileURLToPath } from "node:url";
import { build } from "esbuild";

/** Bundle pinned real libraries; fixtures never load public CDN resources. */
export async function openLayersLibrary(packageName = "ol") {
  const result = await build({
    absWorkingDir: import.meta.dirname,
    entryPoints: [
      fileURLToPath(new URL("../../../../test/browser/openlayers.ts", import.meta.url)),
    ],
    alias: { ol: packageName },
    bundle: true,
    write: false,
    format: "iife",
    globalName: "OpenLayersFixture",
    target: "es2022",
  });
  return result.outputFiles[0].text;
}
