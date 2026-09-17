import test from "node:test";
import assert from "node:assert/strict";
import { reportIssueUrl } from "../packages/shared-ui/src/view-helpers.ts";

const error = {
  code: "NO_IMAGE_FOUND",
  category: "discovery",
  retryable: false,
  message: "No zoomable image could be found.",
};

test("reportIssueUrl prefills the new-site-support labels, title, and body", () => {
  const url = new URL(
    reportIssueUrl({
      source: "https://museum.example.org/viewer?page=1",
      error,
      activityLog: "line one\nline two",
    }),
  );
  assert.equal(`${url.origin}${url.pathname}`, "https://github.com/lovasoa/dezoomify/issues/new");
  assert.equal(url.searchParams.get("labels"), "new site support,unconfirmed");
  assert.equal(url.searchParams.get("title"), "[new site support] museum.example.org");
  const body = url.searchParams.get("body") || "";
  assert.ok(body.includes("https://museum.example.org/viewer?page=1"), "body carries the source address");
  assert.ok(body.includes("No zoomable image could be found."), "body carries the engine error");
  assert.ok(body.includes("code:NO_IMAGE_FOUND"), "body carries the diagnostics code line");
  assert.ok(body.includes("line one") && body.includes("line two"), "body carries the activity log");
});

test("reportIssueUrl bounds the body and keeps diagnostics before log lines", () => {
  const log = Array.from({ length: 2000 }, (_, i) => `log line ${i} ${"x".repeat(80)}`).join("\n");
  const url = new URL(reportIssueUrl({ source: "https://x.example/view", error, activityLog: log }));
  const body = url.searchParams.get("body") || "";
  assert.ok(body.length <= 4000, "body stays under the pre-encoding ceiling");
  assert.ok(body.includes("### Technical details"), "diagnostics survive truncation");
  assert.ok(body.includes("code:NO_IMAGE_FOUND"), "code line survives truncation");
});

test("reportIssueUrl tolerates a missing source and activity log", () => {
  const url = new URL(reportIssueUrl({ error }));
  assert.equal(url.searchParams.get("title"), "[new site support] the server");
  const body = url.searchParams.get("body") || "";
  assert.ok(body.includes("(address unavailable)"), "missing source is called out");
  assert.ok(!body.includes("### Activity log"), "no empty activity-log section is rendered");
});
