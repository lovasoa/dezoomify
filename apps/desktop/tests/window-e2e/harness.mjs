// Real-window lifecycle for the Tauri desktop app E2E.
//
// One isolated run owns: an ephemeral loopback fixture server (same binary
// and flags as `cargo xtask fixtures serve --port 0`), a loopback static
// server for the built frontend, tauri-driver on an ephemeral port with the
// platform native driver on another ephemeral port, and one app launch with
// an isolated profile (HOME plus XDG dirs under a temp dir, fixed inputs,
// fixed seed, no wall-clock assertions).
//
// Hermetic notes:
// - Never contacts public websites: every submit URL is a loopback gateway
//   (`/fetch?url=<scenario dumping ground>`) served from `testdata/scenarios`.
// - The native save dialog is not WebDriver-automatable, so the app honors
//   `DEZOOMIFY_E2E_FIXED_DESTINATION` only together with the explicit
//   `DEZOOMIFY_E2E_WINDOW=1` flag (see `commands::e2e_fixed_destination`);
//   production never sets either, so the dialog always shows there.
// - The debug window shell loads its embedded devUrl (`http://localhost:1420`,
//   baked into the disowned `tauri.conf.json`), so the harness serves the
//   freshly built `apps/desktop/dist` there over loopback. Port 1420 is
//   dictated by that embedded value; anything else holding it fails this
//   gate closed with the holder named.
// - Reports carry origins, hashes, and stable codes only: never credentials,
//   full URLs, or absolute paths.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import webdriver from "selenium-webdriver";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../../..");
const SCENARIOS_DIR = path.join(REPO_ROOT, "testdata/scenarios");
const FRONTEND_DIST = path.join(REPO_ROOT, "apps/desktop/dist");
const FIXTURE_SERVER_BIN = path.join(REPO_ROOT, "target/debug/dezoomify-fixture-server");
const APP_BIN = path.join(REPO_ROOT, "target/debug/dezoomify-desktop");

// Deterministic seed marker for reports. Inputs are fixed; no run reads
// clocks or random sources for assertions.
export const SEED = 20260906;

// Pinned tauri-driver release matching the Tauri 2 window shell. The xtask
// lane fails closed with this exact install command when the binary is
// absent.
export const TAURI_DRIVER_PIN = "=2.0.6";

// Fixed loopback port dictated by the embedded devUrl in the disowned
// `tauri.conf.json` (the debug window shell loads it instead of the bundle).
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

function hasCommand(name) {
  const probe = spawnSync(name, ["--version"], { encoding: "utf8" });
  return probe.status === 0 || existsSync(name);
}

function resolveOnPath(name) {
  for (const dir of String(process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

// Fail-closed driver discovery. Linux runs WebKitWebDriver; macOS and
// Windows keep their native-driver slots open for the later CI wave, which
// must also teach the xtask lane to build and drive there.
export function resolveTauriDriver() {
  const override = process.env.TAURI_DRIVER_BIN;
  if (override) {
    if (!existsSync(override)) {
      throw new Error(
        `window E2E: TAURI_DRIVER_BIN=${override} does not exist`,
      );
    }
    return override;
  }
  const found = resolveOnPath("tauri-driver");
  if (found) return found;
  throw new Error(
    `window E2E: tauri-driver not found on PATH (or TAURI_DRIVER_BIN unset); ` +
      `install the pinned release with \`cargo install tauri-driver --version "${TAURI_DRIVER_PIN}"\``,
  );
}

export function resolveNativeDriver() {
  if (process.platform !== "linux") {
    throw new Error(
      `window E2E: ${process.platform} has no driver wiring yet; ` +
        `the macOS/Windows CI wave must add native-driver discovery plus lane support`,
    );
  }
  const override = process.env.WEBKIT_DRIVER_BIN;
  if (override) {
    if (!existsSync(override)) {
      throw new Error(
        `window E2E: WEBKIT_DRIVER_BIN=${override} does not exist`,
      );
    }
    return override;
  }
  const found = resolveOnPath("WebKitWebDriver");
  if (found) return found;
  throw new Error(
    `window E2E: WebKitWebDriver not found on PATH (or WEBKIT_DRIVER_BIN unset); ` +
      `install the platform webview driver package for this Linux host`,
  );
}

export function ensureDisplay() {
  if (process.env.DISPLAY) return;
  throw new Error(
    `window E2E: no display (DISPLAY is unset); rerun under \`xvfb-run -a\` ` +
      `or start Xvfb and export DISPLAY first`,
  );
}

export function ensureBinary(bin, pkg) {
  if (existsSync(bin)) return;
  const build = spawnSync("cargo", ["build", "-p", pkg], { cwd: REPO_ROOT, encoding: "utf8" });
  if (build.status !== 0) {
    throw new Error(`cargo build -p ${pkg} failed:\n${build.stderr}`);
  }
  if (!existsSync(bin)) throw new Error(`binary missing after build: ${bin}`);
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

// Same binary and flags the `cargo xtask fixtures serve --port 0` path
// spawns: loopback only, kernel-allocated port, address readiness file.
export async function startFixtureServer(workDir) {
  ensureBinary(FIXTURE_SERVER_BIN, "dezoomify-fixture-server");
  const addrFile = path.join(workDir, "server.addr");
  const requestLog = path.join(workDir, "requests.log");
  const proc = spawn(FIXTURE_SERVER_BIN, [
    "--port", "0",
    "--write-address", addrFile,
    "--scenarios-dir", SCENARIOS_DIR,
    "--request-log", requestLog,
  ]);
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
  return { proc, base, requestLog };
}

// Serves the freshly built frontend over loopback on the embedded devUrl
// port. Fails closed when the port is held, naming the constraint.
export async function startFrontendServer() {
  if (!existsSync(path.join(FRONTEND_DIST, "index.html"))) {
    throw new Error(
      `window E2E: ${FRONTEND_DIST}/index.html is missing; ` +
        `run \`cargo xtask build desktop --unsigned-test\` first`,
    );
  }
  const server = http.createServer((req, res) => {
    let name = "/";
    try {
      name = decodeURIComponent(new URL(req.url ?? "/", "http://loopback").pathname);
    } catch {
      res.writeHead(400);
      res.end("bad path");
      return;
    }
    if (name === "/") name = "/index.html";
    const file = path.join(FRONTEND_DIST, name);
    if (!file.startsWith(FRONTEND_DIST) || !existsSync(file)) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  });
  await new Promise((resolve, reject) => {
    server.once("error", (err) => {
      reject(new Error(
        `window E2E: cannot serve the built frontend on 127.0.0.1:${FRONTEND_PORT} ` +
          `(the debug window shell loads that embedded devUrl address): ${err.message}`,
      ));
    });
    server.listen(FRONTEND_PORT, "127.0.0.1", resolve);
  });
  return server;
}

export async function startTauriDriver(tauriPort, nativePort, nativeDriverBin, env) {
  const driverBin = resolveTauriDriver();
  const proc = spawn(driverBin, [
    "--port", String(tauriPort),
    "--native-port", String(nativePort),
    "--native-driver", nativeDriverBin,
  ], { env, stdio: ["ignore", "ignore", "pipe"] });
  let logged = "";
  proc.stderr.on("data", (chunk) => {
    logged += chunk.toString();
  });
  // Readiness is the listening port, not log text (tauri-driver stays quiet
  // until the first session).
  for (let i = 0; i < 100; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${tauriPort}/status`);
      if (res.ok) return { proc, logged: () => logged };
    } catch {
      // Not up yet.
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  proc.kill();
  throw new Error(`tauri-driver never became ready on 127.0.0.1:${tauriPort}`);
}

// Fail-closed window-shell check: the lean shell and the window shell share
// one binary path, so a concurrent or stale `cargo build` can leave the lean
// shell on disk. The lean shell prints its version and exits, which wedges
// session creation forever; the marker below only exists in the window shell
// (`tauri_shell.rs` is compiled solely behind the `tauri` feature).
const WINDOW_SHELL_MARKER = "window E2E fixed destination engaged";

export function ensureWindowShell() {
  if (!existsSync(APP_BIN)) {
    throw new Error(
      `window E2E: ${APP_BIN} is missing; run \`cargo xtask test desktop --e2e-window\` (it builds the window shell first)`,
    );
  }
  const probe = spawnSync("grep", ["-a", "-F", "-q", WINDOW_SHELL_MARKER, APP_BIN]);
  if (probe.status !== 0) {
    throw new Error(
      `window E2E: ${APP_BIN} is not the window shell (lean shell on disk); ` +
        `rebuild with \`cargo xtask build desktop --unsigned-test\` and rerun`,
    );
  }
}

// One app launch under the running tauri-driver. `appArgs` carries an
// optional deep-link argv entry; `appEnv` carries the isolated HOME plus the
// explicit E2E flag pair. Resolves once the idle form or the deep-link
// confirm gate is visible.
export async function launchApp({ tauriPort, appArgs = [] }) {
  const options = { application: APP_BIN };
  if (appArgs.length > 0) options.args = appArgs;
  const sessionTimeoutMs = 90000;
  const driver = await Promise.race([
    new webdriver.Builder()
      .usingServer(`http://127.0.0.1:${tauriPort}/`)
      .withCapabilities({ "tauri:options": options })
      .forBrowser("wry")
      .build(),
    new Promise((_, reject) => setTimeout(
      () => reject(new Error(
        `window E2E: no WebDriver session after ${sessionTimeoutMs / 1000}s; ` +
          `the app binary may be stale (see ensureWindowShell) or the display is gone`,
      )),
      sessionTimeoutMs,
    )),
  ]);
  try {
    await driver.wait(async () => driver
      .executeScript("return !!document.querySelector('#dz-url-input, #dz-deep-link-confirm')")
      .catch(() => false), 60000);
  } catch (err) {
    await driver.quit().catch(() => {});
    throw new Error(`window E2E: app window never reached idle: ${String(err).slice(0, 200)}`);
  }
  return driver;
}

// Redacted origin (scheme://host[:port]) for reports. Never userinfo, path,
// query, or fragment.
export function redactedOriginOnly(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    return `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ""}`;
  } catch {
    return "";
  }
}

// Assert a report string carries no secrets, paths, or full URLs.
export function assertReportRedacted(reportText) {
  if (/token=|session=|cookie=|password=|secret/i.test(reportText)) {
    throw new Error("report carries a secret-bearing field");
  }
  if (reportText.includes("fixtures.test/")) {
    throw new Error("report carries a full fixture URL");
  }
}

export function gatewayInput(base, innerUrl) {
  return `${base}/fetch?url=${innerUrl}`;
}

export function deepLinkArgv(input) {
  return `dezoomify://open?v=2&src=${encodeURIComponent(input)}`;
}

// Full lifecycle for one flow: isolated profile, fixture server,
// tauri-driver plus app launch, then `body`. Everything is cleaned up
// (driver quit, child kills, temp profile removal) even on failure.
export async function runWindowFlow({ nativeDriverBin, appArgs = [], fixedName = "saved.png", preCreateDest = null, body }) {
  ensureDisplay();
  // Rechecked per flow: the window and lean shells share one binary path.
  ensureWindowShell();
  const work = mkdtempSync(path.join(tmpdir(), "dezoomify-window-e2e-"));
  const home = path.join(work, "home");
  mkdirSync(home, { recursive: true });
  const fixedDest = path.join(work, fixedName);
  if (preCreateDest !== null) writeFileSync(fixedDest, preCreateDest);
  let fixture = null;
  let driverProc = null;
  let driver = null;
  try {
    fixture = await startFixtureServer(work);
    const tauriPort = await freePort();
    const nativePort = await freePort();
    const appEnv = {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, ".config"),
      XDG_DATA_HOME: path.join(home, ".local/share"),
      XDG_CACHE_HOME: path.join(home, ".cache"),
      DEZOOMIFY_E2E_WINDOW: "1",
      DEZOOMIFY_E2E_FIXED_DESTINATION: fixedDest,
    };
    driverProc = await startTauriDriver(tauriPort, nativePort, nativeDriverBin, appEnv);
    // Deep-link flows build their argv from the allocated loopback base,
    // which only exists after the fixture server starts.
    const resolvedArgs = typeof appArgs === "function"
      ? appArgs({ base: fixture.base, fixedDest, work })
      : appArgs;
    driver = await launchApp({ tauriPort, appArgs: resolvedArgs });
    try {
      return await body({ driver, work, home, fixedDest, base: fixture.base, appEnv });
    } catch (err) {
      // The app inherits tauri-driver's stderr, so the tail below carries
      // the shell's own diagnostics (E2E hook engagement, deep-link
      // rejections) for a failing flow. Redacted by construction: paths
      // never enter shell logs, only the redacted origin. The fixture
      // request tail shows whether the pipeline ever connected.
      const tail = String(driverProc.logged()).trim().split("\n").slice(-15).join("\n");
      const note = tail ? `\napp log tail:\n${tail}` : "\napp log tail: (empty)";
      let fixtureNote = "";
      try {
        const logText = readFileSync(fixture.requestLog, "utf8").trim().split("\n");
        fixtureNote = `\nfixture requests (${logText.length}):\n${logText.slice(-10).join("\n")}`;
      } catch {
        fixtureNote = "\nfixture requests: (no log)";
      }
      throw new Error(`${err.message}${note}${fixtureNote}`);
    }
  } finally {
    if (driver) await driver.quit().catch(() => {});
    if (driverProc) driverProc.proc.kill();
    if (fixture) fixture.proc.kill();
    rmSync(work, { recursive: true, force: true });
  }
}

// Shared one-shot preflight for the spec file: binaries, display, drivers,
// and the loopback frontend server. Returns what every flow reuses.
export async function preflight() {
  ensureBinary(FIXTURE_SERVER_BIN, "dezoomify-fixture-server");
  ensureWindowShell();
  ensureDisplay();
  const nativeDriverBin = resolveNativeDriver();
  resolveTauriDriver();
  if (!hasCommand("node")) throw new Error("window E2E: node is required");
  const frontend = await startFrontendServer();
  return { frontend, nativeDriverBin };
}

// Delivers a deep link the way the OS does: a second app process with the
// link argv forwards it to the running window through the single-instance
// channel and exits. The link performs no effect until the frontend confirm
// gate accepts it. Times out fail-closed when the forwarder lingers.
export async function deliverDeepLink({ appEnv, link }) {
  const child = spawn(APP_BIN, [link], { env: appEnv, stdio: "ignore" });
  const done = new Promise((resolve) => child.once("exit", resolve));
  const timeout = new Promise((resolve) => setTimeout(() => resolve("timeout"), 30000));
  const result = await Promise.race([done, timeout]);
  if (result === "timeout") {
    child.kill();
    throw new Error("window E2E: deep-link forwarder did not exit in time");
  }
}

export { REPO_ROOT, SCENARIOS_DIR, FIXTURE_SERVER_BIN, APP_BIN };
