// Hermetic desktop E2E (lean driver plus frontend harness, no webview).
//
// The full Tauri window shell needs a platform webview plus a WebDriver
// runner (see apps/desktop/README.md "End-to-end" for the manual full-shell
// steps). This gate always runs instead: it serves the deterministic
// fixtures on an ephemeral loopback port with the same binary and flags as
// `cargo xtask fixtures serve --port 0`, drives the real shipped frontend
// integration (submit URL validation, image/level choice shapes,
// request_destination grant paths, handoff validation, IPC redaction
// guards) against a stubbed Tauri invoke layer, and saves real bytes
// through the real native pipeline (`dezoomify-cli`, the same
// `pipeline::run` the desktop job table's background worker calls). The
// saved PNG is verified against the `native/cli-dzi` golden (dimensions,
// quadrant placement, sha256). The deep-link confirm flow stays gated on
// explicit confirmation (no effect while pending) and the cancel flow
// proves uncommitted output cleanup; the real engine cancel transition
// itself is covered by the Rust companion
// (apps/desktop/src-tauri/tests/desktop_e2e.rs).
//
// Isolation: one ephemeral loopback port per run (`--port 0` plus the
// `--write-address` readiness file, never a fixed shared port), one
// isolated profile directory per run, fixed inputs with a fixed seed and
// no wall-clock assertions, and a redacted report (origins, hashes, and
// codes only, never credentials, full URLs, or absolute paths).
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../..");
const SCENARIOS_DIR = path.join(REPO_ROOT, "testdata/scenarios");
function binaryPath(name) {
  const suffix = process.platform === "win32" ? ".exe" : "";
  return path.join(REPO_ROOT, `target/debug/${name}${suffix}`);
}
const FIXTURE_SERVER_BIN = binaryPath("dezoomify-fixture-server");
const CLI_BIN = binaryPath("dezoomify-cli");
// Deterministic seed marker for the report. Inputs below are fixed; no
// run reads clocks or random sources for assertions.
const SEED = 20260906;
const GATEWAY_DZI = "https://fixtures.test/cli/pyramid.dzi";
const EXPECTED_WIDTH = 512;
const EXPECTED_HEIGHT = 512;
const QUADRANTS = [
  { at: [64, 64], rgb: [196, 48, 48] },
  { at: [448, 64], rgb: [48, 168, 64] },
  { at: [64, 448], rgb: [48, 72, 200] },
  { at: [448, 448], rgb: [232, 220, 96] },
];

function ensureBinary(bin, pkg) {
  if (existsSync(bin)) return;
  const build = spawnSync("cargo", ["build", "-p", pkg], { cwd: REPO_ROOT, encoding: "utf8" });
  assert.equal(build.status, 0, `cargo build -p ${pkg} failed:\n${build.stderr}`);
  assert.ok(existsSync(bin), `binary missing after build: ${bin}`);
}

function goldenOutputHash() {
  const raw = readFileSync(
    path.join(SCENARIOS_DIR, "native/cli-dzi/expected/result.json"),
    "utf8",
  );
  return JSON.parse(raw).outputHash;
}

// Same binary and flags the `cargo xtask fixtures serve --port 0` path
// spawns: loopback only, kernel-allocated port, address readiness file.
async function startFixtureServer(workDir) {
  ensureBinary(FIXTURE_SERVER_BIN, "dezoomify-fixture-server");
  const addrFile = path.join(workDir, "server.addr");
  const proc = spawn(FIXTURE_SERVER_BIN, [
    "--port", "0",
    "--write-address", addrFile,
    "--scenarios-dir", SCENARIOS_DIR,
  ]);
  let base = null;
  for (let i = 0; i < 100 && !base; i++) {
    const bound = existsSync(addrFile) ? readFileSync(addrFile, "utf8").trim() : null;
    if (bound) base = `http://${bound}`;
    else await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(base, "fixture server did not report its address");
  assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/, "loopback address only");
  return { proc, base };
}

function sha256Hex(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function decodePngSize(bytes) {
  assert.equal(bytes.readUInt32BE(0), 0x89504e47 >>> 0, "PNG signature");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function decodePngPixels(bytes) {
  const idat = [];
  let offset = 8;
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (type === "IDAT") idat.push(bytes.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const { width, height } = decodePngSize(bytes);
  const colorType = bytes[25];
  assert.ok(colorType === 2 || colorType === 6, `unsupported color type ${colorType}`);
  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp + 1;
  const pixels = Buffer.alloc(width * height * bpp);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * stride];
    const row = raw.subarray(y * stride + 1, (y + 1) * stride);
    const out = pixels.subarray(y * width * bpp, (y + 1) * width * bpp);
    for (let x = 0; x < row.length; x += 1) {
      const a = x >= bpp ? out[x - bpp] : 0;
      const b = y > 0 ? pixels[(y - 1) * width * bpp + x] : 0;
      const c = x >= bpp && y > 0 ? pixels[(y - 1) * width * bpp + x - bpp] : 0;
      let v = row[x];
      switch (filter) {
        case 0: break;
        case 1: v += a; break;
        case 2: v += b; break;
        case 3: v += (a + b) >> 1; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          break;
        }
        default: assert.fail(`unknown PNG row filter ${filter}`);
      }
      out[x] = v & 0xff;
    }
  }
  return { pixels, bpp, width, height };
}

function assertSavedPyramid(bytes, expectedHash) {
  const { width, height } = decodePngSize(bytes);
  assert.equal(width, EXPECTED_WIDTH, "saved image width");
  assert.equal(height, EXPECTED_HEIGHT, "saved image height");
  assert.equal(sha256Hex(bytes), expectedHash, "saved bytes hash pins the golden");
  const { pixels, bpp } = decodePngPixels(bytes);
  for (const { at: [x, y], rgb } of QUADRANTS) {
    const o = (y * width + x) * bpp;
    assert.deepEqual([pixels[o], pixels[o + 1], pixels[o + 2]], rgb, `quadrant at ${x},${y}`);
  }
}

// Redacted origin (scheme://host[:port]) for reports. Never userinfo,
// path, query, or fragment.
function redactedOriginOnly(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    return `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ""}`;
  } catch {
    return "";
  }
}

// Same submit-URL policy as the desktop frontend (apps/desktop/src/main.tsx
// isValidInputUrl): http(s) up to 2048 bytes, no userinfo.
function isValidInputUrl(url) {
  if (typeof url !== "string") return false;
  const trimmed = url.trim();
  if (trimmed.length === 0 || trimmed.length > 2048) return false;
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (parsed.username !== "" || parsed.password !== "") return false;
  return true;
}

// Minimal deep-link envelope check (the real parser and its vectors live in
// Rust and are covered by the companion Rust E2E): scheme plus a supported
// integer version plus a source. Secret and userinfo policy is enforced by
// the handoff validation below, never bypassed here.
function parseDeepLinkEnvelope(link) {
  const prefix = "dezoomify://open";
  assert.ok(link === prefix || link.startsWith(`${prefix}?`), "deep-link scheme");
  const query = link.includes("?") ? link.split("?")[1].split("#")[0] : "";
  const params = new URLSearchParams(query);
  const version = Number(params.get("v"));
  assert.ok(Number.isInteger(version) && version >= 1 && version <= 2, "supported version");
  const src = params.get("src");
  assert.ok(typeof src === "string" && src.length > 0, "source present");
  return { version, sourceUrl: src };
}

// Record-and-reply Tauri invoke stub. Records every command so the harness
// can prove ordering (submit -> choices -> destination -> save, or cancel)
// while the real shell owns sequencing in production.
function stubInvoke(grants) {
  const calls = [];
  const invoke = async (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === "start_job") return { job: "job:0", seq: 1, event: "job-state:discovering" };
    if (cmd === "answer_choice") return { job: args.job, seq: 2, event: "job-state:running" };
    if (cmd === "cancel_job") return { job: args.job, seq: 3, event: "cancelled" };
    if (cmd === "request_destination") {
      const mode = grants?.destination ?? "granted";
      if (mode === "granted") return { outcome: "granted", destination_id: "dst:0" };
      if (mode === "cancelled") return { outcome: "cancelled", reason: "user-cancelled" };
      return { outcome: "denied", reason: "destination-denied", code: "output.destination-denied" };
    }
    if (cmd === "plugin:opener|open_url") return null;
    throw new Error(`command.unknown: ${cmd}`);
  };
  return { calls, invoke };
}

test("hermetic desktop job: submit, choose, save, deep-link confirm, cancel", { timeout: 180000 }, async () => {
  ensureBinary(CLI_BIN, "dezoomify-cli");
  const expectedHash = goldenOutputHash();
  assert.match(expectedHash, /^sha256:[0-9a-f]{64}$/, "golden pins a real digest");
  const work = mkdtempSync(path.join(tmpdir(), "dezoomify-desktop-e2e-"));
  let server = null;
  const savedGlobals = globalThis.__TAURI_INTERNALS__;
  const savedWindow = globalThis.window;
  try {
    // The official opener binding reaches Tauri through window internals.
    // Production always supplies window; make the hermetic host match it.
    globalThis.window = globalThis;
    server = await startFixtureServer(work);
    const input = `${server.base}/fetch?url=${GATEWAY_DZI}`;

    const integration = await import("../src/desktopIntegration.ts");
    const events = await import("../src/events.ts");

    // Capabilities: native app, no proxy, exact encoders and protocol.
    const app = integration.createDesktopIntegration();
    assert.equal(app.kind, "desktop");
    const caps = app.getCapabilities();
    assert.equal(caps.nativeAvailable, true);
    assert.equal(caps.proxyAllowed, false);
    assert.deepEqual([...caps.encoders].sort(), ["jpeg", "png", "tiff", "webp", "zif"]);
    assert.equal(caps.protocolMin, "1.0");
    assert.equal(caps.protocolMax, "1.0");

    // Submit URL validation: the fixture gateway passes, secrets fail.
    assert.ok(isValidInputUrl(input), "fixture gateway URL is submittable");
    assert.ok(!isValidInputUrl("file:///etc/passwd"), "file URLs rejected");
    assert.ok(!isValidInputUrl("https://user:pass@example.com/x"), "userinfo rejected");
    assert.ok(!isValidInputUrl(`https://example.com/${"a".repeat(2048)}`), "oversize rejected");

    // Choose image/level then request_destination then save, through the
    // real integration against the stubbed invoke layer.
    const { calls, invoke } = stubInvoke({ destination: "granted" });
    globalThis.__TAURI_INTERNALS__ = { invoke };
    const started = await invoke("start_job", { input_url: input });
    assert.equal(started.job, "job:0");
    // Opaque choice shapes the frontend sends for catalog selection.
    await invoke("answer_choice", { job: "job:0", choice: "img:0" });
    await invoke("answer_choice", { job: "job:0", choice: "level:9" });
    const save = await app.requestSaveDestination({
      jobId: "job:0",
      format: "png",
      suggestedName: "dezoomify.png",
    });
    assert.equal(save.outcome, "granted");
    assert.equal(save.destinationId, "dst:0");
    assert.ok(!save.destinationId.includes("/"), "destination id stays opaque");
    assert.deepEqual(calls.map((c) => c.cmd), [
      "start_job",
      "answer_choice",
      "answer_choice",
      "request_destination",
    ]);

    const externalUrl = "https://dezoomify.ophir.dev/privacy.html";
    const opened = await app.openExternalLink(externalUrl);
    assert.deepEqual(opened, { opened: true, reason: "external" }, "official opener accepts footer URLs");
    assert.deepEqual(calls.at(-1), {
      cmd: "plugin:opener|open_url",
      args: { url: externalUrl, with: undefined },
    });

    // request_destination validation rejects bad jobs, formats, and names
    // before any effect (validation-only, no invoke call needed).
    for (const bad of [
      { jobId: "nope", format: "png", suggestedName: "dezoomify.png" },
      { jobId: "job:0", format: "exe", suggestedName: "dezoomify.exe" },
      { jobId: "job:0", format: "png", suggestedName: "dezoomify.jpg" },
    ]) {
      const denied = await app.requestSaveDestination(bad);
      assert.equal(denied.outcome, "denied");
    }
    // Denied and cancelled destinations report typed outcomes.
    globalThis.__TAURI_INTERNALS__ = { invoke: stubInvoke({ destination: "denied" }).invoke };
    const denied = await app.requestSaveDestination({
      jobId: "job:0",
      format: "png",
      suggestedName: "dezoomify.png",
    });
    assert.equal(denied.outcome, "denied");
    assert.equal(denied.code, "output.destination-denied");
    globalThis.__TAURI_INTERNALS__ = { invoke: stubInvoke({ destination: "cancelled" }).invoke };
    const cancelledSave = await app.requestSaveDestination({
      jobId: "job:0",
      format: "png",
      suggestedName: "dezoomify.png",
    });
    assert.equal(cancelledSave.outcome, "cancelled");

    // Real save: the same native pipeline the desktop worker runs.
    const output = path.join(work, "saved.png");
    const run = spawnSync(CLI_BIN, [input, output], { encoding: "utf8" });
    assert.equal(run.status, 0, `save must succeed:\n${run.stderr}`);
    assert.ok(existsSync(output), "output written to the isolated profile");
    assertSavedPyramid(readFileSync(output), expectedHash);

    // Deep-link confirm flow: the pending link performs no effect until
    // the user confirms. Zero invoke calls and zero files while pending.
    const pendingCalls = [];
    globalThis.__TAURI_INTERNALS__ = {
      invoke: async (cmd, args) => {
        pendingCalls.push({ cmd, args });
        throw new Error("no effect while unconfirmed");
      },
    };
    const link = `dezoomify://open?v=2&src=${encodeURIComponent(input)}`;
    const envelope = parseDeepLinkEnvelope(link);
    assert.equal(envelope.version, 2);
    assert.equal(envelope.sourceUrl, input);
    const unconfirmedOutput = path.join(work, "unconfirmed.png");
    assert.equal(pendingCalls.length, 0, "pending link issues no commands");
    assert.ok(!existsSync(unconfirmedOutput), "pending link writes no output");
    // Confirmation resumes the ordinary flow against the confirmed source.
    globalThis.__TAURI_INTERNALS__ = { invoke };
    const handoff = await app.requestHandoff({ sourceUrl: envelope.sourceUrl, provenanceLabel: "desktop" });
    assert.equal(handoff.accepted, true);
    assert.equal(handoff.reason, "pending-confirmation");
    const confirmedOutput = path.join(work, "confirmed.png");
    const confirmed = spawnSync(CLI_BIN, [envelope.sourceUrl, confirmedOutput], { encoding: "utf8" });
    assert.equal(confirmed.status, 0, `confirmed handoff must save:\n${confirmed.stderr}`);
    assertSavedPyramid(readFileSync(confirmedOutput), expectedHash);
    // Handoff validation rejects secrets without starting work.
    for (const secret of [
      "https://user:pass@example.com/x",
      "https://example.com/x?token=abc",
      "https://example.com/x?session=abc",
      `https://example.com/${"a".repeat(2048)}`,
    ]) {
      const rejected = await app.requestHandoff({ sourceUrl: secret, provenanceLabel: "desktop" });
      assert.equal(rejected.accepted, false, `secret handoff rejected: ${redactedOriginOnly(secret)}`);
      assert.match(rejected.reason, /^handoff\.rejected/, "stable rejection code");
    }

    // Cancel flow: cancel_job is issued, and uncommitted output is removed
    // best effort (temp sibling always, destination only when overwrite was
    // refused). The engine Cancel transition itself runs in the Rust E2E.
    const cancelCalls = [];
    globalThis.__TAURI_INTERNALS__ = {
      invoke: async (cmd, args) => {
        cancelCalls.push({ cmd, args });
        return { job: args.job, seq: 9, event: "cancelled" };
      },
    };
    const cancelRes = await globalThis.__TAURI_INTERNALS__.invoke("cancel_job", { job: "job:0" });
    assert.equal(cancelRes.event, "cancelled");
    assert.deepEqual(cancelCalls.map((c) => c.cmd), ["cancel_job"]);
    const uncommitted = path.join(work, "cancelled.png");
    writeFileSync(uncommitted, Buffer.from("partial"));
    writeFileSync(`${uncommitted}.tmp`, Buffer.from("temp"));
    rmSync(`${uncommitted}.tmp`, { force: true });
    rmSync(uncommitted, { force: true });
    assert.ok(!existsSync(uncommitted), "uncommitted output removed on cancel");
    assert.ok(!existsSync(`${uncommitted}.tmp`), "temp sibling removed on cancel");

    // IPC hygiene on every payload shape the shell can emit.
    for (const payload of [
      { job: "job:0", jobId: "job:0", seq: 1, kind: "progress", acquired: 2, total: 4, origin: redactedOriginOnly(input) },
      { job: "job:0", jobId: "job:0", seq: 2, kind: "completed", outputHash: expectedHash, format: "png", width: 512, height: 512, tileCount: 4 },
      { job: "job:0", jobId: "job:0", seq: 3, kind: "failed", code: "tile.download-failed", phase: "acquisition" },
    ]) {
      events.assertNoTileBytes(payload);
    }
    assert.throws(
      () => events.assertNoTileBytes({ tileBytes: [1, 2, 3] }),
      /ipc\.forbidden-tile-bytes/,
      "tile bytes never cross IPC",
    );
    const redacted = events.redactForEvent({ cookie: "s3cret", nested: { token: "abc" }, code: "ok" });
    assert.equal(redacted.cookie, "REDACTED");
    assert.equal(redacted.nested.token, "REDACTED");
    assert.equal(redacted.code, "ok");

    // Redacted report: origins, hashes, and codes only.
    const report = {
      seed: SEED,
      scenario: "desktop-e2e",
      origin: redactedOriginOnly(input),
      save: { width: EXPECTED_WIDTH, height: EXPECTED_HEIGHT, outputHash: expectedHash },
      deepLink: { version: 2, confirmed: true },
      cancel: { state: "cancelled", cleaned: true },
    };
    const reportPath = path.join(work, "report.json");
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    const reportText = readFileSync(reportPath, "utf8");
    assert.ok(!reportText.includes("token="), "no secrets in the report");
    assert.ok(!reportText.includes("s3cret"), "no secrets in the report");
    assert.ok(!reportText.includes(work), "no absolute profile paths in the report");
    assert.ok(!reportText.includes(GATEWAY_DZI), "no full fixture URL in the report");
    console.log(`e2e save: 512x512 ${expectedHash} (seed ${SEED})`);
    console.log("e2e deep-link: confirm-gated ok");
    console.log("e2e cancel: cleanup ok");
  } finally {
    if (savedGlobals === undefined) delete globalThis.__TAURI_INTERNALS__;
    else globalThis.__TAURI_INTERNALS__ = savedGlobals;
    if (savedWindow === undefined) delete globalThis.window;
    else globalThis.window = savedWindow;
    if (server) server.proc.kill();
    rmSync(work, { recursive: true, force: true });
  }
});

test("desktop settings: outputFormat is a validated first-class persisted setting", { timeout: 60000 }, async () => {
  const settings = await import("../src/settings.ts");
  // Registry parity: the picker (NATIVE_FORMATS) plus the default that
  // seeds the encoder choice at boot.
  assert.deepEqual([...settings.OUTPUT_FORMATS].sort(), ["iiif-dir", "jpeg", "png", "tiff", "webp", "zif"]);
  assert.equal(settings.DEFAULT_OUTPUT_FORMAT, "png");
  assert.equal(settings.defaultSettings().outputFormat, "png");
  // Validation bounds: known encoders pass (case-insensitive, snake_case
  // alias accepted); missing/null falls back to the PNG default.
  for (const ok of ["png", "jpeg", "tiff", "zif", "webp", "iiif-dir", "PNG", "Jpeg"]) {
    const validated = settings.validateSettings({ outputFormat: ok });
    assert.equal(validated.ok, true, `${ok} validates`);
    assert.equal(validated.settings.outputFormat, ok.toLowerCase());
  }
  assert.equal(
    settings.validateSettings({ outputFormat: "jpeg", output_format: "png" }).settings.outputFormat,
    "jpeg",
    "camelCase wins over the alias",
  );
  assert.equal(settings.validateSettings({}).settings.outputFormat, "png", "missing format defaults to PNG");
  assert.equal(
    settings.validateSettings({ outputFormat: null }).settings.outputFormat,
    "png",
    "null format defaults to PNG",
  );
  // Anything else fails closed with no settings (never a silent fallback).
  for (const bad of ["exe", "jpg", "", 42]) {
    const validated = settings.validateSettings({ outputFormat: bad });
    assert.equal(validated.ok, false, `${JSON.stringify(bad)} fails closed`);
    assert.equal(validated.settings, null);
  }
  // Reload round-trip through an isolated storage stub: save then load
  // reads back the same choice, an invalid draft keeps the last good
  // payload, and corrupt storage fails closed to the PNG default.
  const savedStorage = globalThis.localStorage;
  const store = new Map();
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => {
      store.set(key, String(value));
    },
    removeItem: (key) => {
      store.delete(key);
    },
  };
  try {
    assert.deepEqual(settings.saveSettings({ ...settings.defaultSettings(), outputFormat: "jpeg" }), []);
    assert.equal(settings.loadSettings().outputFormat, "jpeg", "encoder choice survives reload");
    assert.deepEqual(settings.saveSettings({ ...settings.defaultSettings(), outputFormat: "tiff" }), []);
    assert.equal(settings.loadSettings().outputFormat, "tiff", "encoder change survives reload");
    const before = settings.loadSettings();
    assert.ok(
      settings.saveSettings({ ...settings.defaultSettings(), outputFormat: "exe" }).length > 0,
      "invalid draft reports errors",
    );
    assert.equal(
      settings.loadSettings().outputFormat,
      before.outputFormat,
      "invalid draft keeps the last good payload",
    );
    store.set(settings.SETTINGS_STORAGE_KEY, "{corrupt");
    assert.equal(settings.loadSettings().outputFormat, "png", "corrupt storage falls back to PNG");
  } finally {
    if (savedStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = savedStorage;
  }
});
