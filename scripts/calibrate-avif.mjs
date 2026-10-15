// Offline calibration of the production native encoder, never Sharp's encoder.
// Usage: node scripts/calibrate-avif.mjs target/release/dezoomify-cli
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";

const run = promisify(execFile);
const binary = path.resolve(process.argv[2] ?? "target/release/dezoomify-cli");
await stat(binary);
const root = new URL("../", import.meta.url);
const samples = [
  "testdata/scenarios/rs-core/formats/payloads/root-testdata/zoomify/test_custom_size/expected_result.png",
  "testdata/scenarios/rs-core/formats/payloads/google_arts_and_culture/tile.jpg",
  "testdata/scenarios/rs-core/formats/payloads/root-testdata/generic/map_expected.png",
];
const images = [];
for (const sample of samples) {
  const { data, info } = await sharp(await readFile(new URL(sample, root)))
    .resize({ width: 512, height: 512, fit: "inside", withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  images.push({ sample, data, width: info.width, height: info.height });
}
const painting = images[0];
const transparent = Buffer.from(painting.data);
for (let i = 3; i < transparent.length; i += 4) {
  transparent[i] = Math.round(((Math.floor(i / 4) % painting.width) / (painting.width - 1)) * 255);
}
images.push({ ...painting, sample: `${painting.sample} (alpha gradient)`, data: transparent });
const resources = new Map();
for (const [index, image] of images.entries()) {
  resources.set(
    `/${index}.dzi`,
    Buffer.from(
      `<Image xmlns="http://schemas.microsoft.com/deepzoom/2008" TileSize="256" Overlap="0" Format="png"><Size Width="${image.width}" Height="${image.height}"/></Image>`,
    ),
  );
  const level = Math.ceil(Math.log2(Math.max(image.width, image.height)));
  for (let y = 0; y < image.height; y += 256) {
    for (let x = 0; x < image.width; x += 256) {
      resources.set(
        `/${index}_files/${level}/${x / 256}_${y / 256}.png`,
        await sharp(image.data, { raw: { width: image.width, height: image.height, channels: 4 } })
          .extract({
            left: x,
            top: y,
            width: Math.min(256, image.width - x),
            height: Math.min(256, image.height - y),
          })
          .png()
          .toBuffer(),
      );
    }
  }
}
const server = createServer((request, response) => {
  const bytes = resources.get(request.url);
  response.writeHead(bytes ? 200 : 404, {
    "content-type": request.url.endsWith(".dzi") ? "application/xml" : "image/png",
  });
  response.end(bytes);
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const directory = await mkdtemp(path.join(tmpdir(), "dezoomify-avif-calibration-"));
const coefficients = [];
try {
  for (const quality of [1, 25, 50, 75, 90, 95, 98, 100]) {
    let maximum = 0;
    for (const [index, image] of images.entries()) {
      const output = path.join(directory, `${index}-${quality}.avif`);
      await run(
        binary,
        [
          "--largest",
          "--logging",
          "error",
          "--compression",
          String(100 - quality),
          "--tile-cache",
          path.join(directory, "cache"),
          `http://127.0.0.1:${server.address().port}/${index}.dzi`,
          output,
        ],
        { timeout: 120_000 },
      );
      const bytes = (await stat(output)).size;
      const bytesPerPixel = bytes / (image.width * image.height);
      maximum = Math.max(maximum, bytesPerPixel);
      console.log(
        JSON.stringify({ sample: image.sample, quality, speed: 4, bytes, bytesPerPixel }),
      );
    }
    coefficients.push({
      quality,
      bytes: Math.max(coefficients.at(-1)?.bytes ?? 0, Math.ceil(maximum * 20) / 20),
    });
  }
  console.log(JSON.stringify({ coefficients }));
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
