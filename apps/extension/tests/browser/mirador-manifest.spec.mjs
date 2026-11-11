import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { test } from "../../../../test/browser/fixtures.mjs";

const origin = "https://iiif.nichibun.ac.jp";
const manifestUrl = `${origin}/IIIF/manifest/YSD/002463024.json`;
const service = `${origin}/iipsrv?IIIF=/YSD/002463024/002463024_o.tif`;
const fixture = new URL("../../../../test/browser/corpus/mirador/", import.meta.url);
const mirador = gunzipSync(readFileSync(new URL("mirador.js.gz", fixture)));
const tile = readFileSync(new URL("../../../../fixtures/tiles/0-0.png", import.meta.url));
test("Mirador offers the manifest canvases before a loaded tile source", async ({
  page,
  loadModule,
}) => {
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
  await loadModule(page, "/apps/extension/tests/browser/entries/mirador.ts");
  const result = await page.evaluate(async () => {
    const scan = await Inspector.scanViewers();
    const snapshot = Inspector.collectCandidates(Inspector.sourceSnapshotLimits);
    const wasm = await import("/__wasm/dezoomify-wasm.js");
    await wasm.default();
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
    try {
      await wasm.dezoomify([...snapshot.inputs, ...scan.inputs], {}, platform);
    } catch (error) {
      if (error.kind !== "cancelled") throw error;
    }
    return catalog;
  });
  assert.deepEqual(
    result.entries.map((entry) => entry.uri),
    [`${service}/info.json`, `${service.replace("_o.tif", "_u.tif")}/info.json`],
  );
});
