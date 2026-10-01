import "../../../test/tsx-loader.mjs";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { act, click, makeContainer } from "../../../test/react-dom.mjs";
import { loadSettings } from "../src/settings.ts";

// linkedom documents lack `oninput`, which keeps React's text-input change
// detection disabled. Arm it before react-dom loads (through main.ts) so
// edits fire onChange.
document.oninput = null;

/** Type into a controlled field the way the settings view tests do. */
function typeInto(element, value) {
  act(() => {
    Object.defineProperty(element, "value", { configurable: true, writable: true, value });
    element.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
}

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
          export const validateSettings = async (settings) => { await globalThis.desktopTestNative.validateSettings?.(settings); };
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
      kind: "no-usable-tiles",
      transient: false,
      failures: [
        {
          kind: "http-error",
          status: 403,
          request: "https://tiles.test/redirected/0.jpg?token=exact",
          transport: "native",
          preview: "Sign in to see the collection",
          detail: "the source returned its signed-in challenge",
        },
      ],
    }),
  );
  await tick();
  assert.match(root.textContent, /could not be retrieved/);
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
  assert.match(diagnostics, /kind=no-usable-tiles/);
  await reset();
});

test("desktop partial actions honor retryability and retain a newer native question", async () => {
  const invocation = await start();
  const missing = (retryable) => ({
    missing: [
      {
        tile: 3,
        failures: [
          { kind: "http-error", status: retryable ? 503 : 403, transport: "native", retryable },
        ],
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
    first.callbacks.partial(1, {
      missing: [{ tile: 3, failures: [{ kind: "network-failure", transport: "native" }] }],
    }),
  );
  click(root.querySelector("[data-dz-partial-choice=discard]"));
  await reset();
  const second = await start();
  await act(async () => first.answers[0].reject({ kind: "interaction-expired" }));
  assert.equal(root.querySelector(".dz-error-section"), null);
  assert.ok(root.querySelector(".dz-job-section"));
  act(() =>
    second.callbacks.partial(2, {
      missing: [{ tile: 1, failures: [{ kind: "decode-failed" }] }],
    }),
  );
  assert.ok(root.querySelector("[data-dz-partial-choice=keep]"));
  await reset();
});

test("raw header text is submitted as-is; nothing is pre-validated or blocked", async () => {
  click(root.querySelector(".dz-settings-more"));
  const textarea = root.querySelector(".dz-headers-disclosure textarea");
  assert.ok(textarea, "request headers stay in advanced settings");
  const text = "Referer: https://museum.test/viewer\nnot a header line";
  typeInto(textarea, text);
  const invocation = await start();
  assert.deepEqual(invocation.request.settings.headers, text.split("\n"));
  await reset();
});

test("a typed Rust save rejection shows its reason and persists nothing", async () => {
  const invocation = await start();
  await act(async () =>
    invocation.reject({ kind: "invalid-settings", detail: "invalid header: bad name" }),
  );
  await tick();
  const diagnostics = root.querySelector("#dz-job-diagnostics");
  assert.match(diagnostics.textContent, /invalid header: bad name/);
  await reset();
  await tick();
  const settingsError = root.querySelector("#dz-settings-error");
  assert.ok(settingsError, "the settings panel surfaces the Rust rejection reason");
  assert.match(settingsError.textContent, /invalid header: bad name/);
});

test("a refused settings edit shows the shell reason and persists nothing", async () => {
  const retries = root.querySelector('input[aria-label="Retries"]');
  assert.ok(retries, "retries stay in the settings panel");
  globalThis.desktopTestNative.validateSettings = async (settings) => {
    if (settings.retries > 100) throw { kind: "invalid-settings", detail: "invalid retries: 101" };
  };
  typeInto(retries, 5);
  await tick();
  assert.equal(loadSettings().retries, 5, "an accepted edit is persisted");
  typeInto(retries, 101);
  await tick();
  const settingsError = root.querySelector("#dz-settings-error");
  assert.match(settingsError.textContent, /invalid retries: 101/);
  assert.equal(loadSettings().retries, 5, "the refused edit persists nothing");
  delete globalThis.desktopTestNative.validateSettings;
});
