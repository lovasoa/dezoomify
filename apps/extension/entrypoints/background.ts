import { browser } from "wxt/browser";
import { defineBackground } from "wxt/utils/define-background";
import { createBackgroundCoordinator } from "../src/background/coordinator.ts";

export default defineBackground({
  // Leaving `type` unset makes WXT emit one IIFE. Firefox MV3 therefore gets
  // a classic background.scripts entry while Chromium uses the same artifact
  // as its service worker.
  main() {
    const testing = import.meta.env.MODE === "testing";
    createBackgroundCoordinator({ browserApi: browser, testing }).startBackground();
    if (!testing) return;
    browser.runtime.onInstalled.addListener(() => {
      void browser.tabs.create({ url: browser.runtime.getURL("/test/driver.html") });
    });
  },
});
