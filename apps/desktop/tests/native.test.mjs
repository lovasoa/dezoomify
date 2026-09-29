import assert from "node:assert/strict";
import test from "node:test";
import { invokeNative } from "../src/native.ts";
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
    resolve,
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
      assert.ok(registered, `${command} reached Rust before registration`);
    },
    emit(channel, payload) {
      handlers.get(channel)?.({ payload });
    },
  };
}
const request = () => ({ inputUrl: "https://example.com/image", settings: defaultSettings() });
const output = {
  complete: true,
  missing: [],
  canvas: { width: 512, height: 512 },
  format: "png",
  disposition: "native-publication",
};

test("native invocation preserves settings, progress, completion, and result ownership", async () => {
  const api = platform();
  const progress = [];
  const partial = [];
  const handle = await invokeNative(
    request(),
    { progress: (value) => progress.push(value), partial: (...value) => partial.push(value) },
    api,
  );
  assert.equal(api.calls[0].command, "dezoomify");
  assert.equal(api.calls[0].args.inputUrl, request().inputUrl);
  assert.deepEqual(api.calls[0].args.settings.headers, {});
  api.emit("dezoomify://progress", { job: "job:other", progress: { completed: 100 } });
  assert.equal(progress.length, 0);
  const value = { phase: "acquisition", completed: 3, total: 4 };
  api.emit("dezoomify://progress", { job: handle.id, progress: value });
  assert.deepEqual(progress, [value]);
  api.emit("dezoomify://partial", {
    job: handle.id,
    question: 4,
    missing: { missing: [{ tile: 3, failures: [] }] },
  });
  assert.equal(partial[0][0], 4);
  await handle.pause();
  await handle.resume();
  await handle.answer(4, "retry");
  assert.deepEqual(
    api.calls.slice(1).map(({ command }) => command),
    ["pause_job", "resume_job", "answer_partial"],
  );
  assert.deepEqual(api.calls.at(-1).args, { job: handle.id, question: 4, answer: "retry" });
  api.resolve(output);
  assert.deepEqual(await handle.finished, output);
  assert.equal(api.handlers.size, 0);
  await handle.openOutput(true);
  assert.deepEqual(api.calls.at(-1), {
    command: "open_saved_output",
    args: { job: handle.id, reveal: true },
  });
  await handle.dispose();
  await assert.rejects(
    handle.openOutput(false),
    (error) => error.code === "desktop.result-retired",
  );
});

test("retired invocation rejects controls and ignores late progress", async () => {
  const api = platform();
  const progress = [];
  const handle = await invokeNative(
    request(),
    { progress: (value) => progress.push(value), partial() {} },
    api,
  );
  const late = api.handlers.get("dezoomify://progress");
  await handle.cancel();
  await handle.dispose();
  await handle.dispose();
  late({ payload: { job: handle.id, progress: { phase: "output" } } });
  assert.equal(progress.length, 0);
  assert.equal(api.calls.filter(({ command }) => command === "release_job").length, 1);
  await assert.rejects(handle.pause(), (error) => error.code === "desktop.result-retired");
  api.reject({ code: "job.cancelled", message: "cancelled" });
  await assert.rejects(handle.finished, (error) => error.code === "job.cancelled");
});

test("early cancellation and replacement wait for native registration", async () => {
  for (const control of ["cancel", "dispose"]) {
    const api = platform({ deferRegistration: true });
    const progress = [];
    let exposed = false;
    const starting = invokeNative(
      request(),
      { progress: (value) => progress.push(value), partial() {} },
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
    const cancelled = { code: "job.cancelled", message: "cancelled before publication" };
    api.reject(cancelled);
    await assert.rejects(handle.finished, (error) => error === cancelled);
    api.emit("dezoomify://progress", { job: handle.id, progress: { phase: "output" } });
    assert.deepEqual(progress, []);
    assert.equal(api.handlers.size, 0);
  }
});

test("failure before native registration rejects startup and removes all listeners", async () => {
  const api = platform({ deferRegistration: true });
  const starting = invokeNative(request(), { progress() {}, partial() {} }, api);
  const failure = { code: "job.invalid-input", message: "invalid settings", detail: "width" };
  const rejected = assert.rejects(starting, (error) => error === failure);
  await api.dispatched;
  api.reject(failure);
  await rejected;
  assert.equal(api.handlers.size, 0);
  assert.deepEqual(
    api.calls.map(({ command }) => command),
    ["dezoomify"],
  );
});

test("typed failure and partial output retain the native outcome", async () => {
  for (const result of [
    { ...output, complete: false, missing: [3] },
    { code: "job.partial-discarded", phase: "acquisition", retryable: false, message: "failed" },
  ]) {
    const api = platform();
    const handle = await invokeNative(request(), { progress() {}, partial() {} }, api);
    if ("code" in result) {
      api.reject(result);
      await assert.rejects(handle.finished, (error) => error === result);
    } else {
      api.resolve(result);
      assert.deepEqual(await handle.finished, result);
    }
    assert.equal(api.handlers.size, 0);
    await handle.dispose();
  }
});

test("untrusted addresses fail before native IPC", async () => {
  for (const inputUrl of ["file:///etc/passwd", "https://user:pass@example.com/image", "invalid"]) {
    const api = platform();
    await assert.rejects(
      invokeNative({ ...request(), inputUrl }, { progress() {}, partial() {} }, api),
    );
    assert.equal(api.calls.length, 0);
  }
});
