// Deterministic loopback origins for every product. Uses only Node built-ins.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { fileResponse, files, staticFile } from "./fixture-files.mjs";

const root = path.resolve(import.meta.dirname, "..");

function payloadFiles(scenariosDir) {
  const payloads = new Map();
  for (const file of files(scenariosDir)) {
    const relative = path.relative(scenariosDir, file).split(path.sep).join("/");
    const match = relative.match(/\/payloads\/([^/]+)\/(.+)$/);
    if (!match) continue;
    const key = `${match[1]}/${decodeURIComponent(match[2])}`;
    const previous = payloads.get(key);
    if (previous && !fs.readFileSync(previous).equals(fs.readFileSync(file))) {
      throw new Error(`Conflicting fixture files: ${previous} and ${file}`);
    }
    payloads.set(key, file);
  }
  return payloads;
}

function payloadFile(payloads, url) {
  const pathname = decodeURIComponent(url.pathname);
  const stem = pathname.endsWith("/") ? `${pathname}index` : pathname;
  // Captured text URLs can omit their stored extension.
  for (const candidate of [
    pathname,
    ...[".html", ".json", ".xml", ".txt"].map((ext) => stem + ext),
  ]) {
    const file = payloads.get(url.hostname + candidate);
    if (file) return file;
  }
  return null;
}

function template(bytes, headers, file, origin, host) {
  const tokens = ["{{origin}}", "{{localhost_origin}}", "{{host}}", "{{input}}"];
  if (
    headers.has("content-encoding") ||
    !tokens.some((token) => bytes.includes(Buffer.from(token)))
  )
    return bytes;
  const inputFile = file && path.join(path.dirname(file), "input.txt");
  const input =
    inputFile && fs.existsSync(inputFile)
      ? fs.readFileSync(inputFile, "utf8").trim()
      : "viewer.html";
  const localhost = new URL(origin);
  localhost.hostname = "localhost";
  return Buffer.from(
    bytes
      .toString()
      .replaceAll("{{origin}}", origin)
      .replaceAll("{{localhost_origin}}", localhost.origin)
      .replaceAll("{{host}}", host)
      .replaceAll("{{input}}", input),
  );
}

export async function startFixtureServer({
  port = 0,
  scenariosDir = path.join(root, "testdata/scenarios"),
  staticDir,
  requestLog,
  quiet = false,
} = {}) {
  const fixturesDir = path.join(root, "fixtures");
  const payloads = payloadFiles(scenariosDir);
  const handlers = [];
  for (const file of [...files(fixturesDir), ...files(scenariosDir)]) {
    if (path.basename(file) !== "server.js") continue;
    const { serve } = await import(pathToFileURL(file).href);
    if (typeof serve === "function") handlers.push({ file, serve });
  }
  let origin;
  if (requestLog) fs.writeFileSync(requestLog, "");
  const server = http.createServer(async (req, res) => {
    const entry = { method: req.method, request: req.url };
    const record = () => {
      if (requestLog) fs.appendFileSync(requestLog, `${JSON.stringify(entry)}\n`);
    };
    try {
      const incoming = new URL(req.url, origin);
      const url =
        incoming.pathname === "/fetch" ? new URL(incoming.searchParams.get("url")) : incoming;
      Object.assign(entry, {
        url: url === incoming ? url.href : incoming.searchParams.get("url"),
        path: incoming.pathname,
        query: incoming.search.slice(1) || null,
      });
      const file =
        payloadFile(payloads, url) ??
        (url.pathname.startsWith("/fixtures/")
          ? staticFile(fixturesDir, decodeURIComponent(url.pathname.slice(10)))
          : null);
      const request = new Request(url, { method: req.method, headers: req.headers });
      let response;
      for (const handler of handlers) {
        response = await handler.serve(request, { file, origin });
        if (response) {
          entry.handler = path.relative(root, handler.file);
          break;
        }
      }
      if (!response && file) {
        entry.file = path.relative(root, file);
        response = fileResponse(file);
      }
      const fixture = response;
      if (!response && url === incoming && staticDir) {
        const staticPath = staticFile(staticDir, decodeURIComponent(url.pathname.slice(1)));
        if (staticPath) response = fileResponse(staticPath);
      }
      response ??= new Response(`No fixture for ${entry.url}`, { status: 404 });
      let bytes = Buffer.from(await response.arrayBuffer());
      if (fixture) bytes = template(bytes, response.headers, file, origin, url.hostname);
      res.writeHead(response.status, {
        ...Object.fromEntries(response.headers),
        "access-control-allow-origin": "*",
        "access-control-expose-headers": "X-Set-Cookie",
        "content-length": bytes.length,
      });
      entry.status = response.status;
      record();
      res.end(req.method === "HEAD" ? undefined : bytes);
    } catch (error) {
      console.error(`Fixture request failed: ${req.method} ${req.url}`, error);
      res.writeHead(500, { "content-type": "text/plain", "access-control-allow-origin": "*" });
      entry.status = 500;
      entry.error = String(error);
      record();
      res.end(String(error));
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      origin = `http://127.0.0.1:${server.address().port}`;
      if (!quiet) console.error(`fixture server listening at ${origin}`);
      resolve({ server, origin });
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      port: { type: "string", default: "0" },
      "scenarios-dir": { type: "string" },
      "static-dir": { type: "string" },
      "request-log": { type: "string" },
      "write-address": { type: "string" },
      "parent-stdio": { type: "boolean" },
      quiet: { type: "boolean" },
    },
  });
  const options = {
    port: Number(values.port),
    scenariosDir: values["scenarios-dir"],
    staticDir: values["static-dir"],
    requestLog: values["request-log"],
    writeAddress: values["write-address"],
    parentStdio: values["parent-stdio"],
    quiet: values.quiet,
  };
  const { server, origin } = await startFixtureServer(options);
  if (options.writeAddress) fs.writeFileSync(options.writeAddress, `${origin.slice(7)}\n`);
  console.log(JSON.stringify({ origin }));
  const stop = () => {
    server.closeAllConnections();
    server.close(() => process.exit(0));
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  // Piped stdin ties server lifetime to its Rust or Node test parent.
  if (options.parentStdio) {
    process.stdin.resume();
    process.stdin.on("end", stop);
  }
}
