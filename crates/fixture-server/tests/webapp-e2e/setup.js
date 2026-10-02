// Builds the deployed site and runs the deterministic fixture server on an
// ephemeral loopback port. Playwright owns readiness and process shutdown.
const { spawnSync, spawn } = require("node:child_process");
const path = require("node:path");

const root = path.resolve(__dirname, "..", "..", "..", "..");

// Full site build: help, WASM binding (release profile), glue, and dist/.
const site = spawnSync("node", ["scripts/build-site.mjs"], {
  cwd: root,
  encoding: "utf8",
  env: { ...process.env, VITE_CONFIG_NATIVE_IGNORE_WARNING: "true" },
});
if (site.status !== 0) {
  process.stderr.write(site.stdout ?? "");
  process.stderr.write(site.stderr ?? "");
  throw new Error("failed to build the site (scripts/build-site.mjs)");
}

const child = spawn(
  process.execPath,
  [
    path.join(root, "test/fixture-server.mjs"),
    "--parent-stdio",
    "--port", "0",
    "--scenarios-dir", path.join(root, "testdata", "scenarios"),
    "--static-dir", path.join(root, "dist"),
  ],
  { stdio: ["pipe", "inherit", "pipe"] },
);

let shuttingDown = false;
let serverOutput = "";
let readinessPrinted = false;
child.stderr.on("data", (data) => {
  serverOutput += data.toString();
  if (!readinessPrinted) {
    const ready = serverOutput.match(/fixture server listening at http:\/\/127\.0\.0\.1:\d+/);
    if (ready) {
      readinessPrinted = true;
      process.stderr.write(`${ready[0]}\n`);
    }
  }
});
process.once("SIGTERM", () => {
  shuttingDown = true;
  child.kill("SIGTERM");
});

child.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  if (!shuttingDown) {
    process.stderr.write(serverOutput);
    process.exitCode = code ?? (signal ? 1 : 0);
  }
});
