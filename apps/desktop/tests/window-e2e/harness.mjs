// Hermetic fixture plumbing and app lifecycle for the real-window desktop E2E.
//
// The app embeds a W3C WebDriver server (tauri-plugin-wdio-webdriver, built via
// the `testing-webdriver` cargo feature) and a `selenium-webdriver` client drives
// it. This module owns the hermetic environment and the app lifecycle: an
// ephemeral loopback fixture server, a loopback static server for the built
// frontend (the debug window shell loads its embedded devUrl
// `http://localhost:1420`), an isolated per-run profile, WebDriver port
// allocation, app launch/readiness/teardown, deep-link delivery, and output
// helpers. Inputs are fixed, there is no public network, and reports carry
// origins, hashes, and stable codes only.
import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "../../../..");
export const SCENARIOS_DIR = path.join(REPO_ROOT, "testdata/scenarios");
const CARGO_TARGET_DIR = JSON.parse(
  spawnSync("cargo", ["metadata", "--format-version", "1", "--no-deps"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  }).stdout,
).target_directory;

// Windows builds `dezoomify-desktop.exe`; accept the extensionless lane value
// when the suffixed binary is the one on disk.
function withExe(candidate) {
  if (process.platform === "win32" && !existsSync(candidate) && existsSync(`${candidate}.exe`)) {
    return `${candidate}.exe`;
  }
  return candidate;
}

// The xtask lane stages lane-private copies and points these env vars at them,
// so a concurrent lean/frontend rebuild cannot swap the binaries mid-run.
export const APP_BIN = withExe(
  process.env.DEZOOMIFY_WINDOW_E2E_APP_BIN ||
    path.join(CARGO_TARGET_DIR, "debug/dezoomify-desktop"),
);
export const FRONTEND_DIST =
  process.env.DEZOOMIFY_WINDOW_E2E_DIST || path.join(REPO_ROOT, "apps/desktop/dist");
const FIXTURE_SERVER_BIN = withExe(
  path.join(CARGO_TARGET_DIR, "debug/dezoomify-fixture-server"),
);

// Fixed loopback port dictated by the embedded devUrl in `tauri.conf.json`.
export const FRONTEND_PORT = 1420;

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".map": "application/json",
  ".txt": "text/plain",
};

// Linux needs a display; macOS and Windows runners provide a GUI session.
// The xtask lane wraps the run in `xvfb-run` so this stays an explicit,
// fail-closed precondition.
export function assertDisplay() {
  if (process.platform !== "linux") return;
  if (process.env.DISPLAY) return;
  throw new Error(
    "window E2E: no display (DISPLAY is unset); rerun under `xvfb-run -a` " +
      "or start Xvfb and export DISPLAY first",
  );
}

export function ensureWindowShell() {
  if (!existsSync(APP_BIN)) {
    throw new Error(
      `window E2E: ${APP_BIN} is missing; run \`cargo xtask test desktop --e2e-window\` (it builds the window shell first)`,
    );
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Independent Node-side view of the scenario tree, for diagnosing a fixture
// server that loads a different route count than the checkout provides.
function countScenarioRoutes(dir) {
  let files = 0;
  let routes = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name === "routes.json") {
        files += 1;
        routes += JSON.parse(readFileSync(full, "utf8")).routes.length;
      }
    }
  }
  return { files, routes };
}

// Set by `startWindowApp` before the app is launched; live binding so the spec
// can read it after startup. Never a fixed shared port: the embedded server
// gets an ephemeral loopback port the kernel hands out.
export let WEBDRIVER_URL = null;

// Allocate a free loopback port by binding port 0 and closing the probe. The
// app then binds that port; the tiny close-to-bind race is covered by the
// readiness poll below.
async function allocateWebDriverPort() {
  return await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : null;
      probe.close((err) => {
        if (err) reject(err);
        else if (!port) reject(new Error("could not allocate a WebDriver port"));
        else resolve(port);
      });
    });
  });
}

// Launch the window shell with the embedded WebDriver server on an ephemeral
// port. Output is teed to the run directory and captured for fail-closed
// errors. Readiness is the plugin's `GET /status` contract
// (`{value:{ready:true}}`); a premature exit or missed deadline fails with the
// captured log as evidence.
export async function startWindowApp(home) {
  assertDisplay();
  ensureWindowShell();
  const port = await allocateWebDriverPort();
  const logPath = path.join(path.dirname(home), "app.log");
  const chunks = [];
  const capture = (chunk) => {
    chunks.push(chunk.toString());
    if (chunks.length > 500) chunks.shift();
    appendFileSync(logPath, chunk);
  };
  const env = {
    ...process.env,
    ...laneAppEnv(home),
    TAURI_WEBDRIVER_PORT: String(port),
  };
  const proc = spawn(APP_BIN, [], { env, stdio: ["ignore", "pipe", "pipe"] });
  proc.stdout.on("data", capture);
  proc.stderr.on("data", capture);
  WEBDRIVER_URL = `http://127.0.0.1:${port}`;
  const url = WEBDRIVER_URL;
  const app = { proc, port, logPath, logs: () => chunks.join("") };

  let exited = null;
  proc.once("exit", (code, signal) => {
    exited = { code, signal };
  });
  const deadline = Date.now() + 180000;
  for (;;) {
    if (exited) {
      throw new Error(
        `window E2E: app exited before the WebDriver server became ready ` +
          `(${JSON.stringify(exited)}):\n${app.logs()}`,
      );
    }
    try {
      const response = await fetch(`${url}/status`, {
        signal: AbortSignal.timeout(2000),
      });
      if (response.ok) {
        const body = await response.json();
        if (body?.value?.ready === true) return app;
      }
    } catch {
      // Not listening yet.
    }
    if (Date.now() >= deadline) {
      await stopWindowApp(app);
      throw new Error(
        `window E2E: WebDriver server at ${url} was not ready within 180 s:\n${app.logs()}`,
      );
    }
    await sleep(250);
  }
}

// Stop the app and wait for it to exit. `run_node_with_deadline` owns the
// process tree, so a leaked app is still killed on a lane deadline; this makes
// normal teardown deterministic instead of relying on that backstop.
export async function stopWindowApp(app) {
  if (!app || !app.proc) return;
  const { proc } = app;
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  const exited = new Promise((resolve) => proc.once("exit", resolve));
  try {
    proc.kill("SIGTERM");
  } catch {
    // Already gone.
  }
  const timeout = new Promise((resolve) => setTimeout(() => resolve("timeout"), 5000));
  if ((await Promise.race([exited, timeout])) === "timeout") {
    try {
      proc.kill("SIGKILL");
    } catch {
      // Already gone.
    }
    await exited;
  }
}

function buildBinary(bin, pkg) {
  const build = spawnSync("cargo", ["build", "-p", pkg], { cwd: REPO_ROOT, encoding: "utf8" });
  if (build.status !== 0) throw new Error(`cargo build -p ${pkg} failed:\n${build.stderr}`);
  if (!existsSync(bin)) throw new Error(`binary missing after build: ${bin}`);
}

export function ensureFixtureServerBuilt() {
  buildBinary(FIXTURE_SERVER_BIN, "dezoomify-fixture-server");
}

// Same binary and flags the `cargo xtask fixtures serve --port 0` path spawns:
// loopback only, kernel-allocated port, address readiness file.
export async function startFixtureServer(workDir) {
  const addrFile = path.join(workDir, "server.addr");
  const requestLog = path.join(workDir, "requests.log");
  const proc = spawn(FIXTURE_SERVER_BIN, [
    "--port",
    "0",
    "--write-address",
    addrFile,
    "--scenarios-dir",
    SCENARIOS_DIR,
    "--request-log",
    requestLog,
  ]);
  const chunks = [];
  proc.stdout.on("data", (chunk) => chunks.push(chunk.toString()));
  proc.stderr.on("data", (chunk) => chunks.push(chunk.toString()));
  let base = null;
  for (let i = 0; i < 100 && !base; i += 1) {
    const bound = existsSync(addrFile) ? readFileSync(addrFile, "utf8").trim() : null;
    if (bound) base = `http://${bound}`;
    else await new Promise((r) => setTimeout(r, 100));
  }
  if (!base) {
    proc.kill();
    throw new Error("fixture server did not report its address");
  }
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(base)) {
    proc.kill();
    throw new Error("fixture server address is not loopback");
  }
  const fixture = { proc, base, requestLog, logs: () => chunks.join("") };
  // Fail closed before the app launches if the harness itself cannot read the
  // gateway; otherwise an app-side discovery failure is hard to attribute.
  try {
    const response = await fetch(`${base}/fetch?url=${encodeURIComponent("https://fixtures.test/cli/pyramid.dzi")}`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
      throw new Error(`fixture gateway returned ${response.status}: ${await response.text()}`);
    }
  } catch (error) {
    stopFixtureServer(fixture);
    const log = existsSync(requestLog) ? readFileSync(requestLog, "utf8") : "";
    let tree = "unavailable";
    try {
      tree = JSON.stringify(countScenarioRoutes(SCENARIOS_DIR));
    } catch (treeError) {
      tree = `error: ${treeError.message}`;
    }
    throw new Error(
      `window E2E: fixture gateway unreachable at ${base}: ${error.message}\n` +
        `node scenario tree: ${tree}\n${fixture.logs()}\n${log}`,
    );
  }
  return fixture;
}

export function stopFixtureServer(fixture) {
  if (!fixture) return;
  try {
    fixture.proc.kill();
  } catch {
    // Already gone.
  }
}

// Serves the freshly built frontend over loopback on the embedded devUrl port.
// Fails closed when the port is held, naming the constraint.
export async function startFrontendServer() {
  if (!existsSync(path.join(FRONTEND_DIST, "index.html"))) {
    throw new Error(
      `window E2E: ${FRONTEND_DIST}/index.html is missing; ` +
        "run `cargo xtask build desktop --unsigned-test` first",
    );
  }
  const server = http.createServer((req, res) => {
    // The shell loads `http://localhost:1420`; dual-stack binding accepts both
    // the IPv6 (::1) and IPv4 (127.0.0.1) resolutions of localhost. Reject any
    // non-loopback peer so the ephemeral server never serves the network.
    const remote = req.socket.remoteAddress ?? "";
    const loopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
    if (!loopback) {
      res.writeHead(403);
      res.end("forbidden");
      return;
    }
    let name = "/";
    try {
      name = decodeURIComponent(new URL(req.url ?? "/", "http://loopback").pathname);
    } catch {
      res.writeHead(400);
      res.end("bad path");
      return;
    }
    if (name === "/") name = "/index.html";
    // The document CSP only permits same-origin scripts. Serve the ephemeral
    // test setting as one instead of injecting an inline script, which WebKit
    // correctly rejects and would silently leave the app on Downloads.
    if (name === "/e2e-settings.js") {
      const outputDir = process.env.DEZOOMIFY_WINDOW_E2E_OUTPUT;
      if (!outputDir) throw new Error("window E2E output directory is unset");
      const settings = JSON.stringify({ outputDir });
      res.writeHead(200, { "Content-Type": "text/javascript" });
      res.end(`localStorage.setItem("dezoomify.desktop.settings.v1", ${JSON.stringify(settings)});`);
      return;
    }
    const file = path.join(FRONTEND_DIST, name);
    if (!file.startsWith(FRONTEND_DIST) || !existsSync(file)) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    let body = readFileSync(file);
    // Configure the isolated test profile before the desktop entry module
    // reads localStorage. This is setup, not a second settings control: the
    // window still exposes its normal Folder picker to users. Native file
    // pickers cannot be driven consistently by W3C WebDriver on all three
    // desktop platforms, while the saved settings are the product's own
    // supported persistence boundary.
    if (name === "/index.html") {
      const outputDir = process.env.DEZOOMIFY_WINDOW_E2E_OUTPUT;
      if (!outputDir) throw new Error("window E2E output directory is unset");
      body = Buffer.from(
        body.toString("utf8").replace(
          "</head>",
          '<script src="/e2e-settings.js"></script></head>',
        ),
      );
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream",
    });
    res.end(body);
  });
  await new Promise((resolve, reject) => {
    server.once("error", (err) => {
      reject(
        new Error(
          `window E2E: cannot serve the built frontend on 127.0.0.1:${FRONTEND_PORT} ` +
            `(the debug window shell loads that embedded devUrl address): ${err.message}`,
        ),
      );
    });
    server.listen(FRONTEND_PORT, resolve);
  });
  return server;
}

// Tear the shared frontend server down without hanging the spec process: idle
// keep-alive sockets would otherwise make `close()` wait forever.
export async function closeFrontendServer(server) {
  if (!server) return;
  if (typeof server.closeAllConnections === "function") server.closeAllConnections();
  await new Promise((resolve) => {
    const done = () => resolve();
    server.close(done);
    setTimeout(done, 5000).unref?.();
  });
}

// One isolated run profile: a temp root, an isolated HOME, and an empty output
// directory. The service inherits `HOME`/XDG from the process environment, so
// the app never touches a real user profile.
export function createRunDirs() {
  const root = mkdtempSync(path.join(tmpdir(), "dezoomify-window-e2e-"));
  const home = path.join(root, "home");
  const output = path.join(root, "outputs");
  mkdirSync(home, { recursive: true });
  mkdirSync(output, { recursive: true });
  return { root, home, output };
}

// Isolated app environment: temp HOME plus XDG dirs (no shared caches). Mesa
// shader-cache writes are disabled so teardown never races a late cache flush.
// On Windows the POSIX HOME/XDG pair is irrelevant, so the profile roots move
// under the temp home too, including the WebView2 user-data override.
export function laneAppEnv(home) {
  const env = {
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local/share"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    MESA_SHADER_CACHE_DISABLE: "1",
    MESA_SHADER_CACHE_DIR: path.join(home, ".cache", "mesa_shader_cache"),
  };
  if (process.platform === "win32") {
    const localAppData = path.join(home, "AppData", "Local");
    const roamingAppData = path.join(home, "AppData", "Roaming");
    const tempDir = path.join(home, "Temp");
    mkdirSync(localAppData, { recursive: true });
    mkdirSync(roamingAppData, { recursive: true });
    mkdirSync(tempDir, { recursive: true });
    env.USERPROFILE = home;
    env.APPDATA = roamingAppData;
    env.LOCALAPPDATA = localAppData;
    env.TEMP = tempDir;
    env.TMP = tempDir;
    env.WEBVIEW2_USER_DATA_FOLDER = path.join(localAppData, "WebView2");
  }
  return env;
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`window E2E: ${name} is unset; run through \`cargo xtask test desktop --e2e-window\``);
  }
  return value;
}

export function runOutputDir() {
  return requireEnv("DEZOOMIFY_WINDOW_E2E_OUTPUT");
}

export function fixtureBase() {
  return requireEnv("DEZOOMIFY_WINDOW_E2E_BASE");
}

export function gatewayInput(innerUrl) {
  return `${fixtureBase()}/fetch?url=${innerUrl}`;
}

export function deepLinkArgv(input) {
  return `dezoomify://open?v=2&src=${encodeURIComponent(input)}`;
}

// Automatic desktop saves derive their filename from the fixture catalog title,
// so the resulting file is located by extension in the empty per-run directory.
export function outputFiles(outputDir, extension = ".png") {
  return readdirSync(outputDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(extension))
    .map((entry) => path.join(outputDir, entry.name));
}

// Delivers a deep link the way the OS does: a second app process with the link
// argv forwards it to the running window through the single-instance channel
// and exits. The link performs no effect until the frontend confirm gate
// accepts it. Times out fail-closed when the forwarder lingers.
export async function deliverDeepLink({ env, link }) {
  const child = spawn(APP_BIN, [link], { env, stdio: "ignore" });
  const done = new Promise((resolve) => child.once("exit", resolve));
  const timeout = new Promise((resolve) => setTimeout(() => resolve("timeout"), 30000));
  const result = await Promise.race([done, timeout]);
  if (result === "timeout") {
    child.kill();
    throw new Error("window E2E: deep-link forwarder did not exit in time");
  }
}

export { FIXTURE_SERVER_BIN };
