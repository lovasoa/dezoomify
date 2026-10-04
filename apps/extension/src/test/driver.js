// Test-package-only toolbar driver. It runs inside the extension so browser
// harnesses never need privileged-page script injection (forbidden by
// Firefox). A successful saved PNG is the only completion signal.
globalThis.__DEZOOMIFY_TEST_RUN__ = (async () => {
  const api = globalThis.browser ?? globalThis.chrome;
  function waitForTab(tabId, url) {
    return new Promise((resolve, reject) => {
      const finish = (error) => {
        clearTimeout(timer);
        api.tabs.onUpdated.removeListener(updated);
        if (error) reject(error);
        else resolve();
      };
      const check = (tab) => {
        if (tab.status === "complete" && tab.url === url) finish();
      };
      const updated = (id, _change, tab) => {
        if (id === tabId) check(tab);
      };
      const timer = setTimeout(() => finish(new Error("source tab did not finish loading")), 10000);
      api.tabs.onUpdated.addListener(updated);
      void api.tabs.get(tabId).then(check, finish);
    });
  }
  const origin = globalThis.__DEZOOMIFY_TEST_ORIGIN__;
  const scenario =
    new URLSearchParams(location.search).get("scenario") ?? globalThis.__DEZOOMIFY_TEST_SCENARIO__;
  if (scenario === "idle") return;
  const restartBackground = globalThis.__DEZOOMIFY_TEST_RESTART_BACKGROUND__ === true;
  if (!api?.tabs?.create || typeof origin !== "string" || typeof scenario !== "string") {
    throw new Error("extension E2E driver is not configured");
  }
  let signalCompleted;
  const jobCompleted = new Promise((resolve) => {
    signalCompleted = resolve;
  });
  let signalSourceReady;
  const sourceReady = new Promise((resolve) => {
    signalSourceReady = resolve;
  });
  api.runtime.onMessage.addListener((message) => {
    if (message?.type === "dezoomify-test-job-complete") signalCompleted();
    if (message?.type === "dezoomify-test-source-ready" && message.sourceTabId === target.id)
      signalSourceReady();
  });

  const targetUrl = scenario.startsWith("fixtures/")
    ? `${origin}/${scenario}/viewer.html`
    : scenario === "observed-zoomify"
      ? `${origin}/observed-zoomify/viewer.html`
      : scenario === ""
        ? `${origin}/target.html`
        : `${origin}/target.html?scenario=${encodeURIComponent(scenario)}`;
  const target = await api.tabs.create({ url: targetUrl, active: true });
  if (typeof target?.id !== "number") throw new Error("extension E2E source tab did not open");

  await waitForTab(target.id, targetUrl);
  // A completed page load does not imply its viewer's metadata fetch has
  // settled. Wait for the fixture's explicit signal before the finite scan.
  const results = await api.scripting.executeScript({
    target: { tabId: target.id, frameIds: [0] },
    func: () => {
      if (document.documentElement.dataset.viewerReady === "true") return true;
      return new Promise((resolve) => {
        const finish = (ready) => {
          observer.disconnect();
          clearTimeout(timer);
          resolve(ready);
        };
        const observer = new MutationObserver(() => {
          if (document.documentElement.dataset.viewerReady === "true") finish(true);
        });
        const timer = setTimeout(() => finish(false), 10000);
        observer.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ["data-viewer-ready"],
        });
      });
    },
  });
  const viewerReady = results.some((result) => result.result === true);
  if (!viewerReady) throw new Error("extension E2E viewer did not finish its metadata fetch");

  const started = await api.runtime.sendMessage({
    type: "dezoomify-test-start-job",
    tabId: target.id,
    url: targetUrl,
  });
  if (!started?.ok) throw new Error(`extension E2E job did not start: ${JSON.stringify(started)}`);

  // Ask the job page itself to exercise its direct source access. The source
  // tab grants the cookie session; no background proxy participates here.
  // Dedicated flow cases cover this host behavior. The format matrix checks
  // its real algorithm save without repeating a second scan and fetch.
  if (!scenario.startsWith("fixtures/")) {
    let readyTimer;
    try {
      await Promise.race([
        sourceReady,
        new Promise((_, reject) => {
          readyTimer = setTimeout(
            () => reject(new Error("job page source access was not ready")),
            10000,
          );
        }),
      ]);
    } finally {
      clearTimeout(readyTimer);
    }
    const result = await api.runtime.sendMessage({
      type: "dezoomify-test-source-access",
      scenario,
    });
    if (!result?.ok) throw new Error(result?.error || "direct source access failed");
    globalThis.__DEZOOMIFY_TEST_SOURCE_ACCESS_RESULT__ = result;
  }
  globalThis.__DEZOOMIFY_TEST_AFTER_JOB__ = (async () => {
    await Promise.race([
      jobCompleted,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("job did not complete")), 90000),
      ),
    ]);
    if (scenario.startsWith("fixtures/")) return true;
    if (restartBackground) {
      await new Promise((resolve) => {
        globalThis.__DEZOOMIFY_TEST_RELEASE__ = resolve;
      });
    }

    // Verify that navigation invalidates the source binding while the job
    // page stays open.
    const navigatedUrl = `${origin}/target.html?after-navigation=1`;
    await api.tabs.update(target.id, { url: navigatedUrl });
    await waitForTab(target.id, navigatedUrl);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        const result = await api.runtime.sendMessage({ type: "dezoomify-test-source-navigation" });
        if (result?.blocked_reason === "source-document-lost") return true;
        if (result?.code === "source-access-stayed-live") {
          throw new Error("source access remained live after source navigation");
        }
      } catch (error) {
        if (error instanceof Error && error.message.includes("remained live")) throw error;
        if (attempt === 99) throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("job page did not reject access after source navigation");
  })();
  void globalThis.__DEZOOMIFY_TEST_AFTER_JOB__.then(
    () => {
      document.body.dataset.afterJob = "ready";
    },
    (error) => {
      document.body.dataset.afterJob = "failed";
      document.body.append(`Navigation proof failed: ${String(error?.stack ?? error)}`);
    },
  );
  return globalThis.__DEZOOMIFY_TEST_SOURCE_ACCESS_RESULT__;
})();

void globalThis.__DEZOOMIFY_TEST_RUN__.then(
  () => {
    document.body.dataset.driver = "ready";
  },
  (error) => {
    document.body.dataset.driver = "failed";
    document.body.append(
      `Driver failed: ${String(error?.message ?? error)}\n${String(error?.stack ?? "")}`,
    );
  },
);
