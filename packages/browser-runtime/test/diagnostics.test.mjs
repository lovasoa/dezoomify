import assert from "node:assert/strict";
import test from "node:test";
import {
  createDiagnosticRecorder,
  diagnosticFields,
  formatDiagnosticReport,
} from "../../shared-ui/src/diagnostics.ts";
import { copyDiagnosticText } from "../src/diagnostics.ts";

test("diagnostics preserve reproduction facts and Error causes without retaining payloads", () => {
  const url = "https://host/a%2Fb?token=abc&page=2&region=full&sig=def&lang=fr";
  const error = new Error("fetch failed", { cause: Object.assign(new Error(url), { http: 403 }) });
  const fields = diagnosticFields({
    error,
    selection_policy: "automatic",
    policy_reason: "metadata-only",
    contents: [1, 2],
    bitmap: new Uint8Array([3]),
    path: "/home/me/private.png",
  });
  assert.equal(fields["error.cause.http"], 403);
  assert.equal(fields["error.message"], "fetch failed");
  assert.equal(fields["error.cause.message"], url);
  assert.equal(fields.selection_policy, "automatic");
  assert.equal(fields.policy_reason, "metadata-only");
  assert.equal(fields.path, "/home/me/private.png");
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
  d.finish("failed", { code: "tile-failed", initiator: "policy" });
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

test("wide reports prioritize exact sources and retain differing facts without repeating inferred ones", () => {
  const canonical = "https://image.test/info.json?sig=exact%2Bvalue";
  const d = createDiagnosticRecorder({
    id: "wide",
    now: () => 42,
    context: {
      input: "https://museum.test/page",
      product: "website",
      version: "test",
      user_agent: "Firefox (Linux x86_64)",
      platform: "Linux x86_64",
      presented_phase: "completed",
      presented_error: "",
    },
  });
  d.observe({
    phase: "acquisition",
    completed: 2,
    total: 2,
    source_url: canonical,
    source_format: "iiif",
    selected: { width: 20, height: 10 },
    maximum: { width: 20, height: 10 },
  });
  d.context({
    canvas: { width: 20, height: 10 },
    canvas_bytes: 800,
    canvas_limits: { maxWidth: 32768, maxHeight: 32768 },
    unusual: { detail: "keep me" },
  });
  d.record("info", "request", {
    url: canonical,
    final_url: canonical,
    http: 200,
    "error.stack": "",
  });
  d.record("debug", "tile-geometry", { canvas: { width: 20, height: 10 }, decoded_width: 7 });
  d.record("warn", "request", {
    url: "https://image.test/old",
    final_url: canonical,
    http: 403,
    preview: "blocked",
  });
  d.finish("completed", {
    canvas: { width: 20, height: 10 },
    format: "png",
    disposition: "browser-save-ready",
  });
  const report = d.report();
  const before = structuredClone(report);
  const text = formatDiagnosticReport(report);
  assert.ok(text.startsWith("Outcome:"));
  assert.ok(text.indexOf(`canonical: ${canonical}`) < text.indexOf("Problem"));
  assert.ok(text.indexOf("Problem") < text.indexOf("Counts:"));
  assert.ok(text.indexOf("Runtime:") > text.indexOf("Timeline"));
  assert.match(text, /Counts: tiles_completed=2 tiles_total=2/);
  assert.match(text, /canvas_limits: maxWidth=32768 maxHeight=32768/);
  assert.match(text, /unusual: detail=keep me/);
  assert.equal(text.match(/http=403/g).length, 1);
  assert.equal(text.match(/completed canvas.width=20 canvas.height=10/g).length, 1);
  assert.equal(text.match(/canvas.width=20/g).length, 1);
  assert.match(text, /tile-geometry decoded_width=7/);
  assert.equal(text.match(/final_url=/g).length, 1, "only real redirects remain");
  assert.ok(
    !/presented_phase|presented_error|canvas_bytes|platform=|selection:|maximum:|error.stack=/.test(
      text,
    ),
  );
  assert.match(text, /phase acquisition/);
  assert.deepEqual(report, before, "formatting preserves structured evidence");
  report.context.input = canonical;
  assert.ok(
    !formatDiagnosticReport(report).includes("\ninput:"),
    "identical input is inferred from canonical",
  );
  report.context["maximum.width"] = 40;
  report.context["maximum.height"] = 20;
  report.context.canvas_bytes = 900;
  report.context.platform = "different platform";
  assert.match(formatDiagnosticReport(report), /maximum: width=40 height=20/);
  assert.match(formatDiagnosticReport(report), /canvas_bytes=900/);
  assert.match(formatDiagnosticReport(report), /platform=different platform/);
  const failed = createDiagnosticRecorder({ id: "failed", now: () => 0 });
  failed.finish("failed", { kind: "canvas-too-large", detail: "unique terminal cause" });
  assert.equal(formatDiagnosticReport(failed.report()).match(/unique terminal cause/g).length, 1);
});
