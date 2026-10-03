// Deterministic loopback origins for every product. Uses only Node built-ins.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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
const contentType = (name) =>
  types[path.extname(name).slice(1).toLowerCase()] ?? "application/octet-stream";
const routeId = (host, target) =>
  `${host}-${target}`
    .replace(/[^a-z0-9]+/gi, "-")
    .toLowerCase()
    .replace(/^-|-$/g, "")
    .slice(0, 100) || "route";
const safe = (name) => !name.includes("..") && !path.isAbsolute(name);

function files(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .flatMap((entry) =>
      entry.isDirectory() ? files(path.join(dir, entry.name)) : [path.join(dir, entry.name)],
    );
}

async function loadRoutes(dir) {
  const all = files(dir);
  const routes = [];
  const claimed = new Set();
  const served = new Set();
  for (const file of all.filter((name) => path.basename(name) === "routes.json")) {
    const scenario = path.relative(dir, path.dirname(file)).split(path.sep).join("/");
    const entries = JSON.parse(fs.readFileSync(file, "utf8")).routes;
    if (entries.length > 1000) throw new Error(`too many routes in ${file}`);
    for (const entry of entries) {
      const route = { method: "GET", status: 200, headers: {}, ...entry, scenario };
      route.route_id ||= routeId(
        route.host ?? "any",
        route.path ?? route.path_prefix ?? route.path_regex ?? "route",
      );
      if (route.payload) {
        if (!safe(route.payload)) throw new Error(`unsafe payload path: ${route.payload}`);
        claimed.add(`${scenario}/${route.payload}`);
      }
      if (route.path_regex) {
        if (route.path_regex.length > 500)
          throw new Error(`path_regex too long: ${route.route_id}`);
        route.regex = new RegExp(route.path_regex);
      }
      served.add(`${route.host}${route.path}:${route.method}`);
      if (!route.payload) {
        const module = await import(pathToFileURL(path.join(path.dirname(file), "server.js")).href);
        if (typeof module.serve !== "function")
          throw new Error(`${scenario}/server.js must export serve(Request): Response`);
        route.serve = module.serve;
      }
      routes.push(route);
    }
  }
  for (const file of all) {
    const relative = path.relative(dir, file).split(path.sep).join("/");
    const match = relative.match(/^(.*?)\/(payloads\/([^/]+)\/(.+))$/);
    if (!match || claimed.has(relative)) continue;
    const [, scenario, payload, host, tail] = match;
    const urlPath = `/${tail}`;
    const key = `${host}${urlPath}:GET`;
    if (!safe(payload) || served.has(key)) continue;
    served.add(key);
    routes.push({
      scenario,
      payload,
      host,
      path: urlPath,
      method: "GET",
      status: 200,
      route_id: `layout-${host}-${tail}`,
      headers: { "content-type": contentType(tail) },
    });
  }
  return routes;
}

function lookup(routes, host, pathname, query) {
  for (const candidate of [
    pathname,
    ...[".html", ".json", ".xml", ".txt"].map(
      (suffix) => pathname + (pathname.endsWith("/") ? "index" : "") + suffix,
    ),
  ]) {
    for (const exact of [true, false]) {
      const route = routes.find(
        (r) =>
          r.method.toUpperCase() === "GET" &&
          (!r.host || r.host.toLowerCase() === host.toLowerCase()) &&
          Boolean(r.path) === exact &&
          (r.path
            ? r.path === candidate
            : r.path_prefix
              ? candidate.startsWith(r.path_prefix)
              : r.regex?.test(candidate)) &&
          (r.query == null || r.query === query),
      );
      if (route) return route;
    }
  }
  return null;
}

function originalParts(url) {
  // Parse without URL's dot-segment normalization so hostile paths are rejected.
  const match = url.match(/^https?:\/\/([^/]+)(\/[^?]*)?(?:\?(.*))?$/);
  if (!match || /[@\s]/.test(match[1]) || match[2]?.includes("..")) return null;
  return {
    host: match[1].replace(/:\d+$/, "").toLowerCase(),
    pathname: match[2] ?? "/",
    query: match[3] ?? null,
  };
}

function decodeBase64(text) {
  const normalized = text.replace(/\s/g, "").replaceAll("-", "+").replaceAll("_", "/");
  if (!/^[a-z\d+/]*={0,2}$/i.test(normalized) || normalized.length % 4 === 1) {
    throw new Error("bad base64");
  }
  return Buffer.from(normalized, "base64");
}

export async function startFixtureServer({
  port = 0,
  scenariosDir = path.join(root, "testdata/scenarios"),
  staticDir,
  requestLog,
  quiet = false,
} = {}) {
  const routes = await loadRoutes(scenariosDir);
  const handlers = (
    await Promise.all(
      files(path.join(root, "fixtures"))
        .filter((file) => path.basename(file) === "server.js")
        .map(async (file) => (await import(pathToFileURL(file).href)).serve),
    )
  ).filter((handler) => typeof handler === "function");
  let origin;
  const record = (entry) => {
    if (requestLog) fs.appendFileSync(requestLog, `${JSON.stringify(entry)}\n`);
  };
  if (requestLog) fs.writeFileSync(requestLog, "");
  const server = http.createServer(async (req, res) => {
    const head = req.method === "HEAD";
    const send = (status, bytes, headers = { "content-type": "text/plain" }) => {
      bytes = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
      res.writeHead(status, {
        ...headers,
        "access-control-allow-origin": "*",
        "access-control-expose-headers": "X-Set-Cookie",
        "content-length": bytes.length,
      });
      res.end(head ? undefined : bytes);
    };
    const custom = async () => {
      const request = new Request(new URL(req.url, origin), {
        method: req.method,
        headers: req.headers,
      });
      for (const serve of handlers) {
        const response = await serve(request);
        if (response.status === 404) continue;
        send(
          response.status,
          Buffer.from(await response.arrayBuffer()),
          Object.fromEntries(response.headers),
        );
        return true;
      }
      return false;
    };
    if (req.method !== "GET" && !head) return send(405, "method not allowed");
    try {
      const [rawPath] = req.url.split("?");
      const pathname = decodeURIComponent(rawPath);
      const query = req.url.includes("?") ? req.url.slice(req.url.indexOf("?") + 1) : null;
      if (pathname.startsWith("/fixtures/")) {
        const relative = pathname.slice(10);
        if (!safe(relative)) return send(403, "forbidden");
        const base = path.join(root, "fixtures");
        let target = path.join(base, relative);
        try {
          if (fs.statSync(target).isDirectory())
            target = path.join(
              target,
              fs.existsSync(path.join(target, "index.html")) ? "index.html" : "index.json",
            );
          if (!fs.realpathSync(target).startsWith(base + path.sep)) return send(403, "forbidden");
          let bytes = fs.readFileSync(target);
          const type = contentType(target);
          if (bytes.includes(Buffer.from("{{origin}}")))
            bytes = Buffer.from(bytes.toString().replaceAll("{{origin}}", origin));
          if (bytes.includes(Buffer.from("{{input}}")))
            bytes = Buffer.from(
              bytes
                .toString()
                .replaceAll(
                  "{{input}}",
                  fs.existsSync(path.join(path.dirname(target), "input.txt"))
                    ? fs.readFileSync(path.join(path.dirname(target), "input.txt"), "utf8").trim()
                    : "viewer.html",
                ),
            );
          return send(200, bytes, { "content-type": type });
        } catch {
          if (await custom()) return;
        }
      }
      const params = new URLSearchParams(query ?? "");
      const via =
        pathname === "/proxy"
          ? "proxy"
          : pathname === "/fetch" || pathname.startsWith("/fetch/")
            ? "fetch"
            : "direct";
      let parts;
      let entry;
      if (via !== "direct") {
        const original =
          params.get("url") ??
          (pathname.startsWith("/fetch/")
            ? pathname.slice(7) + (query === null ? "" : `?${query}`)
            : null);
        if (original === null) return send(400, "missing url");
        entry = { via, url: original };
        if (original.startsWith("data:")) {
          const data = original.slice(5);
          const comma = data.indexOf(",");
          const meta = comma < 0 ? "" : data.slice(0, comma);
          const payload = comma < 0 ? data : data.slice(comma + 1);
          let bytes;
          try {
            bytes = meta.includes(";") ? decodeBase64(payload) : payload;
          } catch {
            record({ ...entry, status: 400, route: "data" });
            return send(400, "bad data url");
          }
          record({ ...entry, status: 200, route: "data" });
          return send(200, bytes, {
            "content-type": meta.split(";")[0] || "text/plain",
          });
        }
        parts = originalParts(original);
        if (!parts) {
          record({ ...entry, status: 400, route: null });
          return send(400, "bad url");
        }
      } else {
        parts = {
          host: (req.headers.host ?? "127.0.0.1").replace(/:\d+$/, "").toLowerCase(),
          pathname,
          query,
        };
        entry = { via, host: parts.host, path: pathname, query };
      }
      const route = lookup(routes, parts.host, parts.pathname, parts.query);
      if (route) {
        entry = { ...entry, route: route.route_id, scenario: route.scenario };
        const cookies = Object.fromEntries(
          (req.headers.cookie ?? "").split(";").flatMap((pair) => {
            const equals = pair.indexOf("=");
            return equals < 0 ? [] : [[pair.slice(0, equals).trim(), pair.slice(equals + 1)]];
          }),
        );
        for (const [name, value] of Object.entries(route.required_cookies ?? {})) {
          if (cookies[name] !== value) {
            record({ ...entry, status: 403, auth: "missing-required-cookie", cookie_name: name });
            return send(403, `fixture auth required: missing cookie ${name}`);
          }
        }
        for (const [name, value] of Object.entries(route.required_headers ?? {})) {
          if (req.headers[name.toLowerCase()] !== value.replaceAll("{{origin}}", origin)) {
            record({ ...entry, status: 403, missing_header: name });
            return send(403, `fixture requires header ${name}`);
          }
        }
        const headers = Object.fromEntries(
          Object.entries(route.headers).map(([k, v]) => [k.toLowerCase(), v]),
        );
        const read = (name) => {
          if (!safe(name)) throw 403;
          return fs.readFileSync(path.join(scenariosDir, route.scenario, name));
        };
        try {
          if (route.serve) {
            const request = new Request(entry.url ?? new URL(req.url, origin), {
              method: req.method,
              headers: Object.entries(req.headers).map(([name, value]) => [name, String(value)]),
            });
            const response = await route.serve(request);
            const bytes = Buffer.from(await response.arrayBuffer());
            record({ ...entry, status: response.status });
            return send(response.status, bytes, {
              ...headers,
              ...Object.fromEntries(response.headers),
            });
          }
          let bytes = read(route.payload);
          if (/^(text\/)|json|xml|yaml|javascript|svg/.test(headers["content-type"] ?? "")) {
            bytes = Buffer.from(
              bytes
                .toString()
                .replaceAll("{{origin}}", origin)
                .replaceAll("{{localhost_origin}}", origin.replace("127.0.0.1", "localhost"))
                .replaceAll("{{host}}", parts.host),
            );
          }
          record({ ...entry, status: route.status });
          return send(route.status, bytes, headers);
        } catch (error) {
          const status = typeof error === "number" ? error : 500;
          record({ ...entry, status });
          return send(status, "fixture error");
        }
      }
      record({ ...entry, status: 404, route: null });
      if (via !== "direct")
        return send(404, JSON.stringify({ error: "fixture-missing", url: entry.url }), {
          "content-type": "application/json",
        });
      if (await custom()) return;
      if (!staticDir) return send(404, "not found");
      const relative = pathname === "/" ? "index.html" : pathname.slice(1);
      if (!safe(relative)) return send(403, "forbidden");
      let target = path.join(staticDir, relative);
      try {
        if (fs.statSync(target).isDirectory()) target = path.join(target, "index.html");
        const base = fs.realpathSync(staticDir);
        if (!fs.realpathSync(target).startsWith(base + path.sep)) return send(403, "forbidden");
        return send(200, fs.readFileSync(target), { "content-type": contentType(target) });
      } catch {
        return send(404, "not found");
      }
    } catch {
      return send(400, "bad request");
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      origin = `http://127.0.0.1:${server.address().port}`;
      if (!quiet) {
        console.error(
          `fixture server loaded ${routes.length} routes from ${new Set(routes.map((r) => r.scenario)).size} scenarios`,
        );
        console.error(`fixture server listening at ${origin}`);
      }
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
  if (
    options.port !== undefined &&
    (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535)
  )
    throw new Error("invalid port");
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
