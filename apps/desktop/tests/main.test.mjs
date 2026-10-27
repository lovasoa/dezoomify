import assert from "node:assert/strict";
import test from "node:test";
import { getLocale, t } from "../../../packages/shared-ui/src/i18n.ts";
import { act, click } from "../../../test/react-dom.mjs";
import { loadSettings } from "../src/settings.ts";
import { flush, mountDesktop, output, progress, typeInto } from "./support/application.mjs";

test("desktop chooses the first supported system language", () => {
  const { root } = mountDesktop({ languages: ["es-ES", "de-AT", "fr"] });
  assert.equal(getLocale(), "de");
  assert.equal(document.documentElement.lang, "de");
  assert.equal(root.querySelector("#dz-url-input").placeholder, t("view.input.placeholder"));
});

test("desktop failure preserves canonical refusal facts and diagnostic context", async () => {
  const { root, invocations, historyStore, start, reset } = mountDesktop();
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
  await flush();
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
  const { root, native, invocations, start, reset } = mountDesktop();
  const invocation = await start();
  const saved = { id: "saved:test", filename: "A painting.png" };
  await act(async () => invocation.resolve(output, saved));
  const check = Promise.withResolvers();
  native.inspectSavedOutput = () => check.promise;
  await reset();
  assert.ok(
    root.querySelector("#dz-url-input"),
    "the main input is ready while the disk check is pending",
  );
  assert.equal(root.querySelector(".dz-history-main").textContent, invocation.request.inputUrl);
  assert.equal(
    root.querySelector("tbody tr td:nth-child(4) .dz-history-output").textContent,
    saved.filename,
  );
  assert.match(root.querySelector("tbody tr").textContent, /Checking file/);
  root.querySelector("#dz-url-input").value = "https://other.test/image";
  await act(async () => check.resolve("available"));
  await flush();
  assert.equal(root.querySelector("#dz-url-input").value, "https://other.test/image");
  const count = invocations.length;
  native.openHistoryOutput = async (reference) => {
    assert.deepEqual(reference, saved);
    throw { kind: "output-not-found" };
  };
  click(root.querySelector(".dz-history-output"));
  await flush();
  assert.equal(root.querySelector("#dz-url-input").value, "https://other.test/image");
  assert.equal(invocations.length, count);
  assert.match(root.querySelector("tbody tr").textContent, /Deleted/);
  assert.equal(root.querySelector(".dz-history-output").disabled, true);
  click(root.querySelector(".dz-history-main"));
  assert.equal(root.querySelector("#dz-url-input").value, invocation.request.inputUrl);
  assert.equal(invocations.length, count, "a deleted result still allows selecting its source");
  native.inspectSavedOutput = async () => "available";
  act(() => window.dispatchEvent(new window.Event("focus")));
  await flush();
  assert.equal(
    root.querySelector(".dz-history-output").disabled,
    false,
    "a restored file becomes available again",
  );
  let opened = 0;
  native.openHistoryOutput = async () => {
    opened++;
  };
  click(root.querySelector(".dz-history-output"));
  await flush();
  assert.equal(opened, 1);
  click(root.querySelector(".dz-history-remove"));
  await flush();
  assert.equal(opened, 1, "removing a row never opens the image");
});

test("desktop catalog choice keeps newer questions and ignores stale previews and answers", async () => {
  const { root, start } = mountDesktop();
  const invocation = await start();
  const catalog = {
    entries: [
      { kind: "image-request", uri: "https://images.test/one" },
      { kind: "image-request", title: "Second", uri: "https://images.test/two" },
    ],
  };
  act(() => invocation.callbacks.imageChoice(1, { kind: "catalog", catalog }));
  assert.equal(root.querySelectorAll(".dz-image-row").length, 2);
  act(() => click(root.querySelector('[data-dz-image-index="1"]')));
  assert.deepEqual(
    invocation.answers.map(({ question, index }) => [question, index]),
    [[1, 1]],
  );
  act(() => invocation.callbacks.imageChoice(2, { kind: "catalog", catalog }));
  act(() =>
    invocation.callbacks.imageChoice(1, {
      kind: "preview",
      index: 0,
      thumbnail: "data:image/png;base64,AAAA",
    }),
  );
  assert.equal(root.querySelector(".dz-image-thumbnail img"), null);
  await act(() => invocation.answers[0].resolve());
  assert.ok(root.querySelector(".dz-image-picker"), "old answer cannot close the new picker");
  act(() => click(root.querySelector('[data-dz-image-index="1"]')));
  await act(() => invocation.answers[1].resolve());
  assert.equal(root.querySelector(".dz-image-picker"), null);
  act(() => invocation.callbacks.imageChoice(1, { kind: "catalog", catalog }));
  assert.equal(root.querySelector(".dz-image-picker"), null);
});

test("desktop retry actions retain a newer native question", async () => {
  const { root, start } = mountDesktop();
  const invocation = await start();
  const request = { tile: { index: 3 }, attempt: 4, requires_approval: true };
  act(() => invocation.callbacks.retry(1, request));
  assert.equal(root.querySelectorAll("[data-dz-retry-actions]").length, 1);
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
  assert.equal(root.querySelector("[data-dz-retry-actions]"), null);
});

test("a failed image answer closes the picker and exposes recovery", async () => {
  const { root, start } = mountDesktop();
  const invocation = await start();
  const catalog = {
    entries: [
      { kind: "image-request", uri: "https://images.test/one" },
      { kind: "image-request", uri: "https://images.test/two" },
    ],
  };
  act(() => invocation.callbacks.imageChoice(1, { kind: "catalog", catalog }));
  act(() => click(root.querySelector('[data-dz-image-index="1"]')));
  await act(() => invocation.answers[0].reject(new Error("native choice unavailable")));
  assert.equal(root.querySelector(".dz-image-picker"), null);
  assert.ok(root.querySelector(".dz-error-section"));
  act(() => invocation.callbacks.imageChoice(2, { kind: "catalog", catalog }));
  assert.equal(root.querySelector(".dz-image-picker"), null);
});

test("a late retry answer failure cannot replace the next invocation", async () => {
  const { root, start, reset } = mountDesktop();
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
});

test("raw header text is submitted as-is; nothing is pre-validated or blocked", async () => {
  const { root, start } = mountDesktop();
  click(root.querySelector(".dz-settings-more"));
  const textarea = root.querySelector(".dz-headers-disclosure textarea");
  assert.ok(textarea, "request headers stay in advanced settings");
  const text = "Referer: https://museum.test/viewer\nnot a header line";
  typeInto(textarea, text);
  const invocation = await start();
  assert.deepEqual(invocation.request.settings.headers, text.split("\n"));
});

test("a typed Rust save rejection shows its reason and persists nothing", async () => {
  const { root, start, reset } = mountDesktop();
  const invocation = await start();
  await act(async () =>
    invocation.reject({ kind: "invalid-settings", detail: "invalid header: bad name" }),
  );
  await flush();
  const diagnostics = root.querySelector("#dz-job-diagnostics");
  assert.match(diagnostics.textContent, /invalid header: bad name/);
  await reset();
  await flush();
  const settingsError = root.querySelector("#dz-settings-error");
  assert.ok(settingsError, "the settings panel surfaces the Rust rejection reason");
  assert.match(settingsError.textContent, /invalid header: bad name/);
});

test("a refused settings edit shows the shell reason and persists nothing", async () => {
  const { root, native } = mountDesktop();
  const retries = root.querySelector('input[aria-label="Retries"]');
  assert.ok(retries, "retries stay in the settings panel");
  native.validateSettings = async (settings) => {
    if (settings.retries > 100) throw { kind: "invalid-settings", detail: "invalid retries: 101" };
  };
  typeInto(retries, 5);
  await flush();
  assert.equal(loadSettings().retries, 5, "an accepted edit is persisted");
  typeInto(retries, 101);
  await flush();
  const settingsError = root.querySelector("#dz-settings-error");
  assert.match(settingsError.textContent, /invalid retries: 101/);
  assert.equal(loadSettings().retries, 5, "the refused edit persists nothing");
});

test("AVIF settings persist and reach the native invocation", async () => {
  const { root, start } = mountDesktop();
  const avif = [...root.querySelectorAll('.dz-quick-menu[aria-label="Format"] button')].find(
    (button) => button.firstElementChild.textContent === "AVIF",
  );
  click(avif);
  await flush();
  assert.equal(loadSettings().output_format, "avif");
  const invocation = await start();
  assert.equal(invocation.request.settings.output_format, "avif");
  await act(async () => invocation.resolve({ ...output, format: "avif" }));
  await flush();
});

test("disposing a desktop mount releases its view and ignores late job events", async () => {
  const { app, root, start } = mountDesktop();
  const invocation = await start();
  await act(() => app.dispose());
  act(() => invocation.callbacks.progress({ ...progress, completed: 999 }));
  await act(async () => invocation.resolve(output));
  act(() => window.dispatchEvent(new window.Event("focus")));
  assert.equal(root.childElementCount, 0);
  assert.equal(app.getCurrentJobId(), null);
});
