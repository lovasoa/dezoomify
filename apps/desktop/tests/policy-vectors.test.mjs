// Shared-oracle tests for security-sensitive parsing duplicated across
// languages. Every case in testdata/deep-link-vectors.json and
// testdata/policy-vectors.json is asserted here (TS side) and by the Rust
// tests `deep_link_vectors_match_the_shared_oracle`
// (apps/desktop/src-tauri/src/deep_link.rs) and
// `policy_vectors_match_the_shared_oracle`
// (apps/desktop/src-tauri/src/settings.rs), so the TS and Rust validators can
// never accept or reject different inputs unnoticed. The settings cases in
// testdata/policy-vectors.json are covered by the Rust validator alone (the
// duplicated TS settings validator is gone). Also pins the two
// credential query-key vocabularies that live in TypeScript against their
// Rust contract mirror.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { isRetryable } from "../../../packages/shared-ui/src/failure.ts";
import { SIGNED_QUERY_KEYS } from "../../../packages/shared-ui/src/source-url.ts";
import { DEEP_LINK_SECRET_QUERY_KEYS, validateDeepLinkPayload } from "../src/errorCopy.ts";

const deepLinkVectors = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../../testdata/deep-link-vectors.json", import.meta.url)),
    "utf8",
  ),
);
const policyVectors = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../../testdata/policy-vectors.json", import.meta.url)),
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

test("retry policy vectors: the TS verdicts match the shared oracle", () => {
  for (const vector of policyVectors.retryPolicy) {
    assert.equal(isRetryable(vector.error), vector.retryable, vector.name);
  }
});

// Settings policy vectors stay covered by the Rust single validator
// (`policy_vectors_match_the_shared_oracle` in
// apps/desktop/src-tauri/src/settings.rs); the TS mirror of that validator
// is gone.

// Deliberate cross-language membership lock: this exact list mirrors the
// canonical Rust contract constant `dezoomify::model::SENSITIVE_QUERY_KEYS`
// (consumed by apps/desktop/src-tauri/src/deep_link.rs and pinned by its
// `sensitive_query_key_membership_is_locked` test). Update both sides and
// both locks in the same change.
const SENSITIVE_QUERY_KEYS_LOCK = [
  "access-token",
  "access_token",
  "api-key",
  "api_key",
  "apikey",
  "auth",
  "authorization",
  "bearer",
  "code",
  "cookie",
  "cookies",
  "credential",
  "key",
  "passwd",
  "password",
  "proxy-authorization",
  "secret",
  "session",
  "sessionid",
  "sessiontoken",
  "set-cookie",
  "sid",
  "sig",
  "signature",
  "state",
  "ticket",
  "token",
  "x-api-key",
];

test("secret query vocabulary mirrors the Rust contract", () => {
  assert.deepEqual([...DEEP_LINK_SECRET_QUERY_KEYS], SENSITIVE_QUERY_KEYS_LOCK);
  assert.deepEqual(
    [...SENSITIVE_QUERY_KEYS_LOCK].sort(),
    SENSITIVE_QUERY_KEYS_LOCK,
    "the canonical list stays sorted",
  );
});

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
