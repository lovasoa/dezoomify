import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import {
  DiagnosticDetails,
  diagnosticIssueUrl,
} from "../packages/shared-ui/src/diagnostic-details.tsx";
import { createDiagnosticRecorder } from "../packages/shared-ui/src/diagnostics.ts";
import { act, click, makeContainer } from "./react-dom.mjs";

const report = () => {
  const d = createDiagnosticRecorder({
    id: "test",
    now: () => 0,
    context: { input: "https://host/a%2Fb?token=SECRET&page=2", version: "test" },
  });
  d.record("warn", "request-failed", { http: 403, preview: "challenge" });
  d.finish("failed", { code: "job.partial-discarded", initiator: "policy" });
  return d.report();
};
test("issue draft keeps evidence and bounds the encoded URL", () => {
  const r = report();
  for (let i = 0; i < 100; i++) r.context[`extra${i}`] = "界 ".repeat(1000);
  const url = new URL(diagnosticIssueUrl(r));
  assert.ok(url.href.length < 7100);
  const body = url.searchParams.get("body");
  assert.match(body, /job.partial-discarded/);
  assert.match(body, /challenge/);
  assert.ok(body.includes(r.context.input));
});
test("issue draft identifies the source and product and explains structured failures", () => {
  for (const product of ["website", "extension", "desktop"]) {
    const d = createDiagnosticRecorder({
      id: "redirect",
      now: () => 0,
      context: { input: "https://collection.example/item", product },
    });
    d.record("debug", "request", {
      url: "https://collection.example/item",
      final_url: "https://images.example/viewer",
    });
    d.record("debug", "request", {
      url: "https://tiles.example/0.jpg",
      final_url: "https://cdn.example/0.jpg",
    });
    const error = {
      kind: "http-error",
      status: 403,
      transport: "direct",
      request: "https://images.example/info.json",
      detail: "Server said ```denied```",
    };
    d.finish("failed", error);
    const url = new URL(diagnosticIssueUrl(d.report(), error));
    assert.equal(url.searchParams.get("title"), `images.example : ${product} report`);
    assert.equal(url.searchParams.get("labels"), `unconfirmed,${product},transport`);
    const body = url.searchParams.get("body");
    assert.ok(
      body.startsWith(
        "https://collection.example/item\nResolved URL: https://images.example/viewer",
      ),
    );
    assert.match(body, /^> .+/m);
    assert.ok(body.indexOf("status: 403") < body.indexOf("````text"));
    assert.match(body, /"kind": "http-error"/);
    assert.ok(body.endsWith("\n````\n"));
  }
});
test("issue labels use composed structured errors and do not infer bugs from prose", () => {
  const r = report();
  r.context.product = "desktop";
  const labels = (error) => new URL(diagnosticIssueUrl(r, error)).searchParams.get("labels");
  assert.equal(
    labels({
      kind: "discovery-failed",
      cause: {
        kind: "resource",
        request: "https://host/info",
        resource_kind: "metadata",
        source: { kind: "http-error", status: 404, transport: "native" },
      },
    }),
    "unconfirmed,desktop,image discovery,transport",
  );
  assert.equal(
    labels({ kind: "limit-exceeded", limit: { reason: "canvas-area" } }),
    "unconfirmed,desktop,output",
  );
  assert.equal(
    labels({ kind: "internal", detail: "http-error output write-failed" }),
    "unconfirmed,desktop",
  );
  r.outcome.fields = { "error.kind": "write-failed" };
  assert.equal(labels(), "unconfirmed,desktop,output");
});
test("failed clipboard leaves selectable report and never claims success", async () => {
  const el = makeContainer();
  const root = createRoot(el);
  act(() =>
    root.render(
      createElement(DiagnosticDetails, {
        report: report(),
        callbacks: {
          onCopyDiagnostics: async () => {
            throw Error("denied");
          },
        },
      }),
    ),
  );
  await act(async () => click(el.querySelector("button")));
  assert.match(el.querySelector('[role="alert"]').textContent, /Could not copy/);
  assert.equal(el.querySelector('[role="status"]'), null);
  assert.match(el.querySelector("pre").textContent, /challenge/);
  act(() => root.unmount());
});
