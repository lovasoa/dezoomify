import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_PAGE_TITLE,
  isActiveJobStatus,
  jobPageTitle,
} from "../packages/shared-ui/src/view-helpers.ts";

test("jobPageTitle renders Dezoomify plus host", () => {
  assert.equal(DEFAULT_PAGE_TITLE, "Dezoomify");
  assert.equal(jobPageTitle("https://example.test/artwork/1"), "Dezoomify example.test");
  assert.equal(jobPageTitle("https://museum.example.org:8080/a?b=c"), "Dezoomify museum.example.org:8080");
});

test("jobPageTitle falls back to base for missing or unparseable URLs", () => {
  assert.equal(jobPageTitle(undefined), "Dezoomify");
  assert.equal(jobPageTitle(""), "Dezoomify");
  assert.equal(jobPageTitle("not a url"), "Dezoomify");
});

test("isActiveJobStatus covers only the while-dezooming phase", () => {
  for (const status of ["discovering", "choosing-image", "choosing-level", "preflighting", "downloading", "saving"]) {
    assert.equal(isActiveJobStatus(status), true, status);
  }
  for (const status of ["idle", "display-only", "completed", "cancelled", "failed"]) {
    assert.equal(isActiveJobStatus(status), false, status);
  }
});
