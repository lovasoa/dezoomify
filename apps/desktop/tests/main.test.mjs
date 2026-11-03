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
  assert.equal(root.querySelector("#dz-url-input").value, invocation.request.source.url);
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
  assert.equal(root.querySelector(".dz-history-main").textContent, invocation.request.source.url);
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
  assert.equal(root.querySelector("#dz-url-input").value, invocation.request.source.url);
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
    invocation.answers.map(({ question, choice }) => [question, choice]),
    [[1, { kind: "one", index: 1 }]],
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

test("desktop offers Download all for ready images and keeps every batch result", async () => {
  const { root, start, native } = mountDesktop();
  const invocation = await start();
  const image = {
    kind: "image",
    format: "deepzoom",
    sourceUrl: invocation.request.source.url,
    levels: [],
  };
  act(() =>
    invocation.callbacks.imageChoice(1, {
      kind: "catalog",
      catalog: {
        entries: [
          { ...image, title: "First" },
          { ...image, title: "Second" },
        ],
      },
    }),
  );
  click(root.querySelector("#dz-btn-download-all"));
  assert.deepEqual(invocation.answers[0].choice, { kind: "all" });
  assert.equal(root.querySelector("#dz-btn-download-all").disabled, true);
  const saved = { id: "saved:first", filename: "First.png" };
  const batch = {
    cancelled: false,
    items: [
      { id: 0, title: "First", state: { kind: "saved", result: { output, saved_output: saved } } },
      { id: 1, title: "Second", state: { kind: "failed", error: { kind: "no-image-found" } } },
    ],
  };
  act(() =>
    invocation.callbacks.batch({
      ...batch,
      items: [batch.items[0], { ...batch.items[1], state: { kind: "running" } }],
    }),
  );
  await act(() => invocation.answers[0].resolve());
  assert.equal(root.querySelector(".dz-image-picker"), null);
  assert.ok(root.querySelector(".dz-job-section"), "current tile progress remains visible");
  const progress = root.querySelector(".dz-batch-progress");
  assert.equal(progress.getAttribute("value"), "1");
  assert.equal(progress.getAttribute("max"), "2");
  assert.match(root.querySelector(".dz-batch-totals").textContent, /1 remaining/);
  await act(() => invocation.resolveBatch(batch));
  assert.equal(root.querySelectorAll(".dz-batch-item").length, 2);
  assert.equal(root.querySelector(".dz-job-section"), null);
  assert.equal(root.querySelector(".dz-batch-progress"), null);
  assert.match(root.textContent, /First.png/);
  assert.match(root.textContent, /No zoomable image was found/);
  const opened = [];
  native.openBatchOutput = async (...args) => opened.push(args);
  click(root.querySelector(".dz-batch-actions button"));
  await flush();
  assert.deepEqual(opened, [[saved, false]]);
});

test("cancelling before the first batch event preserves results and ignores retired events", async () => {
  const { root, start } = mountDesktop();
  const invocation = await start();
  let cancelled = 0;
  invocation.cancel = async () => {
    cancelled++;
  };
  const items = [
    {
      id: 0,
      title: "Saved",
      state: {
        kind: "saved",
        result: { output, saved_output: { id: "saved:one", filename: "Saved.png" } },
      },
    },
    { id: 1, title: "Pending", state: { kind: "pending" } },
  ];
  act(() =>
    invocation.callbacks.imageChoice(1, {
      kind: "catalog",
      catalog: {
        entries: [
          { kind: "image-request", uri: "https://images.test/one" },
          { kind: "image-request", uri: "https://images.test/two" },
        ],
      },
    }),
  );
  click(root.querySelector("#dz-btn-download-all"));
  await act(() => invocation.answers[0].resolve());
  click(root.querySelector("#dz-btn-cancel"));
  await flush();
  assert.equal(cancelled, 1);
  assert.equal(root.querySelector("#dz-url-input"), null, "cancel awaits the batch result");
  await act(() =>
    invocation.resolveBatch({
      cancelled: true,
      items: [items[0], { ...items[1], state: { kind: "cancelled" } }],
    }),
  );
  assert.match(root.textContent, /cancelled/i);
  assert.match(root.textContent, /Saved.png/);
  click(root.querySelector(".dz-batch-results .dz-actions-row button"));
  await flush();
  assert.ok(root.querySelector("#dz-url-input"));
  act(() => invocation.callbacks.batch({ items, cancelled: false }));
  assert.equal(root.querySelector(".dz-batch-results"), null);
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

test("quick settings persist and reach the native invocation", async () => {
  const { root, start } = mountDesktop();
  for (const [label, value] of [
    ["Format", "AVIF"],
    ["Size", "4K"],
    ["Network", "Aggressive"],
  ]) {
    const menu = root.querySelector(`.dz-quick-menu[aria-label="${label}"]`);
    click(
      [...menu.querySelectorAll("button")].find(
        (button) => button.firstElementChild.textContent === value,
      ),
    );
    await flush();
    assert.ok(root.querySelector(`summary[aria-label="${label}: ${value}"]`));
  }
  await flush();
  const invocation = await start();
  assert.deepEqual(invocation.request.settings, loadSettings());
  assert.equal(invocation.request.settings.output_format, "avif");
  assert.equal(invocation.request.settings.max_width, 3840);
  assert.equal(invocation.request.settings.max_height, 2160);
  assert.equal(invocation.request.settings.network_profile, "aggressive");
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

test("native local opening retains picker choices, protects active work, and retries the exact source", async () => {
  const { root, native, invocations, historyStore, reset } = mountDesktop();
  const source = { kind: "file", path: "/tmp/Art é/paintings #1.urls" };
  await act(async () => native.openSource(source));
  const invocation = invocations[0];
  assert.deepEqual(invocation.request.source, source);
  assert.equal(historyStore.has("dezoomify.desktop.history.v2"), false);
  act(() => native.openSource({ kind: "file", path: "/tmp/other.dzi" }));
  assert.equal(invocations.length, 1, "file opens cannot replace active work");
  act(() =>
    invocation.callbacks.imageChoice(1, {
      kind: "catalog",
      catalog: {
        entries: [
          { kind: "image-request", uri: "https://images.test/first.dzi" },
          { kind: "image-request", uri: "https://images.test/second.dzi" },
        ],
      },
    }),
  );
  assert.equal(root.querySelectorAll("[data-dz-image-index]").length, 2);
  click(root.querySelector("#dz-btn-download-all"));
  assert.deepEqual(invocation.answers[0].choice, { kind: "all" });
  await act(async () => invocation.answers[0].reject({ kind: "invoke-failed" }));
  act(() => native.openSource({ kind: "file", path: "/tmp/another.dzi" }));
  assert.equal(invocations.length, 1, "a local control failure does not settle native work");
  await act(async () =>
    invocation.reject({ kind: "network-failure", transport: "native", retryable: true }),
  );
  assert.ok(root.querySelector("#dz-job-diagnostics").textContent.includes(source.path));
  click(root.querySelector("#dz-btn-try-again"));
  await flush();
  assert.equal(invocations.length, 2);
  assert.deepEqual(invocations[1].request.source, source);
  const saved = { id: "saved:local", filename: "painting.png" };
  const forgotten = [];
  native.forgetSavedOutput = async (reference) => forgotten.push(reference);
  await act(async () => invocations[1].resolve(output, saved));
  await reset();
  assert.deepEqual(forgotten, [saved]);
  assert.equal(root.querySelectorAll(".dz-history-main").length, 0);
});

test("disposing while native file-open subscription is pending releases the late listener", async () => {
  const subscription = Promise.withResolvers();
  let receive;
  let stopped = 0;
  const { app, native, invocations } = mountDesktop({
    subscribeOpenSource(callback) {
      receive = callback;
      return subscription.promise;
    },
  });
  await act(() => app.dispose());
  await act(async () => subscription.resolve(() => stopped++));
  assert.equal(stopped, 1);
  act(() => receive({ kind: "file", path: "/tmp/late.dzi" }));
  act(() => native.openSource({ kind: "file", path: "/tmp/also-late.dzi" }));
  assert.equal(invocations.length, 0);
});
