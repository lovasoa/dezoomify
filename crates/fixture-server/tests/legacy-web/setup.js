// Spawns the deterministic fixture server (loopback, ephemeral port) serving
// the untouched legacy app from its source prefix. Writes addr.json for tests.
const { spawnSync, spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

async function globalSetup() {
  const root = path.resolve(__dirname, "..", "..", "..", "..");
  const bin = path.join(root, "target", "debug", "dezoomify-fixture-server");
  if (!fs.existsSync(bin)) {
    const build = spawnSync("cargo", ["build", "-p", "dezoomify-fixture-server"], {
      cwd: root,
      stdio: "inherit",
    });
    if (build.status !== 0) throw new Error("failed to build fixture server");
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dz-harness-"));
  const addrFile = path.join(tmp, "server.addr");
  const logFile = path.join(tmp, "requests.log");
  const child = spawn(
    bin,
    [
      "--port", "0",
      "--write-address", addrFile,
      "--scenarios-dir", path.join(root, "testdata", "scenarios"),
      "--static-dir", path.join(root, "migration-sources", "dezoomify-web"),
      "--request-log", logFile,
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  const addr = await new Promise((resolve, reject) => {
    const deadline = Date.now() + 30000;
    const poll = () => {
      try {
        const text = fs.readFileSync(addrFile, "utf8").trim();
        if (text) return resolve(text);
      } catch {}
      if (Date.now() > deadline) return reject(new Error("server address timeout"));
      setTimeout(poll, 50);
    };
    poll();
  });
  child.stderr.on("data", (d) => process.stderr.write(`[fixture-server] ${d}`));
  child.unref();
  fs.writeFileSync(
    path.join(__dirname, "addr.json"),
    JSON.stringify({ addr: `http://${addr}`, tmp, logFile, pid: child.pid })
  );
  globalThis.__dzServer = child;
  // Keep a pid file for teardown (separate process).
  fs.writeFileSync(path.join(tmp, "pid"), String(child.pid));
  fs.writeFileSync(path.join(__dirname, "tmpdir"), tmp);
}

module.exports = globalSetup;
