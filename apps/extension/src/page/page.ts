/**
 * Extension page: the whole job lives here.
 *
 * Flow (v1): pick a tab -> finite reload scan (webRequest observed from this
 * page; the tab's origin is covered by the activeTab grant from the action
 * click, or by granted host permissions) -> pick a candidate source URL ->
 * run the wasm discovery core inline -> plan -> fetch tiles with the
 * browser session -> assemble on canvas -> save via a download anchor.
 *
 * Module document: imports the staged `scan.js`/`candidates.js` and the wasm
 * glue. Every failure is logged into the visible log (the E2E asserts on it).
 */

import { createScanner, isPrivilegedUrl } from "./scan.js";
import { recognizeFormatHint, validateCandidateUrl } from "./candidates.js";
import init, { DiscoverySession } from "../wasm/dezoomify-wasm.js";

const api = globalThis.browser ?? globalThis.chrome;

const log = (line) => {
  const el = document.getElementById("log");
  el.textContent += line + "\n";
  el.scrollTop = el.scrollHeight;
};

const fail = (code, detail) => {
  log("FAILED " + code + (detail ? ": " + detail : ""));
  if (detail && detail.stack) log(detail.stack);
  document.body.dataset.outcome = "failed";
};

function pickedUrlFor(tab) {
  // url is visible when activeTab covers the tab or host permissions grant it;
  // the scanner still enforces the privileged-URL guard when it is known.
  return typeof tab.url === "string" && tab.url ? tab.url : "http://unknown/";
}

async function runScan(tabId) {
  const store = { urls: [] };
  const tabs = await api.tabs.query({});
  const tab = tabs.find((t) => t.id === tabId);
  if (!tab) throw Object.assign(new Error("target tab vanished"), { code: "no-target-tab" });
  const url = pickedUrlFor(tab);
  if (isPrivilegedUrl(url)) {
    throw Object.assign(new Error("privileged URL: " + JSON.stringify(url)), { code: "privileged-url" });
  }

  const listener = { ref: null };
  const scanner = createScanner({
    queryActiveTab: async () => ({ id: tabId, url }),
    addWebRequestListener: (handler, id) => {
      listener.ref = (details) => {
        handler(details.tabId, details.url);
        if (
          details.tabId === id &&
          validateCandidateUrl(details.url).ok &&
          !store.urls.includes(details.url)
        ) {
          store.urls.push(details.url);
        }
      };
      api.webRequest.onBeforeRequest.addListener(listener.ref, {
        urls: ["<all_urls>"],
        tabId: id,
      });
    },
    removeWebRequestListener: () => {
      if (listener.ref) api.webRequest.onBeforeRequest.removeListener(listener.ref);
    },
    reloadTab: (id) => api.tabs.reload(id),
  });

  await scanner.startScan();
  while (scanner.getState() !== "stopped") {
    await new Promise((r) => setTimeout(r, 200));
  }
  const snap = scanner.getSnapshot();
  log("scan stopped: " + snap.stopReason + ", observed " + store.urls.length + " urls");
  return store.urls;
}

async function discover(sourceUrl) {
  await init();
  const session = new DiscoverySession(sourceUrl);
  for (;;) {
    const raw = session.nextNeed();
    if (!raw || raw === "null") break;
    const need = JSON.parse(raw);
    try {
      const res = await fetch(need.uri, { credentials: "include" });
      if (!res.ok) throw new Error("status " + res.status);
      const bytes = new Uint8Array(await res.arrayBuffer());
      session.provide(need.id, bytes, res.url || need.uri);
    } catch (e) {
      session.provideFailure(need.id, String(e));
    }
  }
  return { session, catalog: JSON.parse(session.finish()) };
}

async function planLevel(session, image) {
  // Largest declared level wins; undeclared sizes keep the last level
  // (same rule as the webapp job).
  let level = null;
  let bestArea = -1;
  for (const candidate of image.levels) {
    const size = candidate.imageSize;
    const area = size ? size.x * size.y : -1;
    if (area >= bestArea) {
      level = candidate;
      bestArea = area;
    }
  }
  let plan = JSON.parse(session.levelTiles(image.id, level.index));
  let guard = 0;
  while (plan.kind === "probe" && guard++ < 5) {
    const res = await fetch(plan.uri, { credentials: "include" });
    const bmp = await createImageBitmap(await res.blob());
    plan = JSON.parse(session.probeSubmit(image.id, level.index, bmp.width > 0, bmp.width, bmp.height));
  }
  return plan;
}

async function assemble(session, plan) {
  const canvas = document.createElement("canvas");
  canvas.width = plan.canvas.x;
  canvas.height = plan.canvas.y;
  const ctx = canvas.getContext("2d");
  let done = 0;
  for (const tile of plan.tiles) {
    const res = await fetch(tile.uri, { credentials: "include" });
    if (!res.ok) throw new Error("tile status " + res.status);
    let bytes = new Uint8Array(await res.arrayBuffer());
    if (tile.processing) bytes = session.applyProcessing(tile.processing, bytes);
    const bmp = await createImageBitmap(new Blob([bytes]));
    ctx.drawImage(bmp, tile.x, tile.y, tile.w ?? bmp.width, tile.h ?? bmp.height);
    const sample = ctx.getImageData(tile.x + 5, tile.y + 5, 1, 1).data;
    log("tile " + ++done + "/" + plan.tiles.length + " at " + tile.x + "," + tile.y + " bmp " + bmp.width + "px sample " + [...sample].join(","));
  }
  const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
  return blob;
}

function save(blob) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "dezoomify.png";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

async function run(tabId) {
  try {
    const urls = await runScan(tabId);
    const source = urls.find((u) => recognizeFormatHint(u) !== "unknown");
    if (!source) throw Object.assign(new Error("no zoomable candidate observed"), { code: "no-candidate" });
    log("source: " + source);

    const { session, catalog } = await discover(source);
    const image = catalog.images[0];
    if (!image) throw Object.assign(new Error("catalog has no image"), { code: "no-image" });
    log("image: " + (image.title || image.format));

    const plan = await planLevel(session, image);
    log("plan: " + plan.tiles.length + " tiles, canvas " + plan.canvas.x + "x" + plan.canvas.y);
    const blob = await assemble(session, plan);
    save(blob);
    log("saved dezoomify.png");
    document.body.dataset.outcome = "saved";
  } catch (e) {
    fail(e.code || "job-failed", e.message + "\n" + (e.stack || ""));
  }
}

function tabButton(tab) {
  const b = document.createElement("button");
  b.dataset.tabid = String(tab.id);
  const label = typeof tab.url === "string" && tab.url ? tab.url : "tab " + tab.id;
  b.textContent = "Scan " + label;
  b.addEventListener("click", () => {
    document.getElementById("tabs").replaceChildren();
    run(tab.id);
  });
  return b;
}

async function render() {
  const params = new URLSearchParams(location.search);
  const bound = params.get("tab");
  const tabsEl = document.getElementById("tabs");
  if (bound) {
    tabsEl.replaceChildren(tabButton({ id: Number(bound) }));
    return;
  }
  const tabs = await api.tabs.query({});
  tabsEl.replaceChildren(...tabs.filter((t) => t.id !== undefined).map(tabButton));
}

render();
// Keep the tab list live: tabs opened after the page loaded (including the
// first-run flow itself) must become scannable without a manual reload.
api.tabs.onCreated.addListener(render);
api.tabs.onRemoved.addListener(render);
