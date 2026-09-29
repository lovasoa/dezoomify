import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_PAGE_TITLE, jobPageTitle } from "../packages/shared-ui/src/view-helpers.ts";

test("jobPageTitle renders Dezoomify plus host", () => {
  assert.equal(DEFAULT_PAGE_TITLE, "Dezoomify");
  assert.equal(jobPageTitle("https://example.test/artwork/1"), "Dezoomify example.test");
  assert.equal(
    jobPageTitle("https://museum.example.org:8080/a?b=c"),
    "Dezoomify museum.example.org:8080",
  );
});

test("jobPageTitle falls back to base for missing or unparseable URLs", () => {
  assert.equal(jobPageTitle(undefined), "Dezoomify");
  assert.equal(jobPageTitle(""), "Dezoomify");
  assert.equal(jobPageTitle("not a url"), "Dezoomify");
});
