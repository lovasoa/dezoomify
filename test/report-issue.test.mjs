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
