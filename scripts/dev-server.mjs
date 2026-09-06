// Local development server for `cargo xtask dev web` / `dev ui`.
//
// Serves the assembled dist/ tree (static files, exactly as deployed) and
// routes /api/proxy to the same pure metadata relay that Cloudflare runs via
// functions/api/proxy.ts and that node:test exercises directly. There is no
// separate proxy process and nothing to install: the relay is a plain TS
// module under src/server/, imported here like any other source.
//
// Usage:
//   node scripts/dev-server.mjs --port 8080 --static-dir dist
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handleNodeProxyRequest } from "../src/server/proxy-node.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const CONTENT_TYPES = {
  html: "text/html",
  js: "application/javascript",
  css: "text/css",
  json: "application/json",
  xml: "text/xml",
  dzi: "text/xml",
  txt: "text/plain",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  wasm: "application/wasm",
  mjs: "application/javascript",
  ico: "image/x-icon",
  yaml: "application/yaml",
  yml: "application/yaml",
};

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

function serveStatic(staticDir, pathname, req, res) {
  const headOnly = req.method === "HEAD";
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { "content-type": "text/plain", "content-length": "18" });
    res.end(headOnly ? undefined : "method not allowed");
    return;
  }
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    res.writeHead(400, { "content-type": "text/plain" });
    res.end("bad request");
    return;
  }
  const rel = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  if (rel.includes("..") || rel.includes("\0")) {
    res.writeHead(403, { "content-type": "text/plain", "content-length": "9" });
    res.end(headOnly ? undefined : "forbidden");
    return;
  }
  const full = path.resolve(staticDir, rel);
  const base = path.resolve(staticDir);
  if (full !== base && !full.startsWith(base + path.sep)) {
    res.writeHead(403, { "content-type": "text/plain", "content-length": "9" });
    res.end(headOnly ? undefined : "forbidden");
    return;
  }
  let stat;
  try {
    stat = fs.statSync(full);
  } catch {
    res.writeHead(404, { "content-type": "text/plain", "content-length": "9" });
    res.end(headOnly ? undefined : "not found");
    return;
  }
  const target = stat.isDirectory() ? path.join(full, "index.html") : full;
  let bytes;
  try {
    bytes = fs.readFileSync(target);
  } catch {
    res.writeHead(404, { "content-type": "text/plain", "content-length": "9" });
    res.end(headOnly ? undefined : "not found");
    return;
  }
  res.writeHead(200, {
    "content-type": contentTypeFor(target),
    "content-length": bytes.length,
  });
  res.end(headOnly ? undefined : bytes);
}

/**
 * Build the dev-server request handler. `staticDir` is the assembled dist/
 * tree; `proxyHandler` defaults to the real Node proxy adapter and is only
 * replaced by tests.
 */
export function createDevServerHandler({ staticDir, proxyHandler = handleNodeProxyRequest }) {
  const absoluteStaticDir = path.resolve(staticDir);
  return async function handler(req, res) {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/api/proxy") {
      await proxyHandler(req, res);
      return;
    }
    serveStatic(absoluteStaticDir, url.pathname, req, res);
  };
}

function usage() {
  console.error("usage: node scripts/dev-server.mjs --port N --static-dir DIR");
  process.exit(2);
}

function parseArgs(argv) {
  let port = 8080;
  let staticDir = path.join(ROOT, "dist");
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--port") {
      port = Number(argv[++i]);
    } else if (argv[i] === "--static-dir") {
      staticDir = argv[++i];
    } else {
      usage();
    }
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) usage();
  if (!fs.existsSync(staticDir)) {
    console.error(`static dir missing: ${staticDir}`);
    process.exit(1);
  }
  return { port, staticDir };
}

function main() {
  const { port, staticDir } = parseArgs(process.argv.slice(2));
  const handler = createDevServerHandler({ staticDir });
  const server = http.createServer(handler);
  server.listen(port, "127.0.0.1", () => {
    console.error(`dev server: http://127.0.0.1:${port}/ (Ctrl-C to stop)`);
  });
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => server.close(() => process.exit(0)));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
