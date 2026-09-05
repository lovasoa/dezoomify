// Builds the real webapp (wasm + browser glue) and serves the repo root
// through the deterministic fixture server on loopback. Writes addr.json.
const { spawnSync, spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

async function globalSetup() {
  const root = path.resolve(__dirname, "..", "..", "..", "..");
  // Rebuild the wasm adapter and its browser glue (wasm-bindgen must be
  // installed and match the crate's wasm-bindgen version).
  const bindgen = spawnSync("wasm-bindgen", ["--version"], { encoding: "utf8" });
  if (bindgen.status !== 0) {
    throw new Error(
      "wasm-bindgen is required for the webapp E2E; install wasm-bindgen-cli " +
        "matching crates/dezoomify-wasm's wasm-bindgen version",
    );
  }
  const build = spawnSync(
    "cargo",
    ["build", "-p", "dezoomify-wasm", "--target", "wasm32-unknown-unknown"],
    { cwd: root, stdio: "inherit" },
  );
  if (build.status !== 0) throw new Error("failed to build dezoomify-wasm");
  const outDir = path.join(root, "wasm");
  fs.mkdirSync(outDir, { recursive: true });
  const glue = spawnSync(
    "wasm-bindgen",
    [
      "--target", "web",
      "--out-dir", outDir,
      "--out-name", "dezoomify-wasm",
      path.join(root, "target", "wasm32-unknown-unknown", "debug", "dezoomify_wasm.wasm"),
    ],
    { cwd: root, stdio: "inherit" },
  );
  if (glue.status !== 0) throw new Error("failed to generate wasm glue");

  const bin = path.join(root, "target", "debug", "dezoomify-fixture-server");
  if (!fs.existsSync(bin)) {
    const serverBuild = spawnSync("cargo", ["build", "-p", "dezoomify-fixture-server"], {
      cwd: root,
      stdio: "inherit",
    });
    if (serverBuild.status !== 0) throw new Error("failed to build fixture server");
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dz-webapp-e2e-"));
  const addrFile = path.join(tmp, "server.addr");
  const logFile = path.join(tmp, "requests.log");
  const child = spawn(
    bin,
    [
      "--port", "0",
      "--write-address", addrFile,
      "--scenarios-dir", path.join(root, "testdata", "scenarios"),
      // The web root is the repository root: /src, /packages, /wasm all resolve.
      "--static-dir", root,
      "--request-log", logFile,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
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
    JSON.stringify({ addr: `http://${addr}`, tmp, logFile, pid: child.pid }),
  );
  fs.writeFileSync(path.join(tmp, "pid"), String(child.pid));
  fs.writeFileSync(path.join(__dirname, "tmpdir"), tmp);
}

module.exports = globalSetup;
