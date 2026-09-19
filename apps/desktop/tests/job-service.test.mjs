import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createDesktopJobService,
  foldSnapshotPayload,
  projectDesktopEvent,
} from "../src/jobService.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function nativeRequest(url = "https://museum.example.org/iiif/1/manifest.json") {
  return {
    inputs: [{ url }],
    engine: {},
    exec: { kind: "native", destination: { kind: "file", suggestedName: "dezoomify-800x600.png", format: "png" } },
  };
}

// Explicit IPC double: records invokes, replays channel payloads.
function fakeIpc() {
  const invokes = [];
  const handlers = new Map();
  const impl = {
    invokes,
    handlers,
    startJobId: "job:native-1",
    startJobImpl: null,
    invoke(cmd, args) {
      invokes.push({ cmd, args });
      if (cmd === "start_job") {
        if (impl.startJobImpl) return impl.startJobImpl(args);
        return Promise.resolve({ job: impl.startJobId, seq: 1 });
      }
      if (cmd === "query_capabilities") {
        return Promise.resolve({
          protocol_min: "2.0",
          protocol_max: "2.0",
          commands: [
            "answer_choice",
            "cancel_job",
            "open_saved_output",
            "query_capabilities",
            "request_destination",
            "start_job",
          ],
        });
      }
      return Promise.resolve({ outcome: "granted" });
    },
    listen(channel, handler) {
      handlers.set(channel, handler);
      return Promise.resolve(() => {
        handlers.delete(channel);
      });
    },
  };
  return impl;
}

function emit(ipc, channel, payload) {
  ipc.handlers.get(channel)({ payload });
}

function observer() {
  return { snapshots: [], hosts: [], snapshot(s) { this.snapshots.push(s); }, hostStatus(h) { this.hosts.push(h); } };
}

// ---------------------------------------------------------------------------
// Projection table
// ---------------------------------------------------------------------------

test("projection maps typed payloads and ignores display text", () => {
  assert.deepEqual(
    projectDesktopEvent("dezoomify://job-progress", { kind: "progress", acquired: 2, total: 5 }),
    { type: "progress", acquired: 2, total: 5 },
  );
  assert.deepEqual(
    projectDesktopEvent("dezoomify://job-output", { kind: "completed", state: "Completed" }),
    { type: "completed" },
  );
  assert.deepEqual(
    projectDesktopEvent("dezoomify://job-output", { kind: "partial-completed", state: "PartiallyCompleted" }),
    { type: "partial-completed" },
  );
  const failed = projectDesktopEvent("dezoomify://job-error", {
    kind: "failed",
    state: "Failed",
    code: "TILE_FAILED",
    phase: "acquisition",
    retryable: true,
    message: "tile failed",
    transport: "native",
  });
  assert.equal(failed.type, "failed");
  assert.equal(failed.error.code, "TILE_FAILED");
  assert.equal(failed.error.phase, "acquisition");
  assert.equal(failed.error.retryable, true);
  assert.equal(failed.error.transport, "native");
  assert.deepEqual(
    projectDesktopEvent("dezoomify://job-state", { kind: "cancelled", seq: 9 }),
    { type: "cancelled" },
  );
  const recovery = projectDesktopEvent("dezoomify://job-state", { kind: "recovery-requested", seq: 4 });
  assert.equal(recovery.type, "recovery-request");
  assert.equal(recovery.generation, 4);
  // Unknown kinds and bare display text never move the snapshot.
  assert.equal(projectDesktopEvent("dezoomify://job-state", { kind: "heartbeat-ok" }), null);
  assert.equal(projectDesktopEvent("dezoomify://job-state", { detail: "Saving image tiles…" }), null);
  assert.equal(projectDesktopEvent("dezoomify://deep-link-pending", { kind: "completed" }), null);
});

// ---------------------------------------------------------------------------
// Start validation (typed, before any invoke)
// ---------------------------------------------------------------------------

test("start validates source, exec, and destination before invoking", async () => {
  const ipc = fakeIpc();
  const service = createDesktopJobService({ ipc });
  const obs = observer();
  await assert.rejects(service.start(nativeRequest("not a url"), obs), (error) => error.code === "desktop.invalid-source");
  await assert.rejects(service.start(nativeRequest("ftp://x/y"), obs), (error) => error.code === "desktop.invalid-source");
  await assert.rejects(
    service.start(nativeRequest("https://user:pw@x.example.org/y"), obs),
    (error) => error.code === "desktop.invalid-source",
  );
  const browserExec = { inputs: [{ url: "https://x.example.org/y" }], engine: {}, exec: { kind: "browser" } };
  await assert.rejects(service.start(browserExec, obs), (error) => error.code === "desktop.invalid-exec");
  const badFormat = nativeRequest();
  badFormat.exec.destination = { kind: "file", suggestedName: "a.bmp", format: "bmp" };
  await assert.rejects(service.start(badFormat, obs), (error) => error.code === "desktop.invalid-destination");
  const badExt = nativeRequest();
  badExt.exec.destination = { kind: "file", suggestedName: "a.jpg", format: "png" };
  await assert.rejects(service.start(badExt, obs), (error) => error.code === "desktop.invalid-destination");
  assert.equal(ipc.invokes.length, 0);
  await service.dispose();
});

// ---------------------------------------------------------------------------
// Live round trip through the double
// ---------------------------------------------------------------------------

test("snapshots flow per job with seq and identity guards", async () => {
  const ipc = fakeIpc();
  const service = createDesktopJobService({ ipc });
  const obs = observer();
  const handle = await service.start(nativeRequest(), obs);
  assert.equal(handle.id, "job:native-1");
  assert.deepEqual(ipc.invokes[0], {
    cmd: "start_job",
    args: { inputUrl: "https://museum.example.org/iiif/1/manifest.json" },
  });
  // All six shell channels are subscribed exactly once.
  assert.equal(ipc.handlers.size, 6);
  assert.ok(ipc.handlers.has("dezoomify://job-snapshot"));

  emit(ipc, "dezoomify://job-progress", { job: "job:native-1", jobId: "job:native-1", seq: 2, kind: "progress", acquired: 3, total: 10 });
  assert.equal(obs.snapshots[obs.snapshots.length - 1].acquired, 3);
  // Stale seq ignored; other jobs ignored.
  emit(ipc, "dezoomify://job-progress", { job: "job:native-1", jobId: "job:native-1", seq: 2, kind: "progress", acquired: 9, total: 10 });
  emit(ipc, "dezoomify://job-progress", { job: "job:other", jobId: "job:other", seq: 3, kind: "progress", acquired: 9, total: 10 });
  assert.equal(obs.snapshots[obs.snapshots.length - 1].acquired, 3);

  emit(ipc, "dezoomify://job-output", { job: "job:native-1", jobId: "job:native-1", seq: 3, kind: "completed", state: "Completed" });
  const terminal = obs.snapshots[obs.snapshots.length - 1];
  assert.equal(terminal.state, "Completed");
  assert.equal(terminal.terminal.kind, "completed");
  // Late events after the terminal outcome stay invisible.
  emit(ipc, "dezoomify://job-progress", { job: "job:native-1", jobId: "job:native-1", seq: 4, kind: "progress", acquired: 10, total: 10 });
  assert.equal(obs.snapshots[obs.snapshots.length - 1].acquired, 3);
  assert.equal(obs.hosts[0].transport, "native");

  await handle.dispose();
  await service.dispose();
});

test("commands route to typed shell commands; engine-only commands reject", async () => {
  const ipc = fakeIpc();
  const service = createDesktopJobService({ ipc });
  const handle = await service.start(nativeRequest(), observer());
  await handle.command({ type: "cancel" });
  await handle.command({ type: "select-image", image: 2 });
  await handle.command({ type: "select-level", level: 1 });
  await handle.command({ type: "recovery-choice", generation: 0, choice: "retry" });
  await handle.command({ type: "recovery-choice", generation: 0, choice: "keep" });
  await handle.command({ type: "recovery-choice", generation: 0, choice: "discard" });
  const routed = ipc.invokes.slice(1).map((call) => call.args.choice ?? call.cmd);
  assert.deepEqual(routed, [
    "cancel_job",
    { kind: "image", index: 2 },
    { kind: "level", index: 1 },
    { kind: "partial", decision: "retry" },
    { kind: "partial", decision: "keep" },
    { kind: "partial", decision: "discard" },
  ]);
  await assert.rejects(handle.command({ type: "pause" }), (error) => error.code === "desktop.unsupported-command");
  await assert.rejects(handle.command({ type: "resume" }), (error) => error.code === "desktop.unsupported-command");
  await handle.dispose();
  await service.dispose();
});

test("destination and output actions use the retained job ref", async () => {
  const ipc = fakeIpc();
  const service = createDesktopJobService({ ipc });
  const handle = await service.start(nativeRequest(), observer());
  const denied = await handle.requestDestination({ format: "bmp", suggestedName: "a.bmp" });
  assert.equal(denied.outcome, "denied");
  const mismatch = await handle.requestDestination({ format: "png", suggestedName: "a.jpg" });
  assert.equal(mismatch.outcome, "denied");
  const granted = await handle.requestDestination({ format: "png", suggestedName: "a.png" });
  assert.equal(granted.outcome, "granted");
  await handle.openOutput(false);
  await handle.openOutput(true);
  const outputCalls = ipc.invokes.filter((call) => call.cmd === "open_saved_output");
  assert.deepEqual(outputCalls, [
    { cmd: "open_saved_output", args: { job: "job:native-1", reveal: false } },
    { cmd: "open_saved_output", args: { job: "job:native-1", reveal: true } },
  ]);
  await handle.dispose();
  await service.dispose();
});

test("capabilities reject unknown shell commands", async () => {
  const ipc = fakeIpc();
  const service = createDesktopJobService({ ipc });
  const caps = await service.queryCapabilities();
  assert.equal(caps.protocolMin, "2.0");
  assert.equal(caps.commands.length, 6);
  ipc.invoke = (cmd) => Promise.resolve({ protocol_min: "2.0", protocol_max: "2.0", commands: ["start_job", "bogus_cmd"] });
  await assert.rejects(service.queryCapabilities(), (error) => error.code === "desktop.capability-mismatch");
  await service.dispose();
});

test("service uses the public Tauri API, never host internals", () => {
  const source = fs.readFileSync(path.join(HERE, "..", "src", "jobService.ts"), "utf8");
  assert.ok(source.includes("@tauri-apps/api/core"));
  assert.ok(source.includes("@tauri-apps/api/event"));
  assert.equal(source.includes("__TAURI_INTERNALS__"), false);
  assert.equal(source.includes("__TAURI_EVENT__"), false);
  assert.equal(source.includes("__TAURI__"), false);
});

test("snapshot channel folds lifecycle, counts, ledger, and terminal", () => {
  const events = foldSnapshotPayload({
    job: "job:native-1",
    jobId: "job:native-1",
    seq: 4,
    kind: "snapshot",
    state: "AcquiringTiles",
    lifecycle: "AcquiringTiles",
    acquired: 3,
    total: 10,
    origin: "https://museum.example.org",
  });
  assert.deepEqual(events, [
    { type: "job-state", state: "AcquiringTiles" },
    { type: "progress", acquired: 3, total: 10 },
  ]);
  const recovery = foldSnapshotPayload({
    job: "job:native-1",
    jobId: "job:native-1",
    seq: 5,
    kind: "snapshot",
    state: "AwaitingPartialDecision",
    lifecycle: "AwaitingPartialDecision",
    acquired: 9,
    total: 12,
    origin: "https://museum.example.org",
    recovery: { missing: ["t-10"], failed: 3, total: 12 },
  });
  assert.equal(recovery[2].type, "recovery-request");
  assert.deepEqual(
    recovery[2].actions.map((action) => action.id),
    ["keep-partial", "discard-partial", "retry"],
  );
  const terminal = foldSnapshotPayload({
    job: "job:native-1",
    jobId: "job:native-1",
    seq: 6,
    kind: "snapshot",
    state: "Completed",
    lifecycle: "AcquiringTiles",
    acquired: 12,
    total: 12,
    origin: "https://museum.example.org",
    terminal: "completed",
    format: "png",
    width: 800,
    height: 600,
    tileCount: 12,
  });
  assert.equal(terminal[terminal.length - 1].type, "completed");
});
