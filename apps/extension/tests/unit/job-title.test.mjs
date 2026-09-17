import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

async function loadViewHelpers() {
  const bundled = await build({
    entryPoints: [fileURLToPath(new URL("../../../../packages/shared-ui/src/view-helpers.ts", import.meta.url))],
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    write: false,
  });
  const code = bundled.outputFiles[0].text;
  return import(`data:text/javascript;charset=utf-8,${encodeURIComponent(code)}`);
}

const { DEFAULT_PAGE_TITLE, isActiveJobStatus, jobPageTitle } = await loadViewHelpers();

test("extension job tab shares the Dezoomify <host> title shape", () => {
  assert.equal(DEFAULT_PAGE_TITLE, "Dezoomify");
  assert.equal(jobPageTitle("https://example.test/artwork/1"), "Dezoomify example.test");
  assert.equal(isActiveJobStatus("downloading"), true);
  assert.equal(isActiveJobStatus("completed"), false);
});

test("extension job page syncs document.title while dezooming", () => {
  const source = readFileSync(new URL("../../src/job/index.ts", import.meta.url), "utf8");
  assert.ok(source.includes("syncExtensionJobTitle"), "title sync helper exists");
  assert.ok(source.includes("EXTENSION_JOB_BASE_TITLE"), "idle base title is defined");
  assert.ok(source.includes("document.title"), "job page assigns document.title");
  assert.ok(source.includes("jobPageTitle"), "job page uses the shared Dezoomify <host> helper");
  assert.ok(source.includes("isActiveJobStatus"), "job page only retitles while dezooming");
  assert.ok(
    source.includes("syncExtensionJobTitle(status,"),
    "every job view render syncs the tab title",
  );
});
