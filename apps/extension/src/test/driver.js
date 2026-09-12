// Test-package-only toolbar driver. It runs inside the extension so browser
// harnesses never need privileged-page script injection (forbidden by
// Firefox). A successful saved PNG is the only completion signal.
globalThis.__DEZOOMIFY_TEST_RUN__ = (async () => {
  const api = globalThis.browser ?? globalThis.chrome;
  const origin = globalThis.__DEZOOMIFY_TEST_ORIGIN__;
  const source = globalThis.__DEZOOMIFY_TEST_SOURCE__;
  if (!api?.tabs?.create || typeof origin !== "string" || typeof source !== "string") {
    throw new Error("extension E2E driver is not configured");
  }

  const targetUrl = `${origin}/target.html?source=${encodeURIComponent(source)}`;
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
    requestId: "e2e-start",
    tabId: target.id,
    url: targetUrl,
  });
  if (!started?.ok) throw new Error(`extension E2E job did not start: ${JSON.stringify(started)}`);
})();
