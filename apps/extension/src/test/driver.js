// Test-package-only toolbar driver. It runs inside the extension so browser
// harnesses never need privileged-page script injection (forbidden by
// Firefox). A successful saved PNG is the only completion signal.
globalThis.__DEZOOMIFY_TEST_RUN__ = (async () => {
  const api = globalThis.browser ?? globalThis.chrome;
  const origin = globalThis.__DEZOOMIFY_TEST_ORIGIN__;
  const scenario = globalThis.__DEZOOMIFY_TEST_SCENARIO__;
  const restartBackground = globalThis.__DEZOOMIFY_TEST_RESTART_BACKGROUND__ === true;
  if (!api?.tabs?.create || typeof origin !== "string" || typeof scenario !== "string") {
    throw new Error("extension E2E driver is not configured");
  }
  let signalCompleted;
  const jobCompleted = new Promise((resolve) => {
    signalCompleted = resolve;
  });
  api.runtime.onMessage.addListener((message) => {
    if (message?.type === "dezoomify-test-job-complete") signalCompleted();
  });

  const targetUrl =
    scenario === ""
      ? `${origin}/target.html`
      : `${origin}/target.html?scenario=${encodeURIComponent(scenario)}`;
  const target = await api.tabs.create({ url: targetUrl, active: true });
  if (typeof target?.id !== "number") throw new Error("extension E2E source tab did not open");

  let loaded = target.status === "complete";
  for (let attempt = 0; attempt < 100 && !loaded; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    loaded = (await api.tabs.get(target.id))?.status === "complete";
  }
  if (!loaded) throw new Error("extension E2E source fixture did not load");
  // The page load event does not wait for its simulated viewer fetch. The
  // loopback response is immediate; this bounded grace period lets its
  // resource-timing entry settle before the finite snapshot.
  await new Promise((resolve) => setTimeout(resolve, 250));

  const started = await api.runtime.sendMessage({
    type: "dezoomify-test-start-job",
    tabId: target.id,
    url: targetUrl,
  });
  if (!started?.ok) throw new Error(`extension E2E job did not start: ${JSON.stringify(started)}`);

  // Ask the job page itself to exercise its direct source access. The source
  // tab grants the cookie session; no background proxy participates here.
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const result = await api.runtime.sendMessage({
        type: "dezoomify-test-source-access",
        scenario,
      });
      if (result?.ok) {
        globalThis.__DEZOOMIFY_TEST_SOURCE_ACCESS_RESULT__ = result;
        break;
      }
      if (result?.ok === false) throw new Error(result.error || "direct source access failed");
    } catch (error) {
      if (attempt === 99) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!globalThis.__DEZOOMIFY_TEST_SOURCE_ACCESS_RESULT__) {
    throw new Error("job page did not answer the direct source-access proof");
  }
  globalThis.__DEZOOMIFY_TEST_AFTER_JOB__ = (async () => {
    await Promise.race([
      jobCompleted,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("job did not complete")), 90000),
      ),
    ]);
    if (restartBackground) {
      await new Promise((resolve) => {
        globalThis.__DEZOOMIFY_TEST_RELEASE__ = resolve;
      });
    }

    // Verify that navigation invalidates the source binding while the job
    // page stays open.
    const navigatedUrl = `${origin}/target.html?after-navigation=1`;
    await api.tabs.update(target.id, { url: navigatedUrl });
    let sourceLoaded = false;
    for (let attempt = 0; attempt < 100 && !sourceLoaded; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const current = await api.tabs.get(target.id);
      sourceLoaded = current?.status === "complete" && current.url === navigatedUrl;
    }
    if (!sourceLoaded) throw new Error("source tab did not finish the navigation proof");
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        const result = await api.runtime.sendMessage({ type: "dezoomify-test-source-navigation" });
        if (result?.code === "source-document-lost") return true;
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
  return globalThis.__DEZOOMIFY_TEST_SOURCE_ACCESS_RESULT__;
})();
