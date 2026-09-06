// Dev-server wiring: the single local server serves the dist/ tree and
// routes /api/proxy to the real relay. Requests are made with node:http
// (not fetch) so tests can stub the relay's upstream `fetch` without
// disturbing their own HTTP client.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createDevServerHandler } from "../scripts/dev-server.mjs";

async function withServer(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${port}`;
}

function request(base, pathname, { method = "GET", headers = {}, body } = {}) {
  const url = new URL(pathname, base);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const bytes = Buffer.concat(chunks);
          resolve({
            status: res.statusCode,
            headers: res.headers,
            text: () => Promise.resolve(bytes.toString("utf8")),
          });
        });
      },
    );
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

test("dev server serves static files with content types and directory index", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dz-dev-server-"));
  fs.writeFileSync(path.join(dir, "index.html"), "<h1>root</h1>");
  fs.mkdirSync(path.join(dir, "beta"), { recursive: true });
  fs.writeFileSync(path.join(dir, "beta", "index.html"), "<h1>beta</h1>");
  fs.writeFileSync(path.join(dir, "beta", "app.js"), "console.log(1)");
  const base = await withServer(t, createDevServerHandler({ staticDir: dir }));

  const root = await request(base, "/");
  assert.equal(root.status, 200);
  assert.equal(await root.text(), "<h1>root</h1>");

  const beta = await request(base, "/beta/");
  assert.equal(beta.status, 200);
  assert.equal(await beta.text(), "<h1>beta</h1>");

  const js = await request(base, "/beta/app.js");
  assert.equal(js.status, 200);
  assert.equal(js.headers["content-type"], "application/javascript");
  assert.equal(await js.text(), "console.log(1)");

  const missing = await request(base, "/nope.txt");
  assert.equal(missing.status, 404);
});

test("dev server refuses path traversal", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dz-dev-server-"));
  fs.writeFileSync(path.join(dir, "index.html"), "ok");
  const base = await withServer(t, createDevServerHandler({ staticDir: dir }));
  // Encoded slash keeps the .. literal intact through URL parsing; the
  // server decodes it and must refuse before touching the filesystem.
  const res = await request(base, "/..%2fetc/passwd");
  assert.equal(res.status, 403);
});

test("dev server routes /api/proxy to the real relay", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dz-dev-server-"));
  fs.writeFileSync(path.join(dir, "index.html"), "ok");
  const handler = createDevServerHandler({ staticDir: dir });
  const base = await withServer(t, handler);

  const upstream = t.mock.method(globalThis, "fetch", () =>
    Promise.resolve(
      new Response('{"ok":true}', {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ),
  );

  const res = await request(base, "/api/proxy", {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ targetUrl: "https://public.test/iiif.json", protocolVersion: 1 }),
  });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '{"ok":true}');
  assert.equal(res.headers["access-control-allow-origin"], base);
  // The proxy relayed upstream, not the static handler.
  assert.equal(upstream.mock.callCount(), 1);
  assert.equal(upstream.mock.calls[0].arguments[1].redirect, "manual");
});

test("dev server answers a loopback proxy target without touching the network", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dz-dev-server-"));
  fs.writeFileSync(path.join(dir, "index.html"), "ok");
  const handler = createDevServerHandler({ staticDir: dir });
  const base = await withServer(t, handler);

  const upstream = t.mock.method(globalThis, "fetch", () => {
    throw new Error("must not fetch");
  });
  const res = await request(base, "/api/proxy", {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ targetUrl: "http://127.0.0.1/x.json", protocolVersion: 1 }),
  });
  assert.equal(res.status, 403);
  assert.equal(upstream.mock.callCount(), 0);
});
