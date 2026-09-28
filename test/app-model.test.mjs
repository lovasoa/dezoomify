import assert from "node:assert/strict";
import test from "node:test";
import {
  BROWSER_SESSION_TRANSPORT_LABEL,
  DIRECT_TRANSPORT_LABEL,
  DISPLAY_TRANSPORT_LABEL,
  isActiveSnapshot,
  isTerminalSnapshot,
  NATIVE_TRANSPORT_LABEL,
  PROXY_TRANSPORT_LABEL,
  renderTransportLabel,
  validateEngineStartRequest,
} from "../packages/app-model/src/index.ts";

function browserRequest(url = "https://museum.example.org/iiif/1/manifest.json") {
  return { inputs: [{ url }], engine: {} };
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
});

test("engine start validation rejects missing inputs and options", () => {
  assert.equal(validateEngineStartRequest({ inputs: [], engine: {} }), "validation.empty-inputs");
  assert.equal(
    validateEngineStartRequest({ inputs: [{ url: "" }], engine: {} }),
    "validation.bad-input-url",
  );
  assert.equal(
    validateEngineStartRequest({ inputs: [{ url: "https://x.test" }] }),
    "validation.bad-engine",
  );
  assert.equal(validateEngineStartRequest(browserRequest()), null);
});

// ---------------------------------------------------------------------------
// Transport labels
// ---------------------------------------------------------------------------

test("transport labels match the canonical values", () => {
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
});
