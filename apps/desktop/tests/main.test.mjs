import "../../../test/tsx-loader.mjs";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { getLocale, setLocale, t } from "../../../packages/shared-ui/src/i18n.ts";
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
      resolve(output, saved_output) {
        resolve({ output, saved_output });
      },
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
          export const inspectSavedOutput = async (saved) => await globalThis.desktopTestNative.inspectSavedOutput?.(saved) ?? "available";
          export const openHistoryOutput = async (saved) => { await globalThis.desktopTestNative.openHistoryOutput?.(saved); };
          export const forgetSavedOutput = async () => {};
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
const historyStore = new Map();
globalThis.localStorage = {
  getItem: (key) => historyStore.get(key) ?? null,
  setItem: (key, value) => historyStore.set(key, value),
  removeItem: (key) => historyStore.delete(key),
};
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: { languages: ["es-ES", "de-AT", "fr"], language: "fr", userAgent: "test" },
});
await act(async () => {
  await import("../src/main.ts");
});
assert.equal(getLocale(), "de");
assert.equal(document.documentElement.lang, "de");
assert.equal(root.querySelector("#dz-url-input").placeholder, t("view.input.placeholder"));
if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
else delete globalThis.navigator;
setLocale("en");
await act(async () => {
  const { update } = await import("../src/main.ts");
  update();
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
  const recent = () => JSON.parse(historyStore.get("dezoomify.desktop.history.v2"))[0];
  assert.equal(recent().status, "started");
  act(() =>
    invocation.callbacks.progress({
      ...progress,
      title: "A painting",
      selected: { width: 512, height: 512 },
    }),
  );
  assert.equal(recent().title, "A painting");
  assert.equal(recent().width, 512);
  await act(async () =>
    invocation.reject({
      kind: "tile-failed",
      tile: 0,
      attempts: 1,
      cause: {
        kind: "resource",
        request: "https://tiles.test/redirected/0.jpg?token=exact",
        resource_kind: "tile",
        source: {
          kind: "http-error",
          status: 403,
          transport: "native",
          preview: "Sign in to see the collection",
          detail: "the source returned its signed-in challenge",
        },
      },
    }),
  );
  await tick();
  assert.match(root.textContent, /refused to share/);
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
  assert.match(diagnostics, /kind=tile-failed/);
  assert.equal(recent().status, "failed");
  await reset();
  const count = invocations.length;
  root.querySelector("#dz-url-input").value = "https://other.test/image";
  click(root.querySelector(".dz-history-main"));
  assert.equal(root.querySelector("#dz-url-input").value, invocation.request.inputUrl);
  assert.equal(invocations.length, count);
  click(root.querySelector(".dz-history-remove"));
  assert.deepEqual(JSON.parse(historyStore.get("dezoomify.desktop.history.v2")), []);
});

test("saved history renders during slow disk checks, opens the file after retirement, and detects deletion at click time", async () => {
  const invocation = await start();
  const saved = { id: "saved:test", filename: "A painting.png" };
  await act(async () => invocation.resolve(output, saved));
  const check = Promise.withResolvers();
  globalThis.desktopTestNative.inspectSavedOutput = () => check.promise;
  await reset();
  assert.ok(
    root.querySelector("#dz-url-input"),
    "the main input is ready while the disk check is pending",
  );
  assert.equal(root.querySelector(".dz-history-main").textContent, saved.filename);
  assert.match(root.querySelector("tbody tr").textContent, /Checking file/);
  root.querySelector("#dz-url-input").value = "https://other.test/image";
  await act(async () => check.resolve("available"));
  await tick();
  assert.equal(root.querySelector("#dz-url-input").value, "https://other.test/image");
  const count = invocations.length;
  globalThis.desktopTestNative.openHistoryOutput = async (reference) => {
    assert.deepEqual(reference, saved);
    throw { kind: "output-not-found" };
  };
  click(root.querySelector("tbody tr td:nth-child(3)"));
  await tick();
  assert.equal(root.querySelector("#dz-url-input").value, "https://other.test/image");
  assert.equal(invocations.length, count);
  assert.match(root.querySelector("tbody tr").textContent, /Deleted/);
  assert.equal(root.querySelector(".dz-history-main").disabled, true);
  globalThis.desktopTestNative.inspectSavedOutput = async () => "available";
  act(() => window.dispatchEvent(new window.Event("focus")));
  await tick();
  assert.equal(
    root.querySelector(".dz-history-main").disabled,
    false,
    "a restored file becomes available again",
  );
  let opened = 0;
  globalThis.desktopTestNative.openHistoryOutput = async () => {
    opened++;
  };
  click(root.querySelector(".dz-history-main"));
  await tick();
  assert.equal(opened, 1);
  click(root.querySelector(".dz-history-remove"));
  await tick();
  assert.equal(opened, 1, "removing a row never opens the image");
  delete globalThis.desktopTestNative.openHistoryOutput;
  delete globalThis.desktopTestNative.inspectSavedOutput;
});

test("desktop retry actions retain a newer native question", async () => {
  const invocation = await start();
  const request = { tile: { index: 3 }, attempt: 4, requires_approval: true };
  act(() => invocation.callbacks.retry(1, request));
  assert.equal(root.querySelectorAll("[data-dz-retry-decision]").length, 1);
  assert.equal(root.querySelectorAll(".dz-retry-section").length, 1);
  click(root.querySelector("[data-dz-retry-choice=retry]"));
  assert.equal(invocation.answers[0].question, 1);
  assert.equal(invocation.answers[0].choice, "retry");
  act(() => invocation.callbacks.retry(2, { ...request, attempt: 5 }));
  await act(async () => invocation.answers[0].resolve());
  assert.ok(root.querySelector("[data-dz-retry-choice=cancel]"));
  click(root.querySelector("[data-dz-retry-choice=cancel]"));
  assert.equal(invocation.answers[1].question, 2);
  assert.equal(invocation.answers[1].choice, "cancel");
  await act(async () => invocation.answers[1].resolve());
  assert.equal(root.querySelector("[data-dz-retry-decision]"), null);
  await reset();
});

test("a late retry answer failure cannot replace the next invocation", async () => {
  const first = await start();
  const request = { tile: { index: 3 }, attempt: 4, requires_approval: true };
  act(() => first.callbacks.retry(1, request));
  click(root.querySelector("[data-dz-retry-choice=cancel]"));
  await reset();
  const second = await start();
  await act(async () => first.answers[0].reject({ kind: "interaction-expired" }));
  assert.equal(root.querySelector(".dz-error-section"), null);
  assert.ok(root.querySelector(".dz-job-section"));
  act(() => second.callbacks.retry(2, request));
  assert.ok(root.querySelector("[data-dz-retry-choice=retry]"));
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
