// Shared-oracle tests for security-sensitive parsing duplicated across
// languages. Every case in testdata/deep-link-vectors.json is asserted here
// (TS side) and by the Rust test `deep_link_vectors_match_the_shared_oracle`
// (apps/desktop/src-tauri/src/deep_link.rs), so the TS and Rust validators
// can never accept or reject different inputs unnoticed. The secret query
// vocabulary's rejection behavior is pinned by the deep-link vectors; its
// membership is deliberately unpinned (changing it is a reviewed policy edit).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  DEEP_LINK_SECRET_QUERY_KEYS,
  SIGNED_QUERY_KEYS,
  validateDeepLinkPayload,
} from "../../../packages/shared-ui/src/source-url.ts";

const deepLinkVectors = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../../testdata/deep-link-vectors.json", import.meta.url)),
    "utf8",
  ),
);

test("deep-link vectors: the frontend refuses every raw link (the shell parser is the single validator)", () => {
  assert.ok(deepLinkVectors.cases.length > 0);
  for (const c of deepLinkVectors.cases) {
    assert.equal(
      validateDeepLinkPayload({ source_url: c.raw }),
      null,
      `${c.name}: raw dezoomify:// values never pass frontend validation`,
    );
  }
});

// Settings policy vectors stay covered by the Rust single validator
// (`policy_vectors_match_the_shared_oracle` in
// apps/desktop/src-tauri/src/settings.rs); the TS mirror of that validator
// is gone.

// The proxy admission policy is the deliberately narrower vocabulary defined
// once in packages/shared-ui/src/source-url.ts and consumed by
// packages/browser-runtime/src/web-fetch.ts and src/server/security.ts.
const SIGNED_QUERY_KEYS_LOCK = [
  "access_token",
  "auth",
  "credential",
  "key",
  "password",
  "secret",
  "session",
  "sid",
  "sig",
  "signature",
  "ticket",
  "token",
];

test("signed-params proxy policy is the single shared vocabulary", () => {
  assert.deepEqual([...SIGNED_QUERY_KEYS], SIGNED_QUERY_KEYS_LOCK);
  for (const key of SIGNED_QUERY_KEYS_LOCK) {
    assert.ok(DEEP_LINK_SECRET_QUERY_KEYS.has(key), `${key} stays in the secret vocabulary`);
  }
});
