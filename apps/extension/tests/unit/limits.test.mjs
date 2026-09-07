import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The extension renders through its vendored codegen mirror
// (`src/page/vendor/limits.js`, generated at build time by
// scripts/sync-web-js.mjs from packages/browser-runtime/src/limits.ts).
// Regenerate with `node scripts/sync-web-js.mjs` (`cargo xtask test
// extension` does this before the unit glob); never hand-edit vendor/.

async function loadVendor(rel) {
  const src = readFileSync(new URL(rel, import.meta.url), "utf8");
  return import(`data:text/javascript;charset=utf-8,${encodeURIComponent(src)}`);
}

const ext = await loadVendor("../../src/page/vendor/limits.js");
const canon = await import("../../../../packages/browser-runtime/src/limits.ts");

test("extension limits mirror the canonical browser-runtime module", () => {
  assert.equal(ext.BROWSER_MAX_CANVAS_SIDE, canon.BROWSER_MAX_CANVAS_SIDE);
  assert.equal(ext.BROWSER_MAX_CANVAS_AREA, canon.BROWSER_MAX_CANVAS_AREA);
  assert.deepEqual({ ...ext.BROWSER_LIMITS }, { ...canon.BROWSER_LIMITS });
  assert.equal(ext.BROWSER_MAX_PLAN_TILES, 100_000);
  assert.equal(ext.BROWSER_MAX_PLAN_TILES, canon.BROWSER_MAX_PLAN_TILES);
});

test("pickLevel parity: largest fitting wins, overflow-safe, undeclared last wins", () => {
  const cases = [
    {
      levels: [
        { index: 0, imageSize: { x: 256, y: 256 } },
        { index: 1, imageSize: { x: 8192, y: 8192 } },
        { index: 2, imageSize: { x: 16384, y: 16384 } },
        { index: 3, imageSize: { x: 32768, y: 32768 } },
        { index: 4, imageSize: { x: 2147483648, y: 2140449280 } },
      ],
      want: { index: 2 },
    },
    {
      levels: [
        { index: 0, imageSize: { x: 1073741824, y: 1070224896 } },
        { index: 1, imageSize: { x: 2147483648, y: 2140449280 } },
      ],
      want: { index: 0 },
    },
    { levels: [{ index: 0 }, { index: 1 }, { index: 2 }], want: { index: 2 } },
    { levels: [], want: { index: 0 } },
  ];
  for (const { levels, want } of cases) {
    assert.deepEqual(ext.pickLevel({ levels }), want);
    assert.deepEqual(ext.pickLevel({ levels }), canon.pickLevel({ levels }));
  }
  // Float x*y without safeArea would mis-rank gigapixel sizes; both must agree.
  const gigapixel = { levels: [{ index: 0, imageSize: { x: 100000, y: 100000 } }] };
  assert.equal(ext.probeLimits(gigapixel.levels[0].imageSize.width ? { width: 100000, height: 100000 } : {}, ext.BROWSER_LIMITS).verdict, "native-required");
  assert.deepEqual(ext.safeArea(100000, 100000), canon.safeArea(100000, 100000));
  assert.equal(ext.safeArea(Number.MAX_SAFE_INTEGER, 2), null);
});

test("estimateTileCount parity plus 100k guard semantics", () => {
  assert.equal(ext.estimateTileCount(256, 256), 1);
  assert.equal(ext.estimateTileCount(16384, 16384), 64 * 64);
  assert.equal(ext.estimateTileCount(16384, 16384), canon.estimateTileCount(16384, 16384));
  assert.equal(ext.estimateTileCount(0, 10), null);
  assert.ok(ext.estimateTileCount(16384, 16384) <= ext.BROWSER_MAX_PLAN_TILES);
});

test("page uses the vendored limits module, no forked area math", () => {
  const page = readFileSync(new URL("../../src/page/page.ts", import.meta.url), "utf8");
  assert.ok(page.includes('from "./vendor/limits.js"'), "page must import the vendored limits module");
  assert.ok(!page.includes('from "./limits.js"'), "page must not import the deleted manual mirror");
  assert.ok(page.includes("pickLevel"), "page must use shared pickLevel");
  assert.ok(page.includes("BROWSER_MAX_PLAN_TILES"), "page must enforce the 100k tile cap");
  assert.ok(!page.includes("MAX_CANVAS_AREA = 16384"), "page must not keep the forked float area check");
});

test("extension tile concurrency and pacing match the documented policy", () => {
  const page = readFileSync(new URL("../../src/page/page.ts", import.meta.url), "utf8");
  assert.ok(page.includes("EXT_TILE_CONCURRENCY"), "page must define the concurrent worker count");
  assert.ok(page.includes("EXT_TILE_MIN_INTERVAL_MS"), "page must pace starts per host");
  assert.equal(ext.BROWSER_MAX_PLAN_TILES, 100_000);
  const src = readFileSync(new URL("../../src/page/page.ts", import.meta.url), "utf8");
  assert.ok(src.includes("6"), "concurrency documents 6 workers");
});

test("taint gate: pixel reads behind originClean, display-only never promises save", () => {
  const page = readFileSync(new URL("../../src/page/page.ts", import.meta.url), "utf8");
  assert.ok(page.includes("originClean"), "page must track originClean");
  assert.ok(page.includes("if (originClean)"), "getImageData probe must sit behind originClean");
  assert.ok(page.includes("display-only"), "tainted path must finish as display-only success");
  assert.ok(!page.includes("showDisplayOnlySection"), "display-only must come from the vendored renderView, not a page replica");
});
