import assert from "node:assert/strict";
import test from "node:test";
import { inspectSavedOutput, invokeNative, openHistoryOutput } from "../src/native.ts";
import { defaultSettings } from "../src/settings.ts";

function platform({ deferRegistration = false } = {}) {
  const handlers = new Map();
  const calls = [];
  let resolve;
  let reject;
  const completion = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  const dispatched = Promise.withResolvers();
  let registered = false;
  return {
    handlers,
    calls,
    resolve(output) {
      resolve({ output, saved_output: { id: "saved:test", filename: "saved image.png" } });
    },
    reject,
    dispatched: dispatched.promise,
    register() {
      registered = true;
      this.emit("dezoomify://registered", { job: calls[0].args.job });
    },
    async listen(channel, handler) {
      handlers.set(channel, handler);
      return () => handlers.delete(channel);
    },
    async invoke(command, args) {
      calls.push({ command, args });
      if (command === "dezoomify") {
        dispatched.resolve();
        if (!deferRegistration) this.register();
        return completion;
      }
      // The retry verdict is a stateless shell query: no job, no registration.
      if (command === "is_retryable") return false;
      assert.ok(registered, `${command} reached Rust before registration`);
    },
    emit(channel, payload) {
      handlers.get(channel)?.({ payload });
    },
  };
}
const request = () => ({ inputUrl: "https://example.com/image", settings: defaultSettings() });
const output = {
  canvas: { width: 512, height: 512 },
  format: "png",
  disposition: "native-publication",
};

test("native invocation preserves settings, progress, completion, and result ownership", async () => {
  const api = platform();
  const progress = [];
  const retry = [];
  const handle = await invokeNative(
    request(),
    { progress: (value) => progress.push(value), retry: (...value) => retry.push(value) },
    api,
  );
  assert.equal(api.calls[0].command, "dezoomify");
  assert.equal(api.calls[0].args.inputUrl, request().inputUrl);
  assert.deepEqual(api.calls[0].args.settings.headers, []);
  api.emit("dezoomify://progress", { job: "job:other", progress: { completed: 100 } });
  assert.equal(progress.length, 0);
  const value = { phase: "acquisition", completed: 3, total: 4 };
  api.emit("dezoomify://progress", { job: handle.id, progress: value });
  assert.deepEqual(progress, [value]);
  api.emit("dezoomify://retry", {
    job: handle.id,
    question: 4,
    request: { tile: { index: 3 }, attempt: 4, requires_approval: true },
  });
  // Delivery waits for the shell's retry verdicts to be stamped on.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(retry[0][0], 4);
  await handle.pause();
  await handle.resume();
  await handle.answer(4, "retry");
  assert.deepEqual(
    api.calls.slice(1).map(({ command }) => command),
    ["pause_job", "resume_job", "answer_retry"],
  );
  assert.deepEqual(api.calls.at(-1).args, { job: handle.id, question: 4, answer: "retry" });
  api.resolve(output);
  assert.deepEqual((await handle.finished).output, output);
  assert.equal(api.handlers.size, 0);
  await handle.openOutput(true);
  assert.deepEqual(api.calls.at(-1), {
    command: "open_saved_output",
    args: { job: handle.id, reveal: true },
  });
  await handle.dispose();
  await assert.rejects(handle.openOutput(false), (error) => error.kind === "stale");
});

test("retired invocation rejects controls and ignores late progress", async () => {
  const api = platform();
  const progress = [];
  const handle = await invokeNative(
    request(),
    { progress: (value) => progress.push(value), retry() {} },
    api,
  );
  const late = api.handlers.get("dezoomify://progress");
  await handle.cancel();
  await handle.dispose();
  await handle.dispose();
  late({ payload: { job: handle.id, progress: { phase: "output" } } });
  assert.equal(progress.length, 0);
  assert.equal(api.calls.filter(({ command }) => command === "release_job").length, 1);
  await assert.rejects(handle.pause(), (error) => error.kind === "stale");
  api.reject({ kind: "cancelled" });
  await assert.rejects(handle.finished, (error) => error.kind === "cancelled");
});

test("early cancellation and replacement wait for native registration", async () => {
  for (const control of ["cancel", "dispose"]) {
    const api = platform({ deferRegistration: true });
    const progress = [];
    let exposed = false;
    const starting = invokeNative(
      request(),
      { progress: (value) => progress.push(value), retry() {} },
      api,
    );
    // A replaced view disposes the handle as soon as invokeNative returns it.
    const stopped = starting.then(async (handle) => {
      exposed = true;
      await handle[control]();
      return handle;
    });
    await api.dispatched;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(exposed, false);
    assert.deepEqual(
      api.calls.map(({ command }) => command),
      ["dezoomify"],
    );
    api.emit("dezoomify://registered", { job: "job:other" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(exposed, false, "another invocation cannot acknowledge this one");

    api.register();
    const handle = await stopped;
    assert.equal(api.calls.at(-1).command, control === "cancel" ? "cancel_job" : "release_job");
    const cancelled = { kind: "cancelled" };
    api.reject(cancelled);
    await assert.rejects(handle.finished, (error) => error === cancelled);
    api.emit("dezoomify://progress", { job: handle.id, progress: { phase: "output" } });
    assert.deepEqual(progress, []);
    assert.equal(api.handlers.size, 0);
  }
});

test("failure before native registration rejects startup and removes all listeners", async () => {
  const api = platform({ deferRegistration: true });
  const starting = invokeNative(request(), { progress() {}, retry() {} }, api);
  const failure = { kind: "invalid-input", detail: "invalid settings: width" };
  const rejected = assert.rejects(starting, (error) => error === failure);
  await api.dispatched;
  api.reject(failure);
  await rejected;
  assert.equal(api.handlers.size, 0);
  assert.deepEqual(
    api.calls.map(({ command }) => command),
    ["dezoomify", "is_retryable"],
  );
});

test("typed failure and complete output retain the native outcome", async () => {
  for (const result of [
    output,
    {
      kind: "tile-failed",
      tile: 3,
      attempts: 1,
      cause: { kind: "decode-failed", detail: "invalid PNG" },
    },
  ]) {
    const api = platform();
    const handle = await invokeNative(request(), { progress() {}, retry() {} }, api);
    if ("kind" in result) {
      api.reject(result);
      await assert.rejects(handle.finished, (error) => error === result);
    } else {
      api.resolve(result);
      assert.deepEqual((await handle.finished).output, result);
    }
    assert.equal(api.handlers.size, 0);
    await handle.dispose();
  }
});

test("untrusted addresses fail before native IPC", async () => {
  for (const inputUrl of ["file:///etc/passwd", "https://user:pass@example.com/image", "invalid"]) {
    const api = platform();
    await assert.rejects(
      invokeNative({ ...request(), inputUrl }, { progress() {}, retry() {} }, api),
    );
    assert.equal(api.calls.length, 0);
  }
});

test("raw header lines cross IPC as typed and Rust rejections return untouched", async () => {
  const headers = ["Referer: https://example.com/viewer", "not a header line", "X-Test: a b"];
  const settings = { ...defaultSettings(), retries: 500, headers };
  const api = platform();
  const handle = await invokeNative(
    { inputUrl: "https://example.com/image", settings },
    { progress() {}, retry() {} },
    api,
  );
  assert.deepEqual(
    api.calls[0].args.settings.headers,
    headers,
    "raw header text is submitted as-is; Rust is the single validator",
  );
  assert.equal(api.calls[0].args.settings.retries, 500, "no client-side bounds pre-validate");
  const rejection = { kind: "invalid-settings", detail: "invalid header: bad name" };
  api.reject(rejection);
  await assert.rejects(handle.finished, (error) => error === rejection);
  await handle.dispose();
});

test("saved references remain usable independently of the invocation and never send filesystem paths", async () => {
  const api = platform();
  const handle = await invokeNative(request(), { progress() {}, retry() {} }, api);
  api.resolve(output);
  const { saved_output: saved } = await handle.finished;
  assert.deepEqual(saved, { id: "saved:test", filename: "saved image.png" });
  await handle.dispose();
  await inspectSavedOutput(saved, api);
  await openHistoryOutput(saved, api);
  assert.deepEqual(api.calls.slice(-2), [
    { command: "inspect_saved_output", args: { id: "saved:test" } },
    { command: "open_history_output", args: { id: "saved:test" } },
  ]);
});
