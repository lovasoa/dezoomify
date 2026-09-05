// Stops the fixture server and removes harness temp state.
const fs = require("node:fs");
const path = require("node:path");

async function globalTeardown() {
  try {
    const tmp = fs.readFileSync(path.join(__dirname, "tmpdir"), "utf8").trim();
    const pid = Number(fs.readFileSync(path.join(tmp, "pid"), "utf8").trim());
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
    fs.rmSync(path.join(__dirname, "addr.json"), { force: true });
    fs.rmSync(path.join(__dirname, "tmpdir"), { force: true });
  } catch {}
}

module.exports = globalTeardown;
