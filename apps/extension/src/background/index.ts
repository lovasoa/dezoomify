/**
 * One-shot background: the toolbar action opens the extension page bound to
 * the clicked tab; install opens the page once (first-run guidance + tab
 * list). The scan, discovery, fetch, assembly, and save all live in the page
 * (page/page.ts): no scan state, observers, or timers exist here, so this
 * context going idle (service worker suspension / event-page unload) is
 * harmless by construction.
 *
 * MV3 dual background: Chromium runs this file as a service worker, Firefox
// as an MV3 event page. Classic script in both: shipped export-free.
 */

const api = globalThis.browser ?? globalThis.chrome;

api.action.onClicked.addListener((tab) => {
  api.tabs.create({ url: api.runtime.getURL("page/page.html?tab=" + tab.id) });
});

api.runtime.onInstalled.addListener(() => {
  api.tabs.create({ url: api.runtime.getURL("page/page.html") });
});
