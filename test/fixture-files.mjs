import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const types = {
  html: "text/html",
  js: "application/javascript",
  mjs: "application/javascript",
  css: "text/css",
  json: "application/json",
  xml: "application/xml",
  dzi: "application/xml",
  txt: "text/plain",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  wasm: "application/wasm",
  ico: "image/x-icon",
  yaml: "application/yaml",
  yml: "application/yaml",
};

export function files(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) =>
      entry.isDirectory() ? files(path.join(dir, entry.name)) : [path.join(dir, entry.name)],
    );
}

function contained(base, file) {
  if (!fs.realpathSync(file).startsWith(fs.realpathSync(base) + path.sep))
    throw new Error(`Fixture file is outside ${base}: ${file}`);
  return file;
}

// Missing files fall through; invalid paths and unexpected I/O failures do not.
export function staticFile(base, relative) {
  let file = path.join(base, relative);
  try {
    if (fs.statSync(file).isDirectory()) {
      file = path.join(
        file,
        fs.existsSync(path.join(file, "index.html")) ? "index.html" : "index.json",
      );
    }
    return contained(base, file);
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(error.code)) return null;
    throw error;
  }
}

export function replayUrl(origin, target) {
  const url = new URL("/fetch", origin);
  url.searchParams.set("url", target);
  return url.href;
}

// Also used by fixture-local handlers: headers/status are ordinary Response options.
export function fileResponse(file, init = {}) {
  if (file instanceof URL) file = fileURLToPath(file);
  const extension = path.extname(file).slice(1).toLowerCase();
  const resolvedExtension = path.extname(fs.realpathSync(file)).slice(1).toLowerCase();
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) {
    headers.set(
      "content-type",
      types[extension] ?? types[resolvedExtension] ?? "application/octet-stream",
    );
  }
  return new Response(fs.readFileSync(file), {
    ...init,
    headers,
  });
}
