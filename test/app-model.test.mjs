import assert from "node:assert/strict";
import test from "node:test";
import {
  BROWSER_SESSION_TRANSPORT_LABEL,
  clearHistory,
  DIRECT_TRANSPORT_LABEL,
  DISPLAY_TRANSPORT_LABEL,
  extensionForSaveFormat,
  HISTORY_MAX,
  historyOriginOf,
  isActiveSnapshot,
  isTerminalSnapshot,
  loadHistory,
  NATIVE_TRANSPORT_LABEL,
  PROXY_TRANSPORT_LABEL,
  parseHistoryJson,
  pushHistory,
  renderTransportLabel,
  safeTitleStem,
  saveHistory,
  suggestedNameFor,
  toHistoryEntry,
  validateJobStartRequest,
} from "../packages/app-model/src/index.ts";

function memoryStore() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => {
      map.set(key, String(value));
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

function browserRequest(url = "https://museum.example.org/iiif/1/manifest.json") {
  return { inputs: [{ url }], engine: {}, host: { kind: "browser", sourceUrl: url } };
}

// ---------------------------------------------------------------------------
// Snapshots: absolute engine projections, predicates read the terminal only
// ---------------------------------------------------------------------------

// Authoritative Snapshot builder: the engine owns all job state;
// nothing here folds events or assigns revisions.
function dto(overrides = {}) {
  return {
    revision: 0,
    lifecycle: "Discovering",
    paused: false,
    progress: { completed: 0, total: undefined },
    selection: {
      image: undefined,
      level: undefined,
      level_count: 0,
      catalog: undefined,
      deferred: [],
    },
    decision: undefined,
    terminal: undefined,
    output: undefined,
    ...overrides,
  };
}

test("snapshot predicates read the terminal only", () => {
  const live = dto({
    revision: 3,
    lifecycle: "AcquiringTiles",
    progress: { completed: 3, total: 12 },
  });
  assert.ok(isActiveSnapshot(live));
  assert.ok(!isTerminalSnapshot(live));

  const done = dto({ revision: 9, lifecycle: "Completed", terminal: { type: "completed" } });
  assert.ok(isTerminalSnapshot(done));
  assert.ok(!isActiveSnapshot(done));

  const failed = dto({
    revision: 10,
    lifecycle: "Failed",
    terminal: {
      type: "failed",
      error: { code: "boom", phase: "decode", retryable: false, message: "boom", recovery: [] },
    },
  });
  assert.ok(isTerminalSnapshot(failed));
  assert.equal(failed.terminal.error.code, "boom");
});

test("job request validation returns stable boundary codes", () => {
  assert.equal(
    validateJobStartRequest({
      inputs: [],
      engine: {},
      host: { kind: "browser", sourceUrl: "https://x.example.org/y" },
    }),
    "validation.empty-inputs",
  );
  assert.equal(
    validateJobStartRequest({
      inputs: [{ url: "ftp://x/y" }],
      engine: {},
      host: { kind: "mars" },
    }),
    "validation.bad-exec-kind",
  );
  assert.equal(
    validateJobStartRequest({
      inputs: [{ url: "https://x.example.org/y" }],
      engine: {},
      host: { kind: "browser" },
    }),
    "validation.bad-exec-source",
  );
  assert.equal(validateJobStartRequest(browserRequest()), null);
});

// ---------------------------------------------------------------------------
// History ledger
// ---------------------------------------------------------------------------

test("history keeps full addresses with origins, capped and fail-closed", () => {
  assert.equal(
    historyOriginOf("https://museum.example.org/painting/1?view=2#frag"),
    "https://museum.example.org",
  );
  assert.equal(historyOriginOf("http://host:8080/a"), "http://host:8080");
  assert.equal(historyOriginOf("file:///tmp/a"), "");
  const entry = toHistoryEntry("https://museum.example.org/a", {
    width: 100,
    height: 50,
    format: "PNG",
    at: 42,
  });
  assert.equal(entry.url, "https://museum.example.org/a");
  assert.equal(entry.at, 42);
  assert.equal(toHistoryEntry("not a url", {}), null);
  let list = [];
  for (let n = 0; n < HISTORY_MAX + 5; n++) {
    list = pushHistory(list, {
      origin: "https://x.example.org",
      url: `https://x.example.org/${n}`,
      at: n,
    });
  }
  assert.equal(list.length, HISTORY_MAX);
  assert.equal(list[0].url, `https://x.example.org/${HISTORY_MAX + 4}`);
  assert.deepEqual(parseHistoryJson("garbage"), []);
  const store = memoryStore();
  saveHistory(store, "k", list);
  assert.equal(loadHistory(store, "k").length, HISTORY_MAX);
  clearHistory(store, "k");
  assert.deepEqual(loadHistory(store, "k"), []);
});

// ---------------------------------------------------------------------------
// Labels and save names
// ---------------------------------------------------------------------------

test("labels and save names match the canonical values", () => {
  assert.equal(DIRECT_TRANSPORT_LABEL, "Direct from your browser");
  assert.equal(PROXY_TRANSPORT_LABEL, "Metadata proxy");
  assert.equal(DISPLAY_TRANSPORT_LABEL, "Display only");
  assert.equal(BROWSER_SESSION_TRANSPORT_LABEL, "Browser session");
  assert.equal(NATIVE_TRANSPORT_LABEL, "Native");
  assert.equal(renderTransportLabel("direct"), "Direct from your browser");
  assert.equal(renderTransportLabel("metadata-proxy"), "Metadata proxy");
  assert.equal(renderTransportLabel("display-only"), "Display only");
  assert.equal(renderTransportLabel("browser-session"), "Browser session");
  assert.equal(renderTransportLabel("native"), "Native");
  assert.equal(renderTransportLabel("mystery"), "mystery");
  assert.equal(suggestedNameFor(800, 600, "png"), "dezoomify-800x600.png");
  assert.equal(suggestedNameFor(800, 600, "jpeg"), "dezoomify-800x600.jpg");
  assert.equal(suggestedNameFor(800, 600, "iiif-dir"), "dezoomify-800x600.iiif");
  assert.equal(suggestedNameFor(800, 600, "png", "Portrait: Étude"), "Portrait_ Étude.png");
  assert.equal(suggestedNameFor(800, 600, "png", "CON"), "dezoomify-800x600.png");
  assert.equal(safeTitleStem("A" + String.fromCharCode(0) + "B"), "A_B");
  assert.equal(extensionForSaveFormat("iiif"), "iiif");
});
