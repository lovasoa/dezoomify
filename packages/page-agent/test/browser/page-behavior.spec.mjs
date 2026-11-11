import assert from "node:assert/strict";
import { test } from "../../../../test/browser/fixtures.mjs";
import {
  createSeadragonViewer,
  seadragonLibrary,
  seadragonVersions,
} from "../../../../test/browser/seadragon-fixture.mjs";

const runtime = seadragonVersions.at(-1);
const html = '<!doctype html><div id="viewer" style="width:800px;height:600px"></div>';

test.beforeEach(async ({ page }) => {
  await page.route("https://viewer.fixture.test/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: route.request().isNavigationRequest() ? "<!doctype html><body></body>" : "",
    }),
  );
  await page.goto("https://viewer.fixture.test/page");
});

async function mount(scope, mode = "closure") {
  await scope.evaluate((html) => {
    document.body.innerHTML = html;
  }, html);
  await scope.addScriptTag({ content: seadragonLibrary(runtime) });
  await scope.evaluate(createSeadragonViewer, { runtime, mode });
}

for (const kind of ["srcdoc", "blob", "http"]) {
  test(`discovers a viewer in a ${kind} frame within its granted document`, async ({
    page,
    loadModule,
  }) => {
    await page.evaluate(
      ({ kind, html }) => {
        const frame = document.createElement("iframe");
        if (kind === "srcdoc") frame.srcdoc = html;
        else if (kind === "blob")
          frame.src = URL.createObjectURL(new Blob([html], { type: "text/html" }));
        else frame.src = "https://viewer.fixture.test/frame";
        document.body.append(frame);
      },
      { kind, html },
    );
    await page.waitForFunction(() => document.querySelector("iframe").contentDocument?.body);
    const frame = page.frames()[1];
    await mount(frame);
    await loadModule(page);
    const inputs = await page.evaluate(async () => (await ViewerScanner.scanViewers()).inputs);
    if (kind === "http") {
      assert.deepEqual(inputs, [], "HTTP frames require their own explicit scan");
      await loadModule(frame);
      assert.equal(
        await frame.evaluate(async () => (await ViewerScanner.scanViewers()).inputs.length),
        1,
      );
    } else assert.equal(inputs.length, 1);
  });
}

test("a large page stays responsive and preserves its viewer during discovery", async ({
  page,
  loadModule,
}) => {
  await mount(page, "global");
  await page.evaluate(() => {
    const fragment = document.createDocumentFragment();
    for (let i = 0; i < 6000; i++) fragment.append(document.createElement("i"));
    document.body.append(fragment);
    window.getterSideEffects = 0;
    Object.defineProperty(window, "unrelatedGetter", {
      get() {
        window.getterSideEffects++;
        throw new Error("unrelated page code");
      },
    });
    window.unrelatedProxy = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("unrelated page proxy");
        },
      },
    );
  });
  await loadModule(page);
  const result = await page.evaluate(async () => {
    let pageTaskRan = false;
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      pageTaskRan = true;
      channel.port1.close();
      channel.port2.close();
    };
    channel.port2.postMessage(null);
    const scan = await ViewerScanner.scanViewers();
    const unchanged = viewportUnchanged();
    const viewport = window.libraryViewer.viewport;
    const before = viewport.getZoom();
    viewport.zoomTo(before * 1.5, undefined, true);
    return {
      found: scan.inputs.length,
      pageTaskRan,
      unchanged,
      getterSideEffects: window.getterSideEffects,
      zoomStillWorks: viewport.getZoom() > before,
    };
  });
  assert.deepEqual(result, {
    found: 1,
    pageTaskRan: true,
    unchanged: true,
    getterSideEffects: 0,
    zoomStillWorks: true,
  });
});
