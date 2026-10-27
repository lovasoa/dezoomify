import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import { build } from "esbuild";
import { chromium, firefox } from "playwright";

const origin = "https://iiif.nichibun.ac.jp";
const manifestUrl = `${origin}/IIIF/manifest/YSD/002463024.json`;
const service = `${origin}/iipsrv?IIIF=/YSD/002463024/002463024_o.tif`;
const fixture = new URL("./corpus/mirador/", import.meta.url);
const mirador = gunzipSync(readFileSync(new URL("mirador.js.gz", fixture)));
const tile = readFileSync(new URL("../../../../fixtures/tiles/0-0.png", import.meta.url));
const scanner = (
  await build({
    stdin: {
      contents: `export {scanViewers} from './viewer-scanner.ts';
export {collectCandidates} from './source-operations.ts';
export {BrowserHost,selectionLimitsFor} from '@dezoomify/browser-runtime';`,
      resolveDir: new URL("../../src/job/", import.meta.url).pathname,
    },
    bundle: true,
    write: false,
    format: "iife",
    globalName: "Inspector",
    target: "es2022",
    define: { "import.meta.url": JSON.stringify(import.meta.url) },
  })
).outputFiles[0].text;

for (const [name, engine] of [
  ["Chromium", chromium],
  ["Firefox", firefox],
]) {
  test(`${name}: Nichibun Mirador selects its manifest before the loaded tile source`, async () => {
    const browser = await engine.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.route("**/*", (route) => {
        const url = new URL(route.request().url());
        const reply = (contentType, body) => route.fulfill({ contentType, body });
        if (url.pathname === "/YSD/detail/002463024.html")
          return reply("text/html", readFileSync(new URL("viewer.html", fixture)));
        if (url.pathname === "/IIIF/mirador/mirador.js") return reply("text/javascript", mirador);
        if (url.href === manifestUrl)
          return reply("application/json", readFileSync(new URL("manifest.json", fixture)));
        if (url.href === `${service}/info.json`)
          return reply("application/json", readFileSync(new URL("info.json", fixture)));
        if (url.pathname.startsWith("/__wasm/")) {
          const file = url.pathname.slice("/__wasm/".length);
          return reply(
            file.endsWith(".wasm") ? "application/wasm" : "text/javascript",
            readFileSync(new URL(`../../../../wasm/${file}`, import.meta.url)),
          );
        }
        if (url.href.endsWith(".jpg")) return reply("image/png", tile);
        return reply("application/json", "{}");
      });
      await page.goto(`${origin}/YSD/detail/002463024.html`, { waitUntil: "networkidle" });
      await page.waitForSelector(".openseadragon-canvas", { state: "attached" });
      await page.addScriptTag({ content: scanner });
      const result = await page.evaluate(async () => {
        const scan = await Inspector.scanViewers();
        const snapshot = Inspector.collectCandidates();
        const wasm = await import("/__wasm/dezoomify-wasm.js");
        await wasm.default();
        const reads = [];
        let catalog;
        const platform = new Inspector.BrowserHost({
          signal: new AbortController().signal,
          selectionLimits: Inspector.selectionLimitsFor(),
          assembly: {
            prepare() {
              throw new Error("the manifest must offer its canvases before acquiring tiles");
            },
            release() {},
          },
          decoder: { dispose() {}, async settle() {} },
          async fetchResource(request) {
            reads.push(request.uri);
            const response = await fetch(request.uri);
            return {
              kind: "response",
              response: { bytes: new Uint8Array(await response.arrayBuffer()) },
            };
          },
          async chooseImage(value) {
            catalog = value;
            throw { kind: "cancelled" };
          },
          onProgress() {},
        });
        let failure;
        try {
          await wasm.dezoomify([...snapshot.inputs, ...scan.inputs], {}, platform);
        } catch (error) {
          failure = error;
        }
        return {
          version: window.OpenSeadragon.version.versionStr,
          scan: scan.inputs,
          resources: snapshot.inputs.map((input) => input.url),
          catalog,
          reads,
          failure,
        };
      });
      assert.equal(result.version, "2.4.1");
      assert.equal(result.scan.length, 1, "the live source competes with the manifest");
      assert.equal(JSON.parse(result.scan[0].contents).id, service);
      assert.ok(result.resources.includes(`${service}/info.json`));
      assert.deepEqual(result.reads, [manifestUrl]);
      assert.equal(result.failure.kind, "cancelled");
      assert.deepEqual(
        result.catalog.entries.map((entry) => entry.uri),
        [`${service}/info.json`, `${service.replace("_o.tif", "_u.tif")}/info.json`],
      );
    } finally {
      await browser.close();
    }
  });
}
