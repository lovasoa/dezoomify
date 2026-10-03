import assert from "node:assert/strict";
import test from "node:test";
import { isValidInputUrl, readInitialUrl } from "../packages/shared-ui/src/index.ts";

test("website input accepts ordinary HTTP(S) URLs only", () => {
  for (const bad of [
    "",
    "file:///etc/passwd",
    "https://user:pass@example.com/x",
    `https://example.com/${"a".repeat(2048)}`,
    42,
  ])
    assert.equal(isValidInputUrl(bad), false);
  assert.equal(isValidInputUrl("  https://example.com/first  "), true);
});

test("prefill refuses secret-bearing candidates before any job starts", () => {
  assert.equal(readInitialUrl({ search: "?url=https://example.com/ok" }), "https://example.com/ok");
  for (const loc of [
    { search: "?url=https://example.com/item?token=secret" },
    { search: "?src=https://example.com/item?APIKEY=secret" },
    { hash: "#url=https%3A%2F%2Fexample.com%2Fitem%3Fsig%3Dabc" },
    { hash: "#https://example.com/item#session=abc" },
  ])
    assert.equal(readInitialUrl(loc), null, JSON.stringify(loc));
});
