import { startBackground } from "../src/background/index.js";

declare const __DEZOOMIFY_TEST_DRIVER__: boolean;
type TestApi = {
  runtime?: { getURL?(path: string): string; onInstalled?: { addListener(listener: () => void): void } };
  tabs?: { create?(details: { url: string }): Promise<unknown> };
};

export default {
  // Leaving `type` unset makes WXT emit one IIFE. Firefox MV3 therefore gets
  // a classic background.scripts entry while Chromium uses the same artifact
  // as its service worker.
  main() {
    startBackground();
    if (!__DEZOOMIFY_TEST_DRIVER__) return;
    const globals = globalThis as typeof globalThis & { browser?: TestApi; chrome?: TestApi; __DEZOOMIFY_TEST__?: boolean };
    const api = globals.browser ?? globals.chrome;
    globals.__DEZOOMIFY_TEST__ = true;
    api?.runtime?.onInstalled?.addListener(() => {
      const url = api.runtime?.getURL?.("test/driver.html");
      if (url) void api.tabs?.create?.({ url });
    });
  },
};
