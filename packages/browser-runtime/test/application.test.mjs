import "../../../test/tsx-loader.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { act, click, makeContainer } from "../../../test/react-dom.mjs";

const { createBrowserApplication } = await import("../src/application.ts");

const output = {
  canvas: { width: 256, height: 256 },
  format: "png",

  disposition: "browser-save-ready",
};
const progress = {
  phase: "acquisition",
  completed: 2,
  total: 4,
  selected: { width: 256, height: 256 },
  maximum: { width: 256, height: 256 },
};
const tick = () => act(() => new Promise((resolve) => setImmediate(resolve)));
function harness(resetToIdle = true, fetchResource = async () => assert.fail("unexpected fetch")) {
  const calls = [],
    contexts = [],
    store = new Map(),
    root = makeContainer();
  let app;
  act(() => {
    app = createBrowserApplication({
      root,
      product: "website",
      resetToIdle,
      history: {
        key: "history",
        store: {
          getItem: (key) => store.get(key) ?? null,
          setItem: (key, value) => store.set(key, value),
          removeItem: (key) => store.delete(key),
        },
      },
      wasm: async () => ({
        applyProcessing: (_recipe, bytes) => bytes,
        dezoomify: (inputs, options, host) =>
          new Promise((resolve, reject) => calls.push({ inputs, options, host, resolve, reject })),
      }),
      capabilities(context) {
        contexts.push(context);
        return {
          inputs: async (url) => [{ url }],
          fetchResource,
          canvas: () => document.createElement("canvas"),
          save: () => "browser-save-ready",
          transport: () => "direct",
        };
      },
    });
  });
  return { app, calls, contexts, store, root };
}

test("a replacement invocation ignores late progress, output and history from its predecessor", async () => {
  const h = harness();
  act(() => {
    h.app.submit("https://first.test/image");
  });
  await tick();
  const old = h.calls[0];
  act(() => {
    h.app.submit("https://second.test/image");
  });
  await tick();
  assert.equal(h.contexts[0].signal.aborted, true);
  act(() => {
    old.host.report({ ...progress, completed: 999 });
    old.resolve(output);
  });
  await tick();
  assert.equal(h.app.currentUrl(), "https://second.test/image");
  assert.deepEqual(
    JSON.parse(h.store.get("history")).map((item) => item.status),
    ["started", "cancelled"],
  );
  act(() => {
    h.calls[1].host.report(progress);
    h.calls[1].resolve(output);
  });
  await tick();
  assert.equal(h.app.presentation().phase, "completed");
  assert.deepEqual(
    JSON.parse(h.store.get("history")).map((item) => item.url),
    ["https://second.test/image", "https://first.test/image"],
  );
  await act(() => h.app.dispose());
});

test("desktop handoff keeps the discovered source through completion and resets for a new job", async () => {
  const h = harness();
  act(() => h.app.submit("https://museum.test/page"));
  await tick();
  const discovered = "https://image.test/selected/info.json?signature=exact%2Bvalue";
  act(() => {
    h.calls[0].host.report({
      ...progress,
      source_url: discovered,
      maximum: { width: 512, height: 512 },
    });
    h.calls[0].resolve(output);
  });
  await tick();
  click(h.root.querySelector("#dz-btn-download-desktop"));
  assert.equal(document.querySelector('[role="dialog"] input').value, discovered);
  click(document.querySelector(".dz-modal-close"));
  act(() => h.app.submit("https://museum.test/next"));
  await tick();
  assert.equal(h.contexts[1].view.desktopSourceUrl, undefined);
  await act(() => h.app.dispose());
});

test("a replacement renders immediately and waits for prior resources before starting work", async () => {
  let release;
  const h = harness(
    true,
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  let first, second;
  act(() => {
    first = h.app.run("https://first.test/image");
  });
  await tick();
  const fetch = assert.rejects(
    h.calls[0].host.fetch(
      {
        uri: "https://first.test/metadata",
        headers: [],
        purpose: "metadata",
      },
      "forbidden",
    ),
    { kind: "cancelled" },
  );
  act(() => {
    second = h.app.run("https://second.test/image");
  });
  await tick();
  assert.equal(h.app.currentUrl(), "https://second.test/image");
  assert.equal(h.app.presentation().phase, "job");
  assert.equal(h.contexts[0].signal.aborted, true);
  assert.equal(h.calls.length, 1, "new work waits for the previous resource scope");
  release({ kind: "response", response: { bytes: new Uint8Array([1]) } });
  await fetch;
  await tick();
  assert.equal(h.calls.length, 2);
  act(() => {
    h.calls[0].resolve(output);
    h.calls[1].resolve(output);
  });
  await act(() => Promise.all([first, second]));
  assert.equal(h.app.presentation().phase, "completed");
  await act(() => h.app.dispose());
});

test("cancel removes a pending permission prompt", async () => {
  const h = harness();
  act(() => {
    h.app.submit("https://one.test/image");
  });
  await tick();
  act(() =>
    h.contexts[0].permission([{ origin: "https://tiles.test", requesting: false, request() {} }]),
  );
  assert.ok(h.root.querySelector("[data-dz-allow-access]"));
  act(() => h.app.cancel());
  assert.equal(h.app.presentation().phase, "idle");
  assert.equal(h.root.querySelector("[data-dz-allow-access]"), null);
  act(() => h.calls[0].resolve(output));
  await tick();
  assert.equal(h.calls.length, 1);
  assert.equal(JSON.parse(h.store.get("history"))[0].status, "cancelled");
  await act(() => h.app.dispose());
});

test("cancel remains visible when its invocation resolves output late", async () => {
  const h = harness(false);
  let run;
  act(() => {
    run = h.app.run("https://one.test/image");
  });
  await tick();
  act(() => h.app.cancel());
  assert.equal(h.app.presentation().phase, "cancelled");
  act(() => h.calls[0].resolve(output));
  await act(() => run);
  assert.equal(h.app.presentation().phase, "cancelled");
  assert.equal(JSON.parse(h.store.get("history"))[0].status, "cancelled");
  await act(() => h.app.dispose());
});

test("retry approval pauses the job, resumes acquisition, and disappears on completion", async () => {
  const h = harness();
  let run;
  act(() => {
    run = h.app.run("https://one.test/image");
  });
  await tick();
  const call = h.calls[0];
  let painted = 0;
  call.host.paintTile = async () => {
    painted++;
  };
  let acquiring;
  act(() => {
    call.host.report(progress);
    acquiring = call.host.acquireTile({
      tile: {},
      attempt: 4,
      requires_approval: true,
      previous_failure: { kind: "timeout", transport: "direct" },
    });
  });
  await tick();
  const retry = h.root.querySelector('[data-dz-retry-choice="retry"]');
  assert.ok(retry);
  assert.equal(painted, 0);
  assert.equal(call.host.retryWaiting, true);
  assert.equal(h.root.querySelector('[role="progressbar"]'), null);
  click(retry);
  await acquiring;
  assert.equal(painted, 1);
  assert.equal(call.host.retryWaiting, false);
  act(() => call.resolve(output));
  await act(() => run);
  assert.equal(h.root.querySelector("[data-dz-retry-actions]"), null);
  assert.deepEqual(h.app.presentation().output, output);
  assert.equal(JSON.parse(h.store.get("history"))[0].status, "completed");
  await act(() => h.app.dispose());
});

test("website persists a started URL and metadata before failure, then allows prefill and removal", async () => {
  const h = harness();
  act(() => h.app.submit("https://museum.test/image"));
  assert.equal(JSON.parse(h.store.get("history"))[0].status, "started");
  await tick();
  act(() => h.calls[0].host.report({ ...progress, title: "A painting" }));
  const enriched = JSON.parse(h.store.get("history"))[0];
  assert.equal(enriched.title, "A painting");
  assert.equal(enriched.width, 256);
  act(() => h.calls[0].reject({ kind: "unknown-format" }));
  await tick();
  assert.equal(JSON.parse(h.store.get("history"))[0].status, "failed");
  act(() => h.app.cancel());
  click(h.root.querySelector(".dz-history-main"));
  assert.equal(h.root.querySelector("#dz-url-input").value, "https://museum.test/image");
  assert.equal(h.calls.length, 1);
  click(h.root.querySelector(".dz-history-remove"));
  assert.deepEqual(JSON.parse(h.store.get("history")), []);
  assert.equal(h.root.querySelector("tbody tr"), null);
  await act(() => h.app.dispose());
});
