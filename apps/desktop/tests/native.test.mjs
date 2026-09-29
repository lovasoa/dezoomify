import assert from "node:assert/strict";
import test from "node:test";
import { invokeNative } from "../src/native.ts";
import { defaultSettings } from "../src/settings.ts";

function platform() {
  const handlers = new Map();
  const calls = [];
  let resolve;
  let reject;
  const completion = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return {
    handlers,
    calls,
    resolve,
    reject,
    async listen(channel, handler) {
      handlers.set(channel, handler);
      return () => handlers.delete(channel);
    },
    async invoke(command, args) {
      calls.push({ command, args });
      if (command === "dezoomify") return completion;
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
