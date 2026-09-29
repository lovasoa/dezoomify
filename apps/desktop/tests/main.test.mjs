import "../../../test/tsx-loader.mjs";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { act, click, makeContainer } from "../../../test/react-dom.mjs";

const invocations = [];
const output = {
  complete: true,
  missing: [],
  canvas: { width: 512, height: 512 },
  format: "png",
  disposition: "native-publication",
};
const progress = { phase: "acquisition", completed: 3, total: 4 };
const tick = () => act(() => new Promise((resolve) => setImmediate(resolve)));

globalThis.desktopTestNative = {
  async invokeNative(request, callbacks) {
    let resolve, reject;
    const finished = new Promise((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const answers = [];
    const invocation = {
      request,
      callbacks,
      resolve,
      reject,
      answers,
      id: `job:test-${invocations.length}`,
      finished,
      async pause() {},
      async resume() {},
      async cancel() {},
      async dispose() {},
      async openOutput() {},
      answer(question, choice) {
        return new Promise((resolve, reject) =>
          answers.push({ question, choice, resolve, reject }),
        );
      },
    };
    invocations.push(invocation);
    callbacks.progress(progress);
    return invocation;
  },
};
registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith("/apps/desktop/src/native.ts"))
      return {
        format: "module",
        shortCircuit: true,
        source: `
          export const invokeNative = (...args) => globalThis.desktopTestNative.invokeNative(...args);
          export const listenDeepLinks = async () => {};
          export const openExternalLink = async () => {};
          export const readNativeDiagnostics = async () => { throw new Error("No native report"); };
        `,
      };
    return nextLoad(url, context);
  },
});

const root = makeContainer();
root.id = "root";
await act(async () => {
  await import("../src/main.ts");
});

async function start() {
  act(() => {
    root.querySelector("#dz-url-input").value = "https://museum.test/image";
    root
      .querySelector("form")
      .dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  });
  await tick();
  return invocations.at(-1);
}

async function reset() {
  const invocation = invocations.at(-1);
  if (!root.querySelector(".dz-error-section")) {
    await act(async () => invocation?.resolve(output));
    await tick();
  }
  click(
    root.querySelector(
      "#dz-btn-start-over, #dz-btn-another, #dz-btn-reset, .dz-error-section .dz-actions-row button:last-child",
    ),
  );
  await tick();
}

test("desktop failure preserves canonical refusal facts and diagnostic context", async () => {
  const invocation = await start();
  await act(async () =>
    invocation.reject({
      code: "job.no-usable-tiles",
      message: "No usable tiles were acquired.",
      detail: "The source returned its signed-in challenge.",
      phase: "acquisition",
      transport: "native",
      request: "https://tiles.test/redirected/0.jpg?token=exact",
      resource_kind: "tile",
      blocked_reason: "forbidden",
      http: 403,
      preview: "Sign in to see the collection",
      retryable: false,
    }),
  );
  await tick();
  assert.match(root.textContent, /website refused access/);
  assert.equal(root.querySelector("#dz-btn-try-again"), null);
  assert.equal(
    [...root.querySelectorAll(".dz-error-section button")].some((button) =>
      /retry|try again/i.test(button.textContent),
    ),
    false,
  );
  const diagnostics = root.querySelector("#dz-job-diagnostics").textContent;
  assert.match(diagnostics, /https:\/\/tiles.test\/redirected\/0.jpg\?token=exact/);
  assert.match(diagnostics, /source returned its signed-in challenge/);
  assert.match(diagnostics, /Sign in to see the collection/);
  assert.match(diagnostics, /retryable=false/);
  await reset();
});

test("desktop partial actions honor retryability and retain a newer native question", async () => {
  const invocation = await start();
  const missing = (retryable) => ({
    missing: [
      {
        tile: 3,
        failures: [{ code: "TRANSPORT_HTTP_ERROR", http: retryable ? 503 : 403, retryable }],
      },
    ],
  });
  act(() => invocation.callbacks.partial(1, missing(false)));
  assert.equal(root.querySelectorAll("[data-dz-partial-decision]").length, 1);
  assert.equal(root.querySelectorAll(".dz-partial-section").length, 1);
  assert.equal(root.querySelector("[data-dz-partial-choice=retry]"), null);
  assert.match(root.querySelector("[data-dz-partial-choice=keep]").textContent, /Keep/);
  act(() => invocation.callbacks.partial(2, missing(true)));
  click(root.querySelector("[data-dz-partial-choice=retry]"));
  assert.equal(invocation.answers[0].question, 2);
  assert.equal(invocation.answers[0].choice, "retry");
  act(() => invocation.callbacks.partial(3, missing(false)));
  await act(async () => invocation.answers[0].resolve());
  assert.ok(root.querySelector("[data-dz-partial-choice=keep]"));
  click(root.querySelector("[data-dz-partial-choice=keep]"));
  assert.equal(invocation.answers[1].question, 3);
  assert.equal(invocation.answers[1].choice, "keep");
  await act(async () => invocation.answers[1].resolve());
  assert.equal(root.querySelector("[data-dz-partial-decision]"), null);
  await reset();
});

test("a late partial answer failure cannot replace the next invocation", async () => {
  const first = await start();
  act(() =>
    first.callbacks.partial(1, { missing: [{ tile: 3, failures: [{ retryable: true }] }] }),
  );
  click(root.querySelector("[data-dz-partial-choice=discard]"));
  await reset();
  const second = await start();
  await act(async () =>
    first.answers[0].reject({ code: "interaction.expired", message: "Expired" }),
  );
  assert.equal(root.querySelector(".dz-error-section"), null);
  assert.ok(root.querySelector(".dz-job-section"));
  act(() =>
    second.callbacks.partial(2, { missing: [{ tile: 1, failures: [{ retryable: false }] }] }),
  );
  assert.ok(root.querySelector("[data-dz-partial-choice=keep]"));
  await reset();
});
