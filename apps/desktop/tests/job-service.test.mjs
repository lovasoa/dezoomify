import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDesktopJobService } from "../src/jobService.ts";

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

function snapshotPayload(overrides = {}) {
  return {
    job: "job:native-1",
    jobId: "job:native-1",
    revision: 2,
    seq: 2,
    kind: "snapshot",
    jobSnapshot: true,
    state: "AcquiringTiles",
    lifecycle: "AcquiringTiles",
    catalog: null,
    acquired: 3,
    total: 10,
    paused: false,
    selection: { image: null, level: null },
    warnings: [],
    recovery: null,
    terminal: null,
    output: null,
    displayOnly: false,
    updatedAt: 0,
    origin: "https://museum.example.org",
    ...overrides,
  };
}

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
// Live round trip through the double (verbatim forward, no fold)
// ---------------------------------------------------------------------------

test("snapshots forward verbatim per job with identity guard only", async () => {
  const ipc = fakeIpc();
  const service = createDesktopJobService({ ipc });
  const obs = observer();
  const handle = await service.start(nativeRequest(), obs);
  assert.equal(handle.id, "job:native-1");
  assert.deepEqual(ipc.invokes[0], {
    cmd: "start_job",
    args: { inputUrl: "https://museum.example.org/iiif/1/manifest.json" },
  });
  // Only the snapshot transport plus the deep-link cue are subscribed.
  assert.equal(ipc.handlers.size, 2);
  assert.ok(ipc.handlers.has("dezoomify://job-snapshot"));
  assert.ok(ipc.handlers.has("dezoomify://deep-link-pending"));

  // The initial local snapshot is Created; the first shell snapshot
  // forwards verbatim (no fold, no seq guard).
  assert.equal(obs.snapshots[0].state, "Created");
  emit(ipc, "dezoomify://job-snapshot", snapshotPayload({ revision: 2, seq: 2, acquired: 3, total: 10 }));
  assert.equal(obs.snapshots[obs.snapshots.length - 1].acquired, 3);
  assert.equal(obs.snapshots[obs.snapshots.length - 1].state, "AcquiringTiles");
  // Same revision forwards again verbatim (no dedupe in the service: the
  // shell owns monotonicity and exactly-once); other jobs stay ignored.
  emit(ipc, "dezoomify://job-snapshot", snapshotPayload({ revision: 2, seq: 2, acquired: 3, total: 10 }));
  assert.equal(obs.snapshots[obs.snapshots.length - 1].acquired, 3);
  emit(ipc, "dezoomify://job-snapshot", snapshotPayload({ job: "job:other", jobId: "job:other", revision: 3, seq: 3, acquired: 9 }));
  assert.equal(obs.snapshots[obs.snapshots.length - 1].acquired, 3);

  emit(ipc, "dezoomify://job-snapshot", snapshotPayload({
    revision: 3,
    seq: 3,
    state: "Completed",
    acquired: 10,
    total: 10,
    terminal: { kind: "completed" },
    output: { doneTiles: 10, totalTiles: 10, failedTiles: 0, partial: false, format: "png", width: 800, height: 600, missingTiles: [] },
  }));
  const terminal = obs.snapshots[obs.snapshots.length - 1];
  assert.equal(terminal.state, "Completed");
  assert.equal(terminal.terminal.kind, "completed");
  assert.equal(terminal.output.partial, false);
  assert.equal(obs.hosts[0].transport, "native");

  await handle.dispose();
  await service.dispose();
});

test("partial terminal never reads as completed and failures stay typed", async () => {
  const ipc = fakeIpc();
  const service = createDesktopJobService({ ipc });
  const obs = observer();
  await service.start(nativeRequest(), obs);
  emit(ipc, "dezoomify://job-snapshot", snapshotPayload({
    revision: 4,
    seq: 4,
    state: "PartiallyCompleted",
    terminal: { kind: "partial-completed" },
    output: { doneTiles: 9, totalTiles: 12, failedTiles: 3, partial: true, format: "png", width: 800, height: 600, missingTiles: ["t-10"], siblingName: "out.partial.png" },
  }));
  const partial = obs.snapshots[obs.snapshots.length - 1];
  assert.equal(partial.state, "PartiallyCompleted");
  assert.equal(partial.terminal.kind, "partial-completed");
  assert.equal(partial.output.partial, true);
  assert.deepEqual(partial.output.missingTiles, ["t-10"]);

  const obs2 = observer();
  const ipc2 = fakeIpc();
  const service2 = createDesktopJobService({ ipc: ipc2 });
  await service2.start(nativeRequest(), obs2);
  emit(ipc2, "dezoomify://job-snapshot", snapshotPayload({
    revision: 5,
    seq: 5,
    state: "Failed",
    terminal: { kind: "failed", error: { code: "tile.download-failed", phase: "acquisition", retryable: true, message: "tile failed", recovery: [], transport: "native" } },
  }));
  const failed = obs2.snapshots[obs2.snapshots.length - 1];
  assert.equal(failed.state, "Failed");
  assert.equal(failed.terminal.error.code, "tile.download-failed");
  assert.equal(failed.terminal.error.transport, "native");
  await service.dispose();
  await service2.dispose();
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

test("snapshot channel is the only job transport", () => {
  const source = fs.readFileSync(path.join(HERE, "..", "src", "events.ts"), "utf8");
  assert.ok(source.includes("dezoomify://job-snapshot"));
  assert.ok(source.includes("dezoomify://deep-link-pending"));
  assert.equal(source.includes("dezoomify://job-state"), false);
  assert.equal(source.includes("dezoomify://job-progress"), false);
  assert.equal(source.includes("dezoomify://job-output"), false);
  assert.equal(source.includes("dezoomify://job-error"), false);
  const service = fs.readFileSync(path.join(HERE, "..", "src", "jobService.ts"), "utf8");
  assert.equal(service.includes("SHELL_STATE_TABLE"), false);
  assert.equal(service.includes("projectDesktopEvent"), false);
  assert.equal(service.includes("seenSeq"), false);
});
