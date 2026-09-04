import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

async function loadTs(rel) {
  const src = readFileSync(new URL(rel, import.meta.url), "utf8");
  return import(`data:text/javascript;charset=utf-8,${encodeURIComponent(src)}`);
}

const red = await loadTs("../../src/background/redaction.ts");
const { redactUrl, scanForCanary, bestEffortOverwrite, FORBIDDEN_STORES } = red;

test("redactUrl strips userinfo, sensitive query, fragments", () => {
  const out = redactUrl("https://user:secret@a.example/img?token=ABC&view=1#frag");
  assert.ok(!out.includes("user"));
  assert.ok(!out.includes("ABC"));
  assert.ok(out.includes("***"));
  assert.ok(out.includes("view=1"));
  assert.ok(!out.includes("#"));
  assert.equal(redactUrl("not a url"), "[invalid-url]");
});

test("FORBIDDEN_STORES covers all banned sinks", () => {
  const joined = FORBIDDEN_STORES.join(" ");
  for (const needle of ["extension-storage", "indexeddb", "local-storage", "session-storage", "browser-cache", "url", "clipboard", "console", "analytics"]) {
    assert.ok(joined.includes(needle), `missing ${needle}`);
  }
});

test("canary scan finds leaks and passes when clean", () => {
  const canaryA = "CANARY-cookie-session-UNIQUE-001";
  const canaryB = "CANARY-cookie-prefs-UNIQUE-002";
  assert.deepEqual(scanForCanary(["console: ok", "storage: {}", "stderr: done"], [canaryA, canaryB]), []);
  assert.deepEqual(scanForCanary([`console: ${canaryA}`, "storage: {}"], [canaryA, canaryB]), [canaryA]);
  assert.deepEqual(scanForCanary(["a", "b"], []), []);
});

test("best-effort overwrite zeroes owned buffers; documents limits", () => {
  const buf = new Uint8Array([9, 8, 7, 6]);
  assert.equal(bestEffortOverwrite(buf), true);
  assert.deepEqual([...buf], [0, 0, 0, 0]);
  assert.equal(bestEffortOverwrite("nope"), false);
  const src = readFileSync(new URL("../../src/background/redaction.ts", import.meta.url), "utf8");
  assert.ok(src.includes("cannot be"), "must disclaim universal zeroization");
  assert.ok(src.toLowerCase().includes("memory-only"), "must document memory-only handling");
});

test("redaction source never claims universal zeroization", () => {
  const src = readFileSync(new URL("../../src/background/redaction.ts", import.meta.url), "utf8");
  assert.ok(src.includes("best-effort") || src.includes("best_effort") || src.includes("bestEffort"), "must name best-effort overwrite");
  assert.ok(!/guaranteed zeroization/i.test(src), "must not promise guaranteed zeroization");
});
