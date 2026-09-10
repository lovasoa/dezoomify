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
// - Automatic desktop saves derive a filename from the selected catalog title;
//   the harness configures the existing output-directory setting through the
//   rendered settings panel, keeping generated files inside the flow's
//   temporary directory.
// - The debug window shell loads its embedded devUrl (`http://localhost:1420`,
//   baked into the disowned `tauri.conf.json`), so the harness serves the
//   freshly built `apps/desktop/dist` there over loopback. Port 1420 is
//   dictated by that embedded value; anything else holding it fails this
//   gate closed with the holder named.
// - Reports carry origins, hashes, and stable codes only: never credentials,
//   full URLs, or absolute paths.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import webdriver from "selenium-webdriver";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../../..");
const SCENARIOS_DIR = path.join(REPO_ROOT, "testdata/scenarios");
const CARGO_TARGET_DIR = JSON.parse(spawnSync(
  "cargo", ["metadata", "--format-version", "1", "--no-deps"],
  { cwd: REPO_ROOT, encoding: "utf8" },
).stdout).target_directory;
// The lane copies the freshly built window shell and frontend into
// lane-private paths and points the harness at them, so a concurrent
// `cargo build` (lean shell) or frontend rebuild in the same checkout can
// never swap the binaries mid-run. Direct spec runs without the lane use
// the in-place build outputs.
const APP_BIN_CANDIDATE =
  process.env.DEZOOMIFY_WINDOW_E2E_APP_BIN || path.join(CARGO_TARGET_DIR, "debug/dezoomify-desktop");
// Windows builds `dezoomify-desktop.exe`; accept the extensionless lane
// value when the suffixed binary is the one on disk.
const APP_BIN =
  process.platform === "win32" && !existsSync(APP_BIN_CANDIDATE) && existsSync(`${APP_BIN_CANDIDATE}.exe`)
    ? `${APP_BIN_CANDIDATE}.exe`
    : APP_BIN_CANDIDATE;
const FRONTEND_DIST =
  process.env.DEZOOMIFY_WINDOW_E2E_DIST || path.join(REPO_ROOT, "apps/desktop/dist");
const FIXTURE_SERVER_CANDIDATE = path.join(CARGO_TARGET_DIR, "debug/dezoomify-fixture-server");
const FIXTURE_SERVER_BIN =
  process.platform === "win32" && !existsSync(FIXTURE_SERVER_CANDIDATE) && existsSync(`${FIXTURE_SERVER_CANDIDATE}.exe`)
    ? `${FIXTURE_SERVER_CANDIDATE}.exe`
    : FIXTURE_SERVER_CANDIDATE;

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
    // Windows: CreateProcess resolves `.exe` but a bare stem lookup does
    // not, so probe the suffixed binary too (mirrors the xtask lane).
    if (process.platform === "win32") {
      const exe = path.join(dir, `${name}.exe`);
      if (existsSync(exe)) return exe;
    }
  }
  return null;
}

// Fail-closed driver discovery. Linux runs WebKitWebDriver, macOS runs the
// platform safaridriver, Windows runs msedgedriver exact-matched to the
// runner Edge version; the xtask lane mirrors these slots.
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
  // Linux slot (behavior byte-identical to the prior wave).
  if (process.platform === "linux") {
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
  // macOS slot: the platform safaridriver (ships with macOS, enabled via
  // `sudo safaridriver --enable` in CI). SAFARI_DRIVER_BIN is canonical;
  // WEBKIT_DRIVER_BIN stays accepted for a shared CI env.
  if (process.platform === "darwin") {
    for (const key of ["SAFARI_DRIVER_BIN", "WEBKIT_DRIVER_BIN"]) {
      const override = process.env[key];
      if (override) {
        if (!existsSync(override)) {
          throw new Error(`window E2E: ${key}=${override} does not exist`);
        }
        return override;
      }
    }
    if (existsSync("/usr/bin/safaridriver")) return "/usr/bin/safaridriver";
    const found = resolveOnPath("safaridriver");
    if (found) return found;
    throw new Error(
      `window E2E: safaridriver not found (or SAFARI_DRIVER_BIN unset); ` +
        `enable with \`sudo safaridriver --enable\``,
    );
  }
  // Windows slot: msedgedriver exact-matched to the runner Edge version
  // (the workflow installs it fail-closed naming both versions).
  // EDGE_DRIVER_BIN is canonical; WEBKIT_DRIVER_BIN stays accepted.
  if (process.platform === "win32") {
    for (const key of ["EDGE_DRIVER_BIN", "WEBKIT_DRIVER_BIN"]) {
      const override = process.env[key];
      if (override) {
        if (!existsSync(override)) {
          throw new Error(`window E2E: ${key}=${override} does not exist`);
        }
        return override;
      }
    }
    const found = resolveOnPath("msedgedriver");
    if (found) return found;
    throw new Error(
      `window E2E: msedgedriver not found on PATH (or EDGE_DRIVER_BIN unset); ` +
        `install the exact runner-Edge match from https://msedgedriver.microsoft.com/<edge-version>/edgedriver_win64.zip`,
    );
  }
  throw new Error(
    `window E2E: ${process.platform} has no native-driver slot (linux, darwin, win32 only)`,
  );
}

export function ensureDisplay() {
  // Linux needs Xvfb; macOS and Windows runners provide a GUI session.
  if (process.platform !== "linux") return;
  if (process.env.DISPLAY) return;
  throw new Error(
    `window E2E: no display (DISPLAY is unset); rerun under \`xvfb-run -a\` ` +
      `or start Xvfb and export DISPLAY first`,
  );
}

export function ensureBinary(bin, pkg) {
  // Existence is not freshness. Let Cargo's dependency graph and incremental
  // cache decide whether rebuilding is necessary on every E2E invocation.
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

// SIGKILL a spawned process tree: the driver is spawned detached (its own
// group leader), so killing the group reaps the driver, the app, and every
// webview subprocess at once. A plain kill of the driver could orphan a
// half-booted app that keeps its devUrl connection (and our pipes) open;
// the group kill guarantees nothing of the flow survives into the next
// flow or past the spec process. Only call this on processes spawned
// detached (group leaders): on a non-leader the negative pid would not
// match its group. Windows has no POSIX groups, so the tree kill goes
// through `taskkill /T /F` with a direct-kill fallback.
export function killTree(detachedProc) {
  if (process.platform !== "win32") {
    try {
      process.kill(-detachedProc.pid, "SIGKILL");
      return;
    } catch {
      // Not a group leader (or already gone): fall through to a direct kill.
    }
  } else {
    // Windows has no POSIX groups: a bare kill would orphan the app and
    // WebView2 children (their Edge profile locks then break later flows
    // with `DevToolsActivePort` session failures), so kill the tree via
    // taskkill and fall back to a direct kill only when taskkill itself
    // cannot run.
    try {
      const done = spawnSync("taskkill", ["/pid", String(detachedProc.pid), "/T", "/F"], {
        stdio: "ignore",
      });
      if (done.status === 0) return;
    } catch {
      // Fall through to a direct kill.
    }
  }
  try {
    detachedProc.kill("SIGKILL");
  } catch {
    // Already gone.
  }
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
  trackLaneChild(proc);
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

// Tear the shared frontend server down without ever hanging the spec
// process: idle keep-alive sockets (a webview that leaked its flow) would
// otherwise make `close()` wait forever and node never exit. All
// connections are dropped, then `close()` resolves within a bound.
export async function closeFrontend(server) {
  if (typeof server.closeAllConnections === "function") server.closeAllConnections();
  await new Promise((resolve) => {
    const done = () => resolve();
    server.close(done);
    setTimeout(done, 5000).unref?.();
  });
}

// Lane-owned child tracking: every fixture server and tauri-driver this
// process spawns registers here and unregisters on exit. Pre-launch
// reaping only ever touches these PIDs (never a system scan), so foreign
// processes can never be signalled.
const laneChildren = new Set();

function trackLaneChild(proc) {
  if (proc && typeof proc.pid === "number") {
    laneChildren.add(proc);
    proc.once("exit", () => laneChildren.delete(proc));
  }
  return proc;
}

// Reap any lane-owned children still alive from a prior flow in this
// process (a failed launch that left the driver tree up). Only PIDs in
// `laneChildren` are signalled; anything foreign is untouched.
async function reapLaneOrphans() {
  const orphans = [...laneChildren];
  for (const proc of orphans) {
    if (proc.exitCode === null && proc.signalCode === null) {
      killTree(proc);
    }
  }
  for (const proc of orphans) {
    if (proc.exitCode === null && proc.signalCode === null) {
      await waitForProcExit(proc, 5000).catch(() => {});
    }
  }
}

function waitForProcExit(proc, timeoutMs) {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    timer.unref?.();
    proc.once("exit", done);
  });
}

// Isolated app environment for one flow: temp HOME plus XDG dirs (no
// shared caches). Mesa shader-cache writes are disabled so teardown never
// races a late cache flush (the observed Ubuntu `mesa_shader_cache` cleanup
// race). On Windows
// the POSIX HOME/XDG pair is irrelevant to Edge/WebView2, so the Windows
// profile roots move under the temp home too (fresh writable profile per
// flow: a shared or locked profile surfaces as `DevToolsActivePort file
// doesn't exist` / `Chrome instance exited` session failures), including
// the explicit WebView2 user-data override.
function laneAppEnv(home) {
  const env = {
    ...process.env,
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

// Deterministic temp-tree removal: a SIGKILLed webview can still hold a
// cache file for a tick after its exit event, so retry a bounded number
// of times instead of racing it. No assertions, cleanup only.
async function rmRfWithRetries(target) {
  for (let i = 0; i < 5; i += 1) {
    try {
      rmSync(target, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  try {
    rmSync(target, { recursive: true, force: true });
  } catch {
    // Best-effort: temp dirs are reaped by the OS eventually; never fail
    // a green run on a late cache flush.
  }
}

async function quitDriver(driver) {
  if (!driver) return;
  try {
    await driver.quit();
  } catch {
    // Already gone.
  }
}

async function stopFixture(fixture) {
  if (!fixture) return;
  try {
    fixture.proc.kill();
  } catch {
    // Already gone.
  }
  await waitForProcExit(fixture.proc, 5000).catch(() => {});
}

async function stopDriverProc(driverProc) {
  if (!driverProc) return;
  killTree(driverProc.proc);
  await waitForProcExit(driverProc.proc, 5000).catch(() => {});
}

export async function startTauriDriver(tauriPort, nativePort, nativeDriverBin, env) {
  const driverBin = resolveTauriDriver();
  // Detached on POSIX so the driver leads its own process group and the
  // flow teardown can SIGKILL the whole tree (driver + app + webview
  // subprocesses); see killTree.
  const proc = spawn(driverBin, [
    "--port", String(tauriPort),
    "--native-port", String(nativePort),
    "--native-driver", nativeDriverBin,
  ], { env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
  let logged = "";
  const capture = (chunk) => {
    logged += chunk.toString();
  };
  if (proc.stdout) proc.stdout.on("data", capture);
  proc.stderr.on("data", capture);
  // Readiness is the listening port, not log text (tauri-driver stays quiet
  // until the first session).
  trackLaneChild(proc);
  for (let i = 0; i < 100; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${tauriPort}/status`);
      if (res.ok) return { proc, logged: () => logged };
    } catch {
      // Not up yet.
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  const tail = String(logged).trim().split("\n").slice(-15).join("\n");
  killTree(proc);
  await waitForProcExit(proc, 5000).catch(() => {});
  throw new Error(
    `tauri-driver never became ready on 127.0.0.1:${tauriPort} ` +
      `(native driver ${nativeDriverBin})\ntauri-driver log tail:\n${tail || "(empty)"}`,
  );
}

export function ensureWindowShell() {
  if (!existsSync(APP_BIN)) {
    throw new Error(
      `window E2E: ${APP_BIN} is missing; run \`cargo xtask test desktop --e2e-window\` (it builds the window shell first)`,
    );
  }
}

// One app launch under the running tauri-driver. `appArgs` carries an
// optional deep-link argv entry; `appEnv` carries the isolated HOME and
// profile roots. Resolves once the idle form or the deep-link confirm gate is
// visible.
//
// Session establishment retries at the harness level only (never inside
// specs): a late-run `no WebDriver session` flake gets two more attempts
// with backoff before the flow fails with the driver log tail attached by
// the caller.
export async function launchApp({ tauriPort, appArgs = [] }) {
  const options = { application: APP_BIN };
  if (appArgs.length > 0) options.args = appArgs;
  const sessionTimeoutMs = 90000;
  const attempts = 3;
  const backoffsMs = [2000, 4000];
  let lastErr = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let timedOut = false;
    const buildPromise = new webdriver.Builder()
      .usingServer(`http://127.0.0.1:${tauriPort}/`)
      .withCapabilities({ "tauri:options": options })
      .forBrowser("wry")
      .build();
    // If the timeout wins, a late-resolving builder would otherwise leak
    // its session; reaps it only in that case (a winning builder is the
    // live session below and must not be quit).
    buildPromise.then((late) => {
      if (timedOut && late && typeof late.quit === "function") {
        late.quit().catch(() => {});
      }
    }, () => {});
    let driver = null;
    try {
      let timeoutId = null;
      const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          timedOut = true;
          reject(new Error(
            `window E2E: no WebDriver session after ${sessionTimeoutMs / 1000}s (attempt ${attempt}/${attempts}); ` +
              `the app binary may be stale (see ensureWindowShell) or the display is gone`,
          ));
        }, sessionTimeoutMs);
        timeoutId.unref?.();
      });
      driver = await Promise.race([buildPromise, timeoutPromise]);
      clearTimeout(timeoutId);
    } catch (err) {
      lastErr = err;
      // The late builder above reaps itself; back off and retry unless
      // this was the final attempt.
      if (attempt < attempts) {
        await new Promise((r) => setTimeout(r, backoffsMs[attempt - 1] ?? 2000));
        continue;
      }
      throw err;
    }
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
  throw lastErr ?? new Error("window E2E: no WebDriver session (no attempts ran)");
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

// Automatic desktop saves derive their filename from the fixture catalog
// title. Each flow owns an empty output directory, so the resulting PNG can
// be located without making the generated basename part of the contract.
export function outputFiles(outputDir, extension = ".png") {
  return readdirSync(outputDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(extension))
    .map((entry) => path.join(outputDir, entry.name));
}

// Configure the existing desktop output-directory setting through the
// rendered settings panel. This uses the same persisted settings payload as
// the user-facing folder picker and keeps the real window test portable
// across Linux, macOS, and Windows without adding a test-only application
// environment variable.
async function configureOutputDirectory(driver, outputDir) {
  await driver.wait(
    () => driver.executeScript((directory) => {
      const input = document.querySelector("#dz-settings-output-dir");
      const panel = document.querySelector("#dz-desktop-settings");
      if (!input || !panel) return false;
      input.value = directory;
      const visibleSelect = Array.from(panel.querySelectorAll("select"))
        .find((select) => !select.hidden);
      if (!visibleSelect) return false;
      // The visible quick-format control already invokes the panel's
      // validated persistence callback when it receives a change event.
      visibleSelect.dispatchEvent(new Event("change", { bubbles: true }));
      return input.value === directory;
    }, outputDir),
    60000,
    "desktop output-directory setting",
  );
}

// Full lifecycle for one flow: isolated profile, fixture server,
// tauri-driver plus app launch, then `body`. Everything is cleaned up
// (driver quit, child kills with exit wait, temp profile removal with
// retries) even on failure.
export async function runWindowFlow({ nativeDriverBin, appArgs = [], body }) {
  ensureDisplay();
  // Rechecked per flow: the window and lean shells share one binary path.
  ensureWindowShell();
  await reapLaneOrphans();
  const work = mkdtempSync(path.join(tmpdir(), "dezoomify-window-e2e-"));
  const home = path.join(work, "home");
  const outputDir = path.join(work, "outputs");
  mkdirSync(home, { recursive: true });
  mkdirSync(outputDir, { recursive: true });
  let fixture = null;
  let driverProc = null;
  let driver = null;
  try {
    fixture = await startFixtureServer(work);
    const tauriPort = await freePort();
    const nativePort = await freePort();
    const appEnv = laneAppEnv(home);
    driverProc = await startTauriDriver(tauriPort, nativePort, nativeDriverBin, appEnv);
    // Deep-link flows build their argv from the allocated loopback base,
    // which only exists after the fixture server starts.
    const resolvedArgs = typeof appArgs === "function"
      ? appArgs({ base: fixture.base, work })
      : appArgs;
    try {
      driver = await launchApp({ tauriPort, appArgs: resolvedArgs });
    } catch (err) {
      // A failed launch is the least diagnosed failure mode (no body ran),
      // so carry the driver's own stderr tail as evidence. The app inherits
      // tauri-driver's stderr, so the tail shows why the session never
      // formed (or that nothing ever spoke).
      const tail = String(driverProc.logged()).trim().split("\n").slice(-15).join("\n");
      throw new Error(`${err.message}\napp log tail:\n${tail || "(empty)"}`);
    }
    try {
      await configureOutputDirectory(driver, outputDir);
      return await body({ driver, work, home, outputDir, base: fixture.base, appEnv });
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
    // Deterministic teardown: quit the session, SIGKILL the whole driver
    // tree and wait for its exit, stop the fixture server and wait, then
    // remove the temp profile with retries. Waiting before `rm` fixes the
    // Mesa-shader-cache cleanup race (a late cache flush after SIGKILL);
    // the disabled shader cache in `laneAppEnv` removes the writer.
    await quitDriver(driver);
    await stopDriverProc(driverProc);
    await stopFixture(fixture);
    await rmRfWithRetries(work);
  }
}

// Shared-window session for back-to-back completed saves in one app
// launch: one isolated profile, one fixture server, one tauri-driver plus
// one app launch, then `body` runs N saves sequentially. Between saves the
// caller returns to idle through the product "Dezoomify another image"
// reset. Everything is cleaned up even on failure. Use for a data-driven
// formats matrix where every case has the same automatic-save shape;
// one-off flows keep the isolated runWindowFlow above.
export async function runSharedWindowSession({ nativeDriverBin, body }) {
  ensureDisplay();
  ensureWindowShell();
  await reapLaneOrphans();
  const work = mkdtempSync(path.join(tmpdir(), "dezoomify-window-e2e-shared-"));
  const home = path.join(work, "home");
  const outputDir = path.join(work, "outputs");
  mkdirSync(home, { recursive: true });
  mkdirSync(outputDir, { recursive: true });
  let fixture = null;
  let driverProc = null;
  let driver = null;
  try {
    fixture = await startFixtureServer(work);
    const tauriPort = await freePort();
    const nativePort = await freePort();
    const appEnv = laneAppEnv(home);
    driverProc = await startTauriDriver(tauriPort, nativePort, nativeDriverBin, appEnv);
    try {
      driver = await launchApp({ tauriPort });
    } catch (err) {
      const tail = String(driverProc.logged()).trim().split("\n").slice(-15).join("\n");
      throw new Error(`${err.message}\napp log tail:\n${tail || "(empty)"}`);
    }
    try {
      await configureOutputDirectory(driver, outputDir);
      return await body({ driver, work, home, outputDir, base: fixture.base, appEnv });
    } catch (err) {
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
    await quitDriver(driver);
    await stopDriverProc(driverProc);
    await stopFixture(fixture);
    await rmRfWithRetries(work);
  }
}

// Shared one-shot preflight for the spec file: binaries, display, drivers,
// and the loopback frontend server. Returns what every flow reuses.
export async function preflight() {
  ensureBinary(FIXTURE_SERVER_BIN, "dezoomify-fixture-server");
  ensureWindowShell();
  ensureDisplay();
  // Mesa shader-cache writes disabled process-wide so spec-owned flows
  // (which spread `process.env` into their own `appEnv`) inherit the same
  // deterministic teardown without spec edits.
  process.env.MESA_SHADER_CACHE_DISABLE = "1";
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
