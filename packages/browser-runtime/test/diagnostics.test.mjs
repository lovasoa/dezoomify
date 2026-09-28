import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  createDiagnosticRecorder,
  diagnosticFields,
  formatDiagnosticReport,
  redactDiagnosticText,
} from "../../app-model/src/diagnostics.ts";
import {
  copyDiagnosticText,
  recentDiagnosticReports,
  retainDiagnostics,
} from "../src/diagnostics.ts";

test("redaction preserves URL spelling and useful parameters and captures Error causes", () => {
  const vectors = JSON.parse(
    readFileSync(new URL("../../../testdata/redaction-vectors.json", import.meta.url)),
  );
  for (const key of vectors.sensitive_query_keys)
    assert.ok(!redactDiagnosticText(`https://h/?${key}=CANARY&page=2`).includes("CANARY"), key);
  for (const vector of vectors.redaction_cases)
    for (const secret of vector.must_not_contain ?? [])
      assert.ok(!redactDiagnosticText(vector.input).includes(secret));
  const url = "https://user:CANARY@host/a%2Fb?token=CANARY&page=2&region=full&sig=CANARY&lang=fr";
  assert.equal(
    redactDiagnosticText(url),
    "https://[redacted]@host/a%2Fb?token=[redacted]&page=2&region=full&sig=[redacted]&lang=fr",
  );
  const error = new Error("fetch failed", { cause: Object.assign(new Error(url), { http: 403 }) });
  const fields = diagnosticFields({
    error,
    authorization: "CANARY",
    contents: [1, 2],
    bitmap: new Uint8Array([3]),
    path: "/home/me/private.png",
  });
  assert.equal(fields["error.cause.http"], 403);
  assert.equal(fields["error.message"], "fetch failed");
  assert.ok(!JSON.stringify(fields).includes("CANARY"));
  assert.ok(!JSON.stringify(fields).includes("private.png"));
  assert.ok(!("contents.0" in fields) && !("bitmap.0" in fields));
});

test("reports retain grouped causes and outcome under load independently of console sinks", () => {
  let now = 0;
  const d = createDiagnosticRecorder({
    id: "a",
    now: () => ++now,
    sink() {
      throw Error("console unavailable");
    },
  });
  d.context({ input: "https://host/image?page=2", version: "test" });
  d.context({ scan: { candidates: 100, overflow: 70 } });
  d.record("warn", "request", {
    http: 403,
    url: "https://host/first",
    preview: "Cloudflare challenge",
  });
  for (let i = 0; i < 5000; i++) {
    d.record("trace", "tile-success", { tile: i });
    d.record("warn", "request", { http: 403, url: `https://host/${i}` });
    d.record("debug", "sample", { text: "界".repeat(1000) });
  }
  d.finish("failed", { code: "job.partial-discarded", initiator: "policy" });
  d.finish("retired");
  const report = d.report();
  assert.ok(Buffer.byteLength(JSON.stringify(report)) <= 1024 * 1024);
  assert.ok(report.records.length <= 1000 && report.omitted_records > 0);
  assert.equal(report.failures[0].count, 5001);
  assert.equal(report.context["scan.candidates"], 100);
  assert.equal(report.context["scan.overflow"], 70);
  assert.equal(report.failures[0].first.fields.preview, "Cloudflare challenge");
  assert.equal(report.failures[0].last.fields.url, "https://host/4999");
  assert.equal(report.outcome.event, "failed");
  assert.match(formatDiagnosticReport(report), /Cloudflare challenge/);
  const other = createDiagnosticRecorder({ id: "b", now: () => now });
  d.record("error", "late-callback");
  assert.equal(other.report().failures.length, 0);
});

test("completed report retention is bounded and returns independent copies", () => {
  for (let i = 0; i < 12; i++)
    retainDiagnostics(createDiagnosticRecorder({ id: String(i), now: () => 0 }));
  const reports = recentDiagnosticReports();
  assert.equal(reports.length, 10);
  reports[0].id = "changed";
  assert.equal(recentDiagnosticReports()[0].id, "2");
});

test("clipboard rejection propagates instead of claiming a successful copy", async () => {
  const old = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      clipboard: {
        writeText: async () => {
          throw Error("denied");
        },
      },
    },
  });
  try {
    await assert.rejects(copyDiagnosticText("report"), /denied/);
  } finally {
    if (old) Object.defineProperty(globalThis, "navigator", old);
    else delete globalThis.navigator;
  }
});
