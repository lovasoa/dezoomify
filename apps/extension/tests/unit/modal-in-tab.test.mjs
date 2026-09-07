import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// In-tab modal gates: the injected `content/modal.js` factory (monitoring
// card + Shadow-DOM/iframe job phase, lifecycle, handshake), the
// background<->loader protocol parity (`dezoomify-*` runtime messages,
// `dz-modal-*` iframe handshake), and the job iframe
// (`modal/modal.html` + `modal/modal.js`) reuse rules (shared-ui geometry,
// tab-origin fetch, tainted-canvas discipline, blob-anchor save, native
// handoff, no metadata proxy).

async function loadSrc(rel) {
  const src = readFileSync(new URL(rel, import.meta.url), "utf8");
  return import(`data:text/javascript;charset=utf-8,${encodeURIComponent(src)}`);
}

const modalSrc = await loadSrc("../../src/content/modal.js");

function readSrc(rel) {
  return readFileSync(new URL(rel, import.meta.url), "utf8");
}

function codeLines(source) {
  return source
    .split("\n")
    .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
    .join("\n");
}

// --- minimal fake DOM -----------------------------------------------------

function createFakeElement(tag, doc) {
  const listeners = new Map();
  const children = [];
  const el = {
    tagName: String(tag).toUpperCase(),
    ownerDocument: doc,
    style: {},
    dataset: {},
    title: "",
    parentNode: null,
    children,
    _id: "",
    _text: "",
    _class: "",
    src: "",
    get id() { return el._id; },
    set id(v) { el._id = String(v ?? ""); },
    get className() { return el._class; },
    set className(v) { el._class = String(v ?? ""); },
    get textContent() { return el._text + children.map((c) => c.textContent).join(""); },
    set textContent(v) { children.length = 0; el._text = String(v ?? ""); },
    setAttribute(name, value) {
      if (String(name).toLowerCase() === "id") el.id = String(value);
      if (String(name).toLowerCase() === "class") el.className = String(value);
      if (String(name).toLowerCase() === "src") el.src = String(value);
    },
    getAttribute(name) {
      if (String(name).toLowerCase() === "src") return el.src;
      return null;
    },
    appendChild(child) {
      if (child.parentNode) child.parentNode.removeChild(child);
      child.parentNode = el;
      children.push(child);
      return child;
    },
    append(...kids) { for (const k of kids) el.appendChild(k); },
    removeChild(child) {
      const i = children.indexOf(child);
      if (i !== -1) { children.splice(i, 1); child.parentNode = null; }
      return child;
    },
    remove() { if (el.parentNode) el.parentNode.removeChild(el); },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    fire(type, event) { for (const fn of [...(listeners.get(type) ?? [])]) fn(event); },
    querySelectorAll(selector) {
      const out = [];
      const walk = (node) => {
        for (const c of node.children) {
          if (selector === "button" && c.tagName === "BUTTON") out.push(c);
          walk(c);
        }
      };
      walk(el);
      return out;
    },
    contains(node) {
      let at = node;
      while (at) { if (at === el) return true; at = at.parentNode; }
      return false;
    },
    focus() { doc.activeElement = el; },
    attachShadow() {
      const root = { children: [], appendChild(c) { root.children.push(c); return c; } };
      el.shadowRoot = root;
      return root;
    },
  };
  return el;
}

function createFakeDom() {
  const listeners = new Map();
  const doc = {
    activeElement: null,
    documentElement: null,
    createElement(tag) { return createFakeElement(tag, doc); },
    getElementById() { return null; },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    fire(type, event) { for (const fn of [...(listeners.get(type) ?? [])]) fn(event); },
  };
  doc.documentElement = createFakeElement("html", doc);
  const winListeners = new Map();
  const win = {
    addEventListener(type, fn) {
      if (!winListeners.has(type)) winListeners.set(type, new Set());
      winListeners.get(type).add(fn);
    },
    removeEventListener(type, fn) { winListeners.get(type)?.delete(fn); },
    fire(type, event) { for (const fn of [...(winListeners.get(type) ?? [])]) fn(event); },
  };
  return { doc, win };
}

function createFakeChrome() {
  const sent = [];
  return {
    sent,
    runtime: {
      getURL: (p) => `chrome-extension://test-id/${p}`,
      sendMessage: (msg) => { sent.push(msg); return Promise.resolve({}); },
      onMessage: { addListener() {}, removeListener() {} },
    },
  };
}

function mountModal({ resources = [] } = {}) {
  const { doc, win } = createFakeDom();
  const chromeApi = createFakeChrome();
  const timers = [];
  const modal = modalSrc.createInTabModal({
    document: doc,
    window: win,
    chromeApi,
    performance: { getEntriesByType: () => resources },
    PerformanceObserver: function () { return { observe() {}, disconnect() {} }; },
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout: () => {},
  });
  assert.equal(modal.mount(), true);
  assert.equal(modal.mount(), false, "re-mount is a no-op (single modal)");
  return { doc, win, chromeApi, timers, modal };
}

function findByTag(nodes, tag) {
  for (const node of nodes ?? []) {
    if (node.tagName === tag) return node;
    const found = findByTag(node.children, tag);
    if (found) return found;
  }
  return null;
}

// --- candidate rules --------------------------------------------------------

test("in-tab candidate URLs are http/https only and bounded", () => {
  assert.equal(modalSrc.isInTabCandidateUrl("https://site.example/iiif/info.json"), true);
  assert.equal(modalSrc.isInTabCandidateUrl("http://site.example/tile.jpg"), true);
  assert.equal(modalSrc.isInTabCandidateUrl("chrome://settings"), false);
  assert.equal(modalSrc.isInTabCandidateUrl("file:///etc/passwd"), false);
  assert.equal(modalSrc.isInTabCandidateUrl("data:image/png;base64,xx"), false);
  assert.equal(modalSrc.isInTabCandidateUrl(""), false);
  assert.equal(modalSrc.isInTabCandidateUrl("https://x.example/" + "a".repeat(2048)), false);
});

test("resource sweep dedupes first-seen and caps", () => {
  const urls = modalSrc.collectInTabUrls([
    { name: "https://a.example/1.jpg" },
    "https://a.example/1.jpg",
    { name: "https://a.example/2.jpg" },
    { name: "ftp://a.example/3.jpg" },
  ]);
  assert.deepEqual(urls, ["https://a.example/1.jpg", "https://a.example/2.jpg"]);
  const many = Array.from({ length: 150 }, (_, i) => `https://a.example/${i}.jpg`);
  assert.equal(modalSrc.collectInTabUrls(many).length, modalSrc.MAX_CANDIDATES);
});

// --- monitoring phase ---------------------------------------------------------

test("monitoring card mounts once with status and stop action", () => {
  const { doc, modal } = mountModal();
  assert.equal(modal.mounted, true);
  assert.equal(modal.jobPhase, false);
  const host = doc.documentElement.children.find((c) => c.id === "dezoomify-in-tab");
  assert.ok(host, "status host mounted in tab document");
  assert.ok(host.textContent.includes("Monitoring this tab"), "status copy mounted");
  assert.ok(findByTag([host], "BUTTON"), "stop action mounted");
});

test("monitor updates refresh the status line; background stop detaches", () => {
  const { doc, modal } = mountModal();
  modal.onMessage({ type: "dezoomify-monitor-update", seen: 3 });
  const host = doc.documentElement.children.find((c) => c.id === "dezoomify-in-tab");
  assert.ok(host && host.textContent.includes("3"), "seen count reflected in the status line");
  assert.equal(modal.mounted, true);
  modal.onMessage({ type: "dezoomify-stop-monitor" });
  assert.equal(modal.mounted, false, "background stop detaches");
});

test("Escape detaches and notifies the background for grey restore", () => {
  const { modal, chromeApi } = mountModal();
  modal.cleanup("escape");
  assert.equal(modal.mounted, false);
  assert.ok(
    chromeApi.sent.some((m) => m.type === "dezoomify-modal-closed"),
    "background notified to dispose the collector and restore grey",
  );
});

// --- job phase ------------------------------------------------------------------

function mountJob({ snapshotUrls = ["https://site.example/iiif/info.json"] } = {}) {
  const ctx = mountModal({ resources: [{ name: "https://site.example/tile/0.jpg" }] });
  // Hidden probe mounts alongside the status card on mount (no detection yet).
  const probeHost = ctx.doc.documentElement.children.find((c) => c.id === "dezoomify-modal-host");
  assert.ok(probeHost, "hidden probe host mounted alongside status card");
  assert.equal(ctx.modal.jobPhase, false, "no job UI before byte confirmation");
  assert.ok(ctx.doc.documentElement.children.some((c) => c.id === "dezoomify-in-tab"), "status card stays during monitoring");
  // Legacy snapshot is candidates-only, never detection from URL text.
  ctx.modal.onMessage({ type: "dezoomify-detected", urls: snapshotUrls });
  assert.equal(ctx.modal.jobPhase, false, "URL text alone is never detection");
  assert.ok(ctx.doc.documentElement.children.some((c) => c.id === "dezoomify-in-tab"), "status card stays until byte confirmation");
  // Tab-side byte confirmation reveals the job UI and stops collection.
  const probeFrame = findByTag(probeHost.shadowRoot.children, "IFRAME");
  assert.ok(probeFrame, "probe iframe mounted hidden");
  const probeToken = decodeURIComponent(probeFrame.src.split("#token=")[1]);
  ctx.win.fire("message", { data: { token: probeToken, kind: "dz-byte-confirmed" }, source: null, origin: "https://site.example" });
  assert.equal(ctx.modal.jobPhase, true);
  assert.ok(ctx.chromeApi.sent.some((m) => m.type === "dezoomify-byte-confirmed"), "background collection stopped on byte confirmation");
  const host = ctx.doc.documentElement.children.find((c) => c.id === "dezoomify-modal-host");
  assert.ok(host, "shadow job host mounted");
  assert.ok(!ctx.doc.documentElement.children.some((c) => c.id === "dezoomify-in-tab"), "status card replaced after byte confirmation");
  const frame = findByTag(host.shadowRoot.children, "IFRAME");
  assert.ok(frame, "job iframe mounted in shadow");
  assert.ok(frame.src.includes("modal/modal.html"), "iframe loads the extension job document");
  const token = decodeURIComponent(frame.src.split("#token=")[1]);
  assert.ok(token.length >= 8, "handshake token in frame URL");
  return { ...ctx, frame, token };
}

test("byte confirmation swaps the status card for the shadow job iframe", () => {
  mountJob();
});

test("frame handshake hands over merged candidates, wrong tokens ignored", () => {
  const { win, frame, token, modal } = mountJob();
  const posted = [];
  frame.contentWindow = { postMessage: (msg) => posted.push(msg) };
  const source = { postMessage: (msg) => posted.push({ via: "source", ...msg }) };
  win.fire("message", { data: { token: "wrong", kind: "dz-modal-ready" }, source, origin: "https://site.example" });
  assert.equal(posted.length, 0, "wrong token ignored");
  win.fire("message", { data: { token, kind: "dz-modal-ready" }, source, origin: "https://site.example" });
  const offered = posted.find((m) => m.kind === "dz-modal-candidates");
  assert.ok(offered, "candidates offered after handshake");
  assert.ok(offered.urls.includes("https://site.example/iiif/info.json"), "background snapshot merged");
  assert.ok(offered.urls.includes("https://site.example/tile/0.jpg"), "in-tab timeline merged");
  assert.equal(modal.snapshotCandidates().length, offered.urls.length);
});

test("frame close and backdrop click detach and notify the background", () => {
  const first = mountJob();
  first.win.fire("message", { data: { token: first.token, kind: "dz-modal-close" }, source: null });
  assert.equal(first.modal.mounted, false, "frame close detaches");
  assert.ok(first.chromeApi.sent.some((m) => m.type === "dezoomify-modal-closed"), "grey restore notified");

  const second = mountJob();
  const host = second.doc.documentElement.children.find((c) => c.id === "dezoomify-modal-host");
  const backdrop = findByTag(host.shadowRoot.children, "DIV");
  assert.ok(backdrop, "backdrop mounted");
  backdrop.fire("click", { target: backdrop });
  assert.equal(second.modal.mounted, false, "backdrop click detaches");
  assert.ok(second.chromeApi.sent.some((m) => m.type === "dezoomify-modal-closed"), "grey restore notified");
});

test("blocked iframe falls back to the bound page", () => {
  const { timers, modal, chromeApi } = mountJob();
  assert.equal(timers.length, 1, "ready timeout armed");
  timers[0]();
  assert.equal(modal.mounted, false, "blocked frame detaches");
  assert.ok(chromeApi.sent.some((m) => m.type === "dezoomify-open-panel"), "bound-page fallback requested");
  assert.deepEqual(modal.snapshotCandidates(), [], "detach clears candidates");
});

// --- background <-> loader protocol parity ---------------------------------------

test("background and loader speak the same lifecycle protocol", () => {
  const loader = codeLines(readSrc("../../src/content/modal.js"));
  const background = codeLines(readSrc("../../src/background/index.ts"));
  for (const kind of ["dezoomify-monitor-update", "dezoomify-byte-confirmed", "dezoomify-modal-closed", "dezoomify-open-panel"]) {
    assert.ok(loader.includes(kind), `loader must speak ${kind}`);
    assert.ok(background.includes(kind), `background must speak ${kind}`);
  }
  // Legacy snapshot stays candidates-only in the loader; the background never
  // declares detection from URL text (byte confirmation is tab-side).
  assert.ok(loader.includes("dezoomify-detected"), "loader keeps legacy snapshot as candidates-only");
  assert.ok(!background.includes("dezoomify-detected"), "background never declares detection from URL text");
  assert.ok(background.includes("content/modal.js"), "background injects the reviewed loader entry");
  assert.ok(background.includes("content/modal.css"), "background injects the reviewed host CSS");
  assert.ok(background.includes("executeScript") && background.includes("insertCSS"), "injection uses scripting on the clicked tab");
});

test("loader and job iframe speak the same handshake protocol", () => {
  const loader = codeLines(readSrc("../../src/content/modal.js"));
  const iframe = codeLines(readSrc("../../src/modal/modal.ts"));
  for (const kind of ["dz-modal-ready", "dz-modal-candidates", "dz-modal-close", "dz-byte-confirmed"]) {
    assert.ok(loader.includes(kind), `loader must speak ${kind}`);
    assert.ok(iframe.includes(kind), `job iframe must speak ${kind}`);
  }
});

// --- modal/modal.ts + modal.html reuse rules (text parity, like page.ts) ---

test("job iframe reuses shared-ui renderView geometry (no visual fork)", () => {
  const html = readSrc("../../src/modal/modal.html");
  assert.ok(html.includes('<link rel="stylesheet" href="../page/vendor/theme.css" />'), "iframe links the canonical theme");
  const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n");
  assert.ok(!styles.includes(".dz-"), "iframe shell defines no dz-* geometry (theme owns it)");
  const modal = readSrc("../../src/modal/modal.ts");
  assert.ok(modal.includes("renderView"), "iframe drives shared-ui renderView");
  assert.ok(modal.includes("../page/vendor/view.js"), "iframe imports the vendored view");
  const theme = readSrc("../../src/page/vendor/theme.css");
  const classes = new Set();
  for (const m of modal.matchAll(/className\s*=\s*"([^"]*)"/g)) {
    for (const token of m[1].split(/\s+/)) {
      if (token.startsWith("dz-")) classes.add(token);
    }
  }
  for (const m of html.matchAll(/class="([^"]*)"/g)) {
    for (const token of m[1].split(/\s+/)) {
      if (token.startsWith("dz-")) classes.add(token);
    }
  }
  assert.ok(classes.size > 0, "iframe touches shared geometry");
  const missing = [...classes].filter((cls) => !new RegExp(`\\.${cls}(?![\\w-])`).test(theme));
  assert.deepEqual(missing, [], `iframe uses theme-unknown classes: ${missing.join(", ")}`);
});

test("job iframe keeps tab-origin fetch with no metadata proxy", () => {
  const modal = codeLines(readSrc("../../src/modal/modal.ts"));
  assert.ok(modal.includes("createSessionFetcher"), "tab-origin session fetch reused");
  assert.ok(modal.includes("userIntent"), "every fetch carries explicit user intent (session rule)");
  assert.ok(!modal.includes("/api/proxy"), "metadata CORS proxy never referenced");
  assert.ok(!modal.includes("fetchViaProxy"), "no proxy transport in the iframe");
  assert.ok(modal.includes("requestPermission"), "cross-origin tiles prompt explicitly");
});

test("job iframe keeps tainted-canvas discipline and blob-anchor save", () => {
  const modal = codeLines(readSrc("../../src/modal/modal.ts"));
  assert.ok(modal.includes("originClean"), "origin-clean gate reused");
  assert.ok(modal.includes("display-only") || modal.includes("displayOnly"), "tainted finish is display-only");
  assert.ok(modal.includes("crossOrigin") === false, "ordinary display never sets crossOrigin");
  assert.ok(modal.includes("toDataURL") === false, "tainted canvas never serialized via toDataURL");
  assert.ok(modal.includes("createObjectURL"), "blob URLs for save");
  assert.ok(modal.includes("revokeObjectURL"), "object URLs revoked on dispose");
  assert.ok(modal.includes("anchor.download"), "blob-anchor save (no downloads permission)");
  assert.ok(!modal.includes("chrome.downloads"), "downloads API stays unused");
  assert.ok(modal.includes("requestNativeHandoff"), "native handoff offer preserved");
  assert.ok(modal.includes("Send to desktop app"), "handoff affordance preserved");
});
