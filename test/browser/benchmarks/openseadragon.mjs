// Opt-in loopback benchmark: node test/browser/benchmarks/openseadragon.mjs <baseline-ref> [samples]
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { cpus } from "node:os";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, firefox } from "@playwright/test";
import { build } from "esbuild";
import sharp from "sharp";
import { seadragonLibrary, seadragonVersions } from "../seadragon-fixture.mjs";

const [baseline, samplesArg = "7", ...extra] = process.argv.slice(2);
const samples = Number(samplesArg);
assert.ok(
  baseline && !extra.length && Number.isInteger(samples) && samples >= 3 && samples <= 50,
  "Usage: node test/browser/benchmarks/openseadragon.mjs <baseline-ref> [samples:3..50]",
);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const loaderPath = "packages/page-agent/src/openseadragon/tile-loader.ts";
const baselineCode = execFileSync("git", ["show", `${baseline}:${loaderPath}`], {
  cwd: root,
  encoding: "utf8",
});
const exports = `
export { registerViewer, readViewerTile, releaseViewerTiles } from "../viewers/session.ts";
export { attachViewerTransport } from "../../../../apps/extension/src/viewer-transport.ts";
`;
const bundles = await Promise.all(
  [baselineCode, readFileSync(resolve(root, loaderPath), "utf8")].map(async (contents, index) => {
    const result = await build({
      stdin: {
        contents: contents + exports,
        loader: "ts",
        resolveDir: dirname(resolve(root, loaderPath)),
      },
      bundle: true,
      format: "iife",
      globalName: index ? "Current" : "Baseline",
      write: false,
      logLevel: "error",
      plugins: index
        ? []
        : [
            {
              name: "baseline-sources",
              setup(build) {
                build.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, ({ path }) => {
                  if (!path.startsWith(`${root}/`) || path.includes("/node_modules/")) return;
                  return {
                    contents: execFileSync("git", ["show", `${baseline}:${relative(root, path)}`], {
                      cwd: root,
                      encoding: "utf8",
                    }),
                    loader: path.endsWith(".tsx") ? "tsx" : path.endsWith(".ts") ? "ts" : "js",
                  };
                });
              },
            },
          ],
    });
    return result.outputFiles[0].text;
  }),
);
const tiles = new Map();
for (const size of [256, 1024]) {
  const pixels = Buffer.alloc(size * size * 3);
  let seed = 705;
  for (let i = 0; i < pixels.length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    pixels[i] = (i / 3 / size + ((i / 3) % size) + (seed >>> 27) * 3) % 256;
  }
  tiles.set(
    size,
    await sharp(pixels, { raw: { width: size, height: size, channels: 3 } })
      .jpeg({ quality: 85 })
      .toBuffer(),
  );
}
const server = createServer((request, response) => {
  if (request.url === "/") {
    response.writeHead(200, { "Content-Type": "text/html" }).end("<!doctype html><body></body>");
    return;
  }
  const tile = tiles.get(Number(request.url.split("/")[1]));
  if (!tile || request.headers.authorization !== "Bearer fixture") {
    response.writeHead(401).end();
    return;
  }
  response
    .writeHead(200, {
      "Content-Type": "image/jpeg",
      "Content-Length": tile.length,
      "Cache-Control": "no-store",
    })
    .end(tile);
});

async function initialize({ size, count, concurrency }) {
  const library = window.OpenSeadragon;
  const source = new library.DziTileSource(
    size * 8,
    size * 4,
    size,
    0,
    `${location.origin}/${size}/`,
    "jpg",
  );
  const level = source.maxLevel;
  const item = {
    _imageLoader: new library.ImageLoader({ jobLimit: concurrency, timeout: 30000 }),
    loadTilesWithAjax: true,
    ajaxHeaders: { Authorization: "Bearer fixture" },
  };
  const endpoints = [];
  for (const api of [Baseline, Current]) {
    const evidence = api.registerViewer(
      [],
      { documentUrl: location.href, imageIndex: 0 },
      (level, x, y, signal) => api.loadOpenSeadragonTile(source, item, level, x, y, signal),
    );
    const handle = evidence.input.viewer.handle;
    const channelId = crypto.randomUUID();
    api.attachViewerTransport(channelId, {
      handles: [handle],
      read: api.readViewerTile,
      dispose: () => api.releaseViewerTiles([handle]),
    });
    const channel = new MessageChannel();
    const pending = new Map();
    let nextId = 0;
    await new Promise((resolve) => {
      channel.port1.onmessage = ({ data }) => {
        if (data.type === "ready") resolve();
        if (data.type === "result") {
          pending.get(data.id)(data.result);
          pending.delete(data.id);
        }
      };
      window.postMessage(channelId, location.origin, [channel.port2]);
    });
    const send = (message) =>
      new Promise((resolve) => {
        const id = ++nextId;
        pending.set(id, resolve);
        channel.port1.postMessage({ ...message, id });
      });
    endpoints.push({ handle, send, port: channel.port1 });
  }
  const canvas = document.createElement("canvas");
  canvas.width = size * 4;
  canvas.height = size * 4;
  const context = canvas.getContext("2d");
  window.runBatch = async (implementation) => {
    const { handle, send } = endpoints[implementation];
    let next = 0;
    let bytes = 0;
    const started = performance.now();
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        while (next < count) {
          const index = next++;
          const result = await send({
            type: "read-tile",
            request: {
              handle,
              source_url: location.href,
              level,
              column: index % 8,
              row: Math.floor(index / 8),
            },
            extent: { width: size, height: size },
          });
          if (!result.ok || !result.buffer) throw new Error(JSON.stringify(result));
          bytes += result.buffer.byteLength;
          const bitmap = await createImageBitmap(new Blob([result.buffer]));
          context.drawImage(bitmap, (index % 4) * size, (Math.floor(index / 4) % 4) * size);
          bitmap.close();
        }
      }),
    );
    const elapsedMs = performance.now() - started;
    return { elapsedMs, bytes, pixel: [...context.getImageData(0, 0, 1, 1).data] };
  };
  window.closeBenchmark = async () => {
    for (const { send, port } of endpoints) {
      await send({ type: "close" });
      port.close();
    }
    canvas.width = canvas.height = 0;
  };
}

function median(values) {
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  console.log(
    JSON.stringify({
      baseline,
      samples,
      tiles: 32,
      concurrency: 4,
      cpu: cpus()[0].model,
      node: process.version,
      platform: process.platform,
      scope:
        "loopback authenticated JPEG GET through page MessageChannel, consumer decode and canvas draw; no final PNG save",
    }),
  );
  for (const [name, engine] of [
    ["chromium", chromium],
    ["firefox", firefox],
  ]) {
    const browser = await engine.launch();
    try {
      for (const version of ["2.4.2", "5.0.1", "6.1.1"]) {
        for (const size of [256, 1024]) {
          const page = await browser.newPage();
          try {
            await page.goto(url);
            await page.addScriptTag({
              content: seadragonLibrary(
                seadragonVersions.find((runtime) => runtime.version === version),
              ),
            });
            for (const content of bundles) await page.addScriptTag({ content });
            await page.evaluate(initialize, { size, count: 32, concurrency: 4 });
            const times = [[], []];
            const bytes = [];
            let pixel;
            // One warm-up pair, then alternate order to reduce ordering bias.
            for (let round = -1; round < samples; round++) {
              for (const implementation of round % 2 ? [1, 0] : [0, 1]) {
                const result = await page.evaluate(
                  (implementation) => runBatch(implementation),
                  implementation,
                );
                pixel ??= result.pixel;
                assert.deepEqual(result.pixel, pixel);
                if (round >= 0) times[implementation].push(result.elapsedMs);
                bytes[implementation] = result.bytes;
              }
            }
            const medians = times.map(median);
            console.log(
              JSON.stringify({
                browser: name,
                browserVersion: browser.version(),
                openseadragon: version,
                tileSize: size,
                jpegBytes: tiles.get(size).length,
                baselineMs: medians[0],
                currentMs: medians[1],
                speedup: medians[0] / medians[1],
                returnedBytes: bytes,
                samplesMs: times,
              }),
            );
            await page.evaluate(() => closeBenchmark());
          } finally {
            await page.close();
          }
        }
      }
    } finally {
      await browser.close();
    }
  }
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
