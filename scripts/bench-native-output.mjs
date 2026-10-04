// Linux end-to-end benchmark: release CLI binaries, fresh caches, real output.
// Usage: node scripts/bench-native-output.mjs OLD_CLI NEW_CLI
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const binaries = process.argv.slice(2);
if (binaries.length !== 2) throw new Error("Expected old and new release CLI paths");
const side = Number(process.env.SIDE ?? 8192);
const repeats = Number(process.env.REPEATS ?? 3);
const delay = Number(process.env.DELAY ?? 0);
const formats = (process.env.FORMATS ?? "png,jpg,tif,iiif,zif").split(",");
const target = fileURLToPath(new URL("../target/", import.meta.url));
await mkdir(target, { recursive: true });
const work = await mkdtemp(`${target}native-output-bench-`);
const fixture = new URL(
  "../testdata/scenarios/rs-core/formats/payloads/root-testdata/generic/",
  import.meta.url,
);
const tiles = await Promise.all(
  ["0_0", "1_0", "0_1", "1_1"].map((id) => readFile(new URL(`map_${id}.jpg`, fixture))),
);
let requests = 0;
const server = createServer(async (request, response) => {
  if (request.url.endsWith(".dzi")) {
    response.setHeader("content-type", "application/xml");
    response.end(
      `<Image xmlns="http://schemas.microsoft.com/deepzoom/2008" TileSize="256" Overlap="0" Format="jpg"><Size Width="${side}" Height="${side}"/></Image>`,
    );
    return;
  }
  const tile = request.url.match(/\/(\d+)_(\d+)\.jpg$/);
  if (!tile) {
    response.writeHead(404);
    response.end();
    return;
  }
  requests++;
  if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
  response.setHeader("content-type", "image/jpeg");
  response.end(tiles[(Number(tile[1]) % 2) + (Number(tile[2]) % 2) * 2]);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const input = `http://127.0.0.1:${server.address().port}/image.dzi`;
async function bytes(path) {
  const info = await stat(path);
  if (!info.isDirectory()) return info.size;
  return (await Promise.all((await readdir(path)).map((name) => bytes(`${path}/${name}`)))).reduce(
    (a, b) => a + b,
    0,
  );
}
try {
  for (const format of formats)
    for (let repeat = 0; repeat < repeats; repeat++) {
      for (const index of repeat % 2 ? [1, 0] : [0, 1]) {
        const name = index ? "current" : "master";
        const directory = `${work}/${name}-${format}-${repeat}`;
        await mkdir(directory);
        const output = `${directory}/out.${format}`;
        requests = 0;
        const started = performance.now();
        const child = spawn(
          "/usr/bin/time",
          [
            "-f",
            "%U %S %M",
            "-o",
            `${directory}/time`,
            binaries[index],
            "--largest",
            "--retries",
            "0",
            "--logging",
            "error",
            "--parallelism",
            "16",
            "--tile-cache",
            `${directory}/cache`,
            input,
            output,
          ],
          { stdio: ["ignore", "ignore", "pipe"] },
        );
        let error = "";
        child.stderr.on("data", (chunk) => {
          error += chunk;
        });
        const code = await new Promise((resolve, reject) => {
          child.on("exit", resolve);
          child.on("error", reject);
        });
        const wall = (performance.now() - started) / 1000;
        const [user, system, rss_kib] = (await readFile(`${directory}/time`, "utf8"))
          .trim()
          .split("\n")
          .at(-1)
          .split(/\s+/)
          .map(Number);
        const result = {
          name,
          format,
          side,
          delay,
          repeat,
          code,
          wall,
          user,
          system,
          rss_kib,
          requests,
        };
        if (code === 0) result.output_bytes = await bytes(output);
        else {
          result.error = error.trim();
          process.exitCode = 1;
        }
        console.log(JSON.stringify(result));
        if (!process.env.KEEP) await rm(directory, { recursive: true });
      }
    }
} finally {
  server.close();
  if (process.env.KEEP) console.error(`Outputs: ${work}`);
  else await rm(work, { recursive: true });
}
