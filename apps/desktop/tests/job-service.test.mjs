import assert from "node:assert/strict";
import test from "node:test";
import { createDesktopJobService } from "../src/jobService.ts";

function nativeRequest(url = "https://museum.example.org/iiif/1/manifest.json") {
  return {
    inputs: [{ url }],
    engine: {},
    exec: {
      kind: "native",
      destination: { kind: "file", suggestedName: "dezoomify-800x600.png", format: "png" },
    },
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
        return Promise.resolve({ job: impl.startJobId, seq: 0 });
      }
      if (cmd === "query_capabilities") {
        return Promise.resolve({
          protocol_min: "2.0",
          protocol_max: "2.0",
          commands: [
            "answer_choice",
            "cancel_job",
            "open_saved_output",
            "pause_job",
            "query_capabilities",
            "request_destination",
            "resume_job",
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
  return {
    snapshots: [],
    hosts: [],
    snapshot(s) {
      this.snapshots.push(s);
    },
    hostStatus(h) {
      this.hosts.push(h);
    },
  };
}

// One host routing id around the canonical EngineSnapshotDto.
function snapshotPayload(overrides = {}) {
  const { job = "job:native-1", ...snapshot } = overrides;
  return {
    job,
    snapshot: {
      revision: 2,
      lifecycle: "AcquiringTiles",
      paused: false,
      progress: { completed: 3, total: 10 },
      selection: { image: null, level: null, level_count: 0, catalog: null, deferred: [] },
      decision: null,
      terminal: null,
      output: null,
      ...snapshot,
    },
  };
}

function completedOutput(overrides = {}) {
  return {
    canvas: { width: 800, height: 600 },
    format: "png",
    complete: true,
    missing: [],
    disposition: "native-publication",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Start validation (typed, before any invoke)
// ---------------------------------------------------------------------------

test("start delivers the latest host snapshot emitted before its IPC reply", async () => {
  const ipc = fakeIpc();
  const service = createDesktopJobService({ ipc });
  const terminal = snapshotPayload({
    revision: 4,
    lifecycle: "Failed",
    terminal: { type: "failed", error: { code: "discovery.no-images" } },
  });
  ipc.startJobImpl = async () => {
    emit(ipc, "dezoomify://job-snapshot", snapshotPayload({ revision: 0, lifecycle: "Created" }));
    emit(ipc, "dezoomify://job-snapshot", terminal);
    return { job: "job:native-1" };
  };
  const obs = observer();
  await service.start(nativeRequest(), obs);
  assert.deepEqual(obs.snapshots, [terminal.snapshot]);
  await service.dispose();
});

test("a failed start does not retain snapshots for a later job", async () => {
  const ipc = fakeIpc();
  const service = createDesktopJobService({ ipc });
  ipc.startJobImpl = async () => {
    emit(ipc, "dezoomify://job-snapshot", snapshotPayload());
    throw new Error("start failed");
  };
  await assert.rejects(service.start(nativeRequest(), observer()));
  ipc.startJobImpl = null;
  const obs = observer();
  await service.start(nativeRequest(), obs);
  assert.deepEqual(obs.snapshots, []);
  await service.dispose();
});

test("concurrent starts await all event subscriptions", async () => {
  const ipc = fakeIpc();
  const listen = ipc.listen;
  let release;
  const ready = new Promise((resolve) => {
    release = resolve;
  });
  ipc.listen = async (...args) => {
    await ready;
    return listen(...args);
  };
  const service = createDesktopJobService({ ipc });
  const first = service.start(nativeRequest(), observer());
  const second = service.start(nativeRequest(), observer());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ipc.invokes.length, 0);
  release();
  await Promise.all([first, second]);
  assert.equal(ipc.handlers.size, 2);
  await service.dispose();
});

test("subscription failures reject every start without invoking jobs", async () => {
  const ipc = fakeIpc();
  ipc.listen = async () => {
    throw new Error("no host");
  };
  const service = createDesktopJobService({ ipc });
  for (let i = 0; i < 2; i += 1) {
    await assert.rejects(
      service.start(nativeRequest(), observer()),
      (error) => error.code === "desktop.host-unavailable",
    );
  }
  assert.equal(ipc.invokes.length, 0);
  await service.dispose();
});

test("start validates source, exec, and destination before invoking", async () => {
  const ipc = fakeIpc();
  const service = createDesktopJobService({ ipc });
  const obs = observer();
  await assert.rejects(
    service.start(nativeRequest("not a url"), obs),
    (error) => error.code === "desktop.invalid-source",
  );
  await assert.rejects(
    service.start(nativeRequest("ftp://x/y"), obs),
    (error) => error.code === "desktop.invalid-source",
  );
  await assert.rejects(
    service.start(nativeRequest("https://user:pw@x.example.org/y"), obs),
    (error) => error.code === "desktop.invalid-source",
  );
  const browserExec = {
    inputs: [{ url: "https://x.example.org/y" }],
    engine: {},
    exec: { kind: "browser" },
  };
  await assert.rejects(
    service.start(browserExec, obs),
    (error) => error.code === "desktop.invalid-exec",
  );
  const badFormat = nativeRequest();
  badFormat.exec.destination = { kind: "file", suggestedName: "a.bmp", format: "bmp" };
  await assert.rejects(
    service.start(badFormat, obs),
    (error) => error.code === "desktop.invalid-destination",
  );
  const badExt = nativeRequest();
  badExt.exec.destination = { kind: "file", suggestedName: "a.jpg", format: "png" };
  await assert.rejects(
    service.start(badExt, obs),
    (error) => error.code === "desktop.invalid-destination",
  );
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

  // Snapshot-absent idle: no local snapshot is minted at start, so nothing
  // reaches the observer until the backend emits its first verbatim
  // snapshot. The local revision-0 scale never competes with the engine's.
  assert.equal(obs.snapshots.length, 0);
  emit(
    ipc,
    "dezoomify://job-snapshot",
    snapshotPayload({
      revision: 0,
      lifecycle: "Created",
      progress: { completed: 0, total: null },
    }),
  );
  assert.equal(obs.snapshots.length, 1);
  assert.equal(obs.snapshots[0].lifecycle, "Created");
  assert.equal(obs.snapshots[0].revision, 0);

  // Live snapshots forward verbatim (no fold, no seq guard).
  emit(ipc, "dezoomify://job-snapshot", snapshotPayload({ revision: 2 }));
  assert.equal(obs.snapshots[obs.snapshots.length - 1].progress.completed, 3);
  assert.equal(obs.snapshots[obs.snapshots.length - 1].lifecycle, "AcquiringTiles");
  // Same revision forwards again verbatim (no dedupe in the service: the
  // shell owns monotonicity and exactly-once); other jobs stay ignored.
  emit(ipc, "dezoomify://job-snapshot", snapshotPayload({ revision: 2 }));
  assert.equal(obs.snapshots[obs.snapshots.length - 1].progress.completed, 3);
  emit(
    ipc,
    "dezoomify://job-snapshot",
    snapshotPayload({
      job: "job:other",
      revision: 3,
      progress: { completed: 9, total: 10 },
    }),
  );
  assert.equal(obs.snapshots[obs.snapshots.length - 1].progress.completed, 3);

  emit(
    ipc,
    "dezoomify://job-snapshot",
    snapshotPayload({
      revision: 3,
      lifecycle: "Completed",
      progress: { completed: 10, total: 10 },
      terminal: { type: "completed" },
      output: completedOutput(),
    }),
  );
  const terminal = obs.snapshots[obs.snapshots.length - 1];
  assert.equal(terminal.lifecycle, "Completed");
  assert.equal(terminal.terminal.type, "completed");
  assert.equal(terminal.output.complete, true);
  assert.equal(obs.hosts[0].transport, "native");

  await handle.dispose();
  await service.dispose();
});

test("partial terminal never reads as completed and failures stay typed", async () => {
  const ipc = fakeIpc();
  const service = createDesktopJobService({ ipc });
  const obs = observer();
  await service.start(nativeRequest(), obs);
  emit(
    ipc,
    "dezoomify://job-snapshot",
    snapshotPayload({
      revision: 4,
      lifecycle: "PartiallyCompleted",
      progress: { completed: 9, total: 12 },
      terminal: { type: "partial-completed", missing: [10] },
      output: completedOutput({ complete: false, missing: [10] }),
    }),
  );
  const partial = obs.snapshots[obs.snapshots.length - 1];
  assert.equal(partial.lifecycle, "PartiallyCompleted");
  assert.equal(partial.terminal.type, "partial-completed");
  assert.equal(partial.output.complete, false);
  assert.deepEqual(partial.output.missing, [10]);

  const obs2 = observer();
  const ipc2 = fakeIpc();
  const service2 = createDesktopJobService({ ipc: ipc2 });
  await service2.start(nativeRequest(), obs2);
  emit(
    ipc2,
    "dezoomify://job-snapshot",
    snapshotPayload({
      revision: 5,
      lifecycle: "Failed",
      terminal: {
        type: "failed",
        error: {
          code: "tile.download-failed",
          phase: "acquisition",
          retryable: true,
          message: "tile failed",
          recovery: [],
          transport: "native",
        },
      },
    }),
  );
  const failed = obs2.snapshots[obs2.snapshots.length - 1];
  assert.equal(failed.lifecycle, "Failed");
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
  await handle.command({ type: "answer-partial", generation: 7, decision: "retry" });
  await handle.command({ type: "answer-partial", generation: 7, decision: "keep" });
  await handle.command({ type: "answer-partial", generation: 7, decision: "discard" });
  await handle.command({ type: "pause" });
  await handle.command({ type: "resume" });
  const routed = ipc.invokes.slice(1).map((call) => call.args.choice ?? call.cmd);
  assert.deepEqual(routed, [
    "cancel_job",
    { kind: "image", index: 2 },
    { kind: "level", index: 1 },
    { kind: "partial", generation: 7, decision: "retry" },
    { kind: "partial", generation: 7, decision: "keep" },
    { kind: "partial", generation: 7, decision: "discard" },
    "pause_job",
    "resume_job",
  ]);
  const pauseCall = ipc.invokes.find((call) => call.cmd === "pause_job");
  const resumeCall = ipc.invokes.find((call) => call.cmd === "resume_job");
  assert.deepEqual(pauseCall.args, { job: "job:native-1" });
  assert.deepEqual(resumeCall.args, { job: "job:native-1" });
  // Engine-internal commands with no shell command still reject typed.
  await assert.rejects(
    handle.command({ type: "tile-acquired", request: 0 }),
    (error) => error.code === "desktop.unsupported-command",
  );
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
  assert.equal(caps.commands.length, 8);
  ipc.invoke = (cmd) =>
    Promise.resolve({
      protocol_min: "2.0",
      protocol_max: "2.0",
      commands: ["start_job", "bogus_cmd"],
    });
  await assert.rejects(
    service.queryCapabilities(),
    (error) => error.code === "desktop.capability-mismatch",
  );
  await service.dispose();
});
