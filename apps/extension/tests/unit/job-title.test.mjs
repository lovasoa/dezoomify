import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PAGE_TITLE, isActiveJobStatus, jobPageTitle } from "../../../../packages/shared-ui/src/view-helpers.ts";

test("extension job tab shares the Dezoomify <host> title shape", () => {
  assert.equal(DEFAULT_PAGE_TITLE, "Dezoomify");
  assert.equal(jobPageTitle("https://example.test/artwork/1"), "Dezoomify example.test");
  assert.equal(isActiveJobStatus("downloading"), true);
  assert.equal(isActiveJobStatus("completed"), false);
});
