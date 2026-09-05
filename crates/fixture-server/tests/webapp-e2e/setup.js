// Builds the real webapp via scripts/build-site.mjs (wasm + glue + browser
// JS mirrors + help) and serves the assembled dist/ tree through the
// deterministic fixture server on loopback, exactly what the website-deploy
// workflow uploads to Cloudflare Pages. Writes addr.json.
const { spawnSync, spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

async function globalSetup() {
  const root = path.resolve(__dirname, "..", "..", "..", "..");
  // Full site build: mirrors, help, wasm adapter (release profile) and its
  // glue, then the dist/ assembly. wasm-bindgen must be installed and match
  // the wasm-bindgen version pinned by Cargo.lock.
  const site = spawnSync("node", ["scripts/build-site.mjs"], {
    cwd: root,
    stdio: "inherit",
  });
  if (site.status !== 0) throw new Error("failed to build the site (scripts/build-site.mjs)");

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
      // The web root is the assembled dist/ tree: /src, /packages, /wasm,
      // /help all resolve exactly as deployed.
      "--static-dir", path.join(root, "dist"),
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
