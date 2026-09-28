import assert from "node:assert/strict";
import test from "node:test";
import { createDiagnosticRecorder } from "../../../../packages/shared-ui/src/diagnostics.ts";
import { createResourceFetcher } from "../../src/job/transport.ts";

const request = {
  uri: "https://source.test/image.dzi",
  headers: [{ name: "Accept", value: "application/xml" }],
  purpose: "metadata",
};
const signal = new AbortController().signal;
function setup({ sourceFailure, origin = "https://source.test" } = {}) {
  const calls = [],
    diagnostics = createDiagnosticRecorder({ id: "extension", now: () => 1000 });
  const fetch = createResourceFetcher({
    diagnostics,
    sourceAccess: {
      origin,
      async fetch(input, owned) {
        calls.push(["source", input, owned]);
        if (sourceFailure) throw sourceFailure;
        return { bytes: new Uint8Array([7, 8]), finalUri: "https://source.test/final" };
      },
    },
    extensionTransport: {
      async fetchResource(input, owned, interaction) {
        calls.push(["extension", input, owned, interaction]);
        return interaction === "forbidden"
          ? { kind: "needs-access", origin: new URL(input.uri).origin }
          : { kind: "response", response: { bytes: new Uint8Array([1]), final_uri: undefined } };
      },
    },
  });
  return { calls, diagnostics, fetch };
}

test("metadata and same-origin tiles/probes retain the exact source request, headers and redirect", async () => {
  for (const purpose of ["metadata", "tile", "probe"]) {
    const h = setup(),
      input = { ...request, purpose };
    const result = await h.fetch(input, signal, "forbidden");
    assert.deepEqual([...result.response.bytes], [7, 8]);
    assert.equal(result.response.final_uri, "https://source.test/final");
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0][1], input);
    assert.equal(h.calls[0][2], signal);
  }
});

test("cross-origin tiles use extension fetching and retain deferred permission facts", async () => {
  const h = setup();
  const input = { ...request, uri: "https://cdn.test/tile.png", purpose: "tile" };
  assert.deepEqual(await h.fetch(input, signal, "forbidden"), {
    kind: "needs-access",
    origin: "https://cdn.test",
  });
  assert.deepEqual(
    h.calls.map(([route]) => route),
    ["extension"],
  );
  assert.equal(h.calls[0][3], "forbidden");
});

test("source injection failure tries extension once and preserves the original cause", async () => {
  const h = setup({
    sourceFailure: new Error("source unavailable", { cause: new Error("Missing host permission") }),
  });
  const result = await h.fetch(request, signal, "allowed");
  assert.deepEqual([...result.response.bytes], [1]);
  assert.deepEqual(
    h.calls.map(([route]) => route),
    ["source", "extension"],
  );
  const facts = h.diagnostics
    .report()
    .records.find((record) => record.event === "source-fetch-fallback").fields;
  assert.equal(facts["error.cause.message"], "Missing host permission");
  assert.equal(facts.url, request.uri);
});

test("definitive HTTP refusals do not retry and grouped diagnostics stay bounded", async () => {
  const h = setup({
    sourceFailure: {
      code: "TRANSPORT_HTTP_ERROR",
      http: 403,
      transport: "browser-session",
      message: "Refused",
    },
  });
  for (let index = 0; index < 1036; index++)
    await assert.rejects(
      h.fetch({ ...request, uri: `https://source.test/${index}.jpg` }, signal, "allowed"),
      { http: 403 },
    );
  assert.ok(h.calls.every(([route]) => route === "source"));
  const report = h.diagnostics.report();
  assert.equal(report.counters.requests, 1036);
  assert.equal(report.counters.request_failures, 1036);
  assert.equal(report.counters.requests_pending, 0);
  assert.equal(report.failures.length, 1);
  assert.equal(report.failures[0].count, 1036);
  assert.equal(report.failures[0].last.fields.url, "https://source.test/1035.jpg");
});

test("a source deadline does not start an unbounded second route", async () => {
  const h = setup({
    sourceFailure: {
      code: "TRANSPORT_TIMEOUT",
      transport: "browser-session",
      message: "Timed out",
    },
  });
  await assert.rejects(h.fetch(request, signal, "allowed"), { code: "TRANSPORT_TIMEOUT" });
  assert.equal(h.calls.length, 1);
});
