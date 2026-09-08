// Development-surface smoke test: start the real Vite entrypoint and inspect
// the module graph that the Tauri window loads from localhost:1420.
//
// This intentionally uses only Node's built-in test and fetch APIs. It is
// fast enough for the default desktop lane, does not need a webview, and
// catches startup/entrypoint/stylesheet regressions before a native window
// is involved.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../..");
const DEV_URL = "http://localhost:1420/";
const STARTUP_TIMEOUT_MS = 15000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url, timeoutMs = 1000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function startFrontend() {
  const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const child = spawn(command, ["--filter", "./apps/desktop", "dev", "--host", "localhost"], {
    cwd: REPO_ROOT,
    stdio: ["ignore", "ignore", "pipe"],
    detached: process.platform !== "win32",
    // Node cannot execute a .cmd directly on Windows (spawn EINVAL);
    // run it through the shell, which resolves pnpm.cmd from PATH.
    shell: process.platform === "win32",
  });
  let stderr = "";
  let spawnError = null;
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.on("error", (error) => {
    spawnError = error;
  });
  return { child, getStderr: () => stderr, getSpawnError: () => spawnError };
}

function stopFrontend(child) {
  if (child.exitCode !== null) return;
  if (process.platform === "win32") {
    // `pnpm.cmd` starts Vite under a command shell. Killing only the shell
    // leaves Vite alive with inherited pipes, so node:test never exits and
    // the desktop CI step stalls. Reap the owned tree, bounded, before the
    // direct-child fallback.
    try {
      const stopped = spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        timeout: 5000,
      });
      if (stopped.status === 0) return;
    } catch {
      // Fall through to the direct child kill.
    }
    child.kill();
    return;
  }
  try {
    // The detached process group includes pnpm and Vite, so the smoke test
    // cannot leave a server behind for a later test or developer command.
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill();
  }
}

async function waitForExit(child, timeoutMs = 2000) {
  if (child.exitCode !== null) return;
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    delay(timeoutMs),
  ]);
}

test("desktop dev server serves the real entrypoint and shared theme", { timeout: 30000 }, async () => {
  const { child, getStderr, getSpawnError } = startFrontend();
  let response;
  let lastError;
  try {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (getSpawnError()) {
        assert.fail(`could not start the desktop frontend: ${getSpawnError().message}`);
      }
      if (child.exitCode !== null) {
        assert.fail(`desktop frontend exited before becoming ready (${child.exitCode}):\n${getStderr()}`);
      }
      try {
        response = await fetchWithTimeout(DEV_URL);
        if (response.ok) break;
        lastError = new Error(`HTTP ${response.status}`);
      } catch (error) {
        lastError = error;
      }
      await delay(100);
    }

    assert.ok(response?.ok, `desktop frontend did not serve ${DEV_URL}: ${lastError ?? "timeout"}`);
    // Give a colliding Vite process time to report EADDRINUSE. An existing
    // listener must not make this test pass while our child has already died.
    await delay(250);
    assert.equal(child.exitCode, null, `desktop frontend exited after startup:\n${getStderr()}`);

    const html = await response.text();
    // Vite appends a cache-busting query when a hot-reloaded module changes.
    assert.match(html, /<script[^>]+src=["']\/src\/main\.ts(?:\?[^"']*)?["']/);
    const main = await fetchWithTimeout(new URL("/src/main.ts", DEV_URL));
    assert.equal(main.status, 200, "Vite serves the desktop entrypoint");
    assert.match(html, /src\/theme\.css/, "desktop document links the shared theme");
    assert.match(html, /src\/desktop\.css/, "desktop document links its native controls stylesheet");

    const theme = await fetchWithTimeout(new URL("/src/theme.css", DEV_URL));
    assert.equal(theme.status, 200, "Vite serves the imported shared theme");
    const themeSource = await theme.text();
    assert.match(themeSource, /--dz-page-bg\s*:/, "shared theme contains page colors");
    assert.match(themeSource, /\.dz-card\b/, "shared theme contains card styling");
  } finally {
    stopFrontend(child);
    await waitForExit(child);
  }
});
