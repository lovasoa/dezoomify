const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const root = path.resolve(__dirname, "..");
const fixtureOrigin = "http://127.0.0.1:9877";

const cases = [
  {
    name: "generic",
    url: `${fixtureOrigin}/fixtures/generic/tile.jpg?x={{X}}&y={{Y}}`,
  },
  {
    name: "iiif",
    url: `${fixtureOrigin}/fixtures/iiif-v2/info.json`,
  },
  {
    name: "pnav",
    url: `${fixtureOrigin}/entity/OBJECT/1`,
  },
];

function waitForServer(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("fixture server did not start")), 5000);
    child.stdout.on("data", (chunk) => {
      if (chunk.toString().includes("fixture server listening")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`fixture server exited with ${code}`));
    });
  });
}

function runCli(item) {
  return new Promise((resolve, reject) => {
    const output = path.join(os.tmpdir(), `dezoomify-cli-${item.name}-${process.pid}.jpg`);
    fs.rmSync(output, { force: true });

    const child = spawn(
      process.execPath,
      [path.join(root, "node-app", "dezoomify-node.js"), item.url, output],
      { cwd: root, stdio: ["ignore", "pipe", "pipe"] }
    );
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${item.name} CLI timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 15000);

    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`${item.name} CLI exited with ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
        return;
      }
      const size = fs.existsSync(output) ? fs.statSync(output).size : 0;
      fs.rmSync(output, { force: true });
      if (size <= 0) {
        reject(new Error(`${item.name} CLI did not write an image\nstdout:\n${stdout}\nstderr:\n${stderr}`));
        return;
      }
      resolve({ name: item.name, size });
    });
  });
}

(async () => {
  const server = spawn(process.execPath, [path.join(__dirname, "fixture-server.js")], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stderr.on("data", (chunk) => process.stderr.write(chunk));

  try {
    await waitForServer(server);
    const results = [];
    for (const item of cases) {
      results.push(await runCli(item));
    }
    console.table(results);
  } finally {
    server.kill();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
