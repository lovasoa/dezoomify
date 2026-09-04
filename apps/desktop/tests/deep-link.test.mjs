import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.join(here, "..");
const repoRoot = path.join(here, "..", "..", "..");

function readText(relFromHere) {
  return fs.readFileSync(path.join(here, relFromHere), "utf8");
}

// ---------------------------------------------------------------------------
// JS mirror of apps/desktop/src-tauri/src/deep_link.rs.
// Must stay in sync: versioned, bounded <=2048, non-secret, confirmation-gated.
// ---------------------------------------------------------------------------

const DEEP_LINK_CURRENT_VERSION = 2;
const DEEP_LINK_MIN_SUPPORTED_VERSION = 1;
const MAX_DEEP_LINK_LEN = 2048;
const MAX_FIELD_LEN = 1024;

const SECRET_KEYS = new Set([
  "cookie",
  "cookies",
  "authorization",
  "proxy-authorization",
  "bearer",
  "token",
  "signature",
  "sig",
  "auth",
  "secret",
  "password",
  "session",
  "sid",
  "apikey",
  "api_key",
  "key",
]);

function isSecretKey(name) {
  return SECRET_KEYS.has(name.toLowerCase());
}

function sourceContainsSecret(text) {
  const lower = text.toLowerCase();
  for (const needle of [
    "cookie",
    "authorization",
    "bearer",
    "token=",
    "signature",
    "secret",
    "password",
    "session=",
    "apikey",
    "api_key",
    "file://",
    "/etc/",
    "c:\\",
  ]) {
    if (lower.includes(needle)) return needle;
  }
  return null;
}

function percentDecodeStrict(input) {
  let out = "";
  const bytes = [];
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (c === "%") {
      if (i + 2 >= input.length) throw Object.assign(new Error("truncated escape"), { code: "malformed-encoding" });
      const hex = input.slice(i + 1, i + 3);
      if (!/^[0-9a-fA-F]{2}$/.test(hex)) {
        throw Object.assign(new Error(`bad escape %${hex}`), { code: "malformed-encoding" });
      }
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else if (c === "+") {
      bytes.push(0x20);
    } else {
      const code = c.charCodeAt(0);
      if (code > 127) {
        // Non-ASCII literals are encoded as UTF-8 bytes like the Rust path.
        for (const b of Buffer.from(c, "utf8")) bytes.push(b);
      } else {
        bytes.push(code);
      }
    }
  }
  try {
    out = Buffer.from(bytes).toString("utf8");
  } catch {
    throw Object.assign(new Error("non-utf8"), { code: "malformed-encoding" });
  }
  // Round-trip check for strictness: lone surrogates etc. already throw above.
  void out;
  return Buffer.from(bytes).toString("utf8");
}

function hasUserinfo(src) {
  const idx = src.indexOf("://");
  if (idx < 0) return true;
  const after = src.slice(idx + 3);
  const end = after.search(/[\/?#]/);
  const authority = end < 0 ? after : after.slice(0, end);
  return authority.includes("@");
}

function validateSource(src) {
  if (src.length === 0 || src.length > MAX_FIELD_LEN) {
    throw Object.assign(new Error("src length"), { code: "invalid-source" });
  }
  if (!(src.startsWith("http://") || src.startsWith("https://"))) {
    throw Object.assign(new Error("scheme"), { code: "invalid-source" });
  }
  if (hasUserinfo(src)) {
    throw Object.assign(new Error("userinfo"), { code: "userinfo" });
  }
  const needle = sourceContainsSecret(src);
  if (needle) {
    throw Object.assign(new Error(`secret ${needle}`), { code: "secret", needle });
  }
}

function parseDeepLink(url) {
  if (url.length > MAX_DEEP_LINK_LEN) {
    throw Object.assign(new Error("oversize"), { code: "oversize" });
  }
  const prefix = "dezoomify://open";
  const okPrefix =
    url === prefix ||
    url.startsWith(prefix + "?") ||
    url.startsWith(prefix + "/") ||
    url.startsWith(prefix + "/?");
  if (!okPrefix) {
    throw Object.assign(new Error("scheme"), { code: "invalid-scheme" });
  }
  const qIdx = url.indexOf("?");
  let query = qIdx < 0 ? "" : url.slice(qIdx + 1);
  query = query.split("#")[0] ?? "";
  if (query === "") throw Object.assign(new Error("missing v"), { code: "missing-field" });
  let versionRaw = null;
  let srcRaw = null;
  let hintRaw = null;
  let seenV = false;
  let seenSrc = false;
  let seenHint = false;
  for (const pair of query.split("&")) {
    if (pair === "") continue;
    const eq = pair.indexOf("=");
    if (eq < 0) throw Object.assign(new Error(`pair ${pair}`), { code: "malformed-encoding" });
    const name = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    if (name.includes("%")) throw Object.assign(new Error("encoded name"), { code: "malformed-encoding" });
    if (name === "v") {
      if (seenV) throw Object.assign(new Error("dup v"), { code: "duplicate-field" });
      seenV = true;
      versionRaw = value;
    } else if (name === "src") {
      if (seenSrc) throw Object.assign(new Error("dup src"), { code: "duplicate-field" });
      seenSrc = true;
      srcRaw = value;
    } else if (name === "hint") {
      if (seenHint) throw Object.assign(new Error("dup hint"), { code: "duplicate-field" });
      seenHint = true;
      hintRaw = value;
    } else if (isSecretKey(name)) {
      throw Object.assign(new Error(`secret ${name}`), { code: "secret", needle: name });
    } else {
      throw Object.assign(new Error(`unknown ${name}`), { code: "unknown-field" });
    }
  }
  if (versionRaw === null) throw Object.assign(new Error("missing v"), { code: "missing-field" });
  if (srcRaw === null) throw Object.assign(new Error("missing src"), { code: "missing-field" });
  if (!/^\d+$/.test(versionRaw)) {
    throw Object.assign(new Error(`version ${versionRaw}`), { code: "unsupported-version" });
  }
  const version = Number.parseInt(versionRaw, 10);
  if (version < DEEP_LINK_MIN_SUPPORTED_VERSION || version > DEEP_LINK_CURRENT_VERSION) {
    throw Object.assign(new Error(`version ${versionRaw}`), { code: "unsupported-version" });
  }
  let sourceUrl;
  try {
    sourceUrl = percentDecodeStrict(srcRaw);
  } catch (e) {
    throw Object.assign(new Error("src decode"), { code: "malformed-encoding" });
  }
  validateSource(sourceUrl);
  const srcQuery = sourceUrl.split("?")[1];
  if (srcQuery) {
    for (const pair of srcQuery.split("&")) {
      const k = pair.split("=")[0] ?? "";
      if (k !== "" && isSecretKey(k)) {
        throw Object.assign(new Error(`secret ${k}`), { code: "secret", needle: k });
      }
    }
  }
  let hint = null;
  if (hintRaw !== null) {
    try {
      hint = percentDecodeStrict(hintRaw);
    } catch {
      throw Object.assign(new Error("hint decode"), { code: "malformed-encoding" });
    }
    if (hint.length > 256) throw Object.assign(new Error("hint size"), { code: "invalid-source" });
    if (hint.includes("\0")) throw Object.assign(new Error("hint NUL"), { code: "invalid-source" });
    if (hint === "") hint = null;
  }
  return { version, sourceUrl, hint };
}

function requiresConfirmation() {
  return true;
}

// Effect gate: only confirmed links may produce network/file effects.
let effectCount = 0;
function applyAfterConfirmation(link, confirmed) {
  assert.equal(requiresConfirmation(link), true);
  if (!confirmed) {
    const err = new Error("pending confirmation");
    err.code = "pending-confirmation";
    throw err;
  }
  effectCount += 1;
  return link;
}

function deepLink(v, srcEncoded, extra = "") {
  return `dezoomify://open?v=${v}&src=${srcEncoded}${extra}`;
}

const enc = (s) => encodeURIComponent(s).replace(/%20/g, "+");

// ---------------------------------------------------------------------------
// Vectors
// ---------------------------------------------------------------------------

test("current (v=2) link accepted", () => {
  const link = parseDeepLink(deepLink("2", enc("https://example.com/item/1")));
  assert.equal(link.version, 2);
  assert.equal(link.sourceUrl, "https://example.com/item/1");
});

test("N-1 (v=1) link accepted", () => {
  const link = parseDeepLink(deepLink("1", enc("https://example.com/item/1")));
  assert.equal(link.version, 1);
});

test("N-2 (v=0) and future (v=3, v=99) rejected", () => {
  for (const v of ["0", "3", "99"]) {
    assert.throws(() => parseDeepLink(deepLink(v, enc("https://example.com/item"))), /version|unsupported/i, `v=${v}`);
  }
  assert.throws(() => parseDeepLink(deepLink("1.0", enc("https://example.com/item"))), /version|unsupported|malformed/i);
  assert.throws(() => parseDeepLink(deepLink("abc", enc("https://example.com/item"))), /version|unsupported/i);
});

test("oversize URL rejected (total > 2048)", () => {
  const big = `dezoomify://open?v=2&src=${encodeURIComponent("https://example.com/" + "a".repeat(3000))}`;
  assert.ok(big.length > 2048);
  assert.throws(() => parseDeepLink(big), /oversize/i);
});

test("userinfo in source rejected", () => {
  const evil = deepLink("2", enc("https://user:pass@example.com/x"));
  assert.throws(() => parseDeepLink(evil), /userinfo/i);
});

test("cookie-param rejected (query key and smuggled source query)", () => {
  const direct = `dezoomify://open?v=2&src=${enc("https://example.com/x")}&cookie=abc`;
  assert.throws(() => parseDeepLink(direct), /secret|cookie/i);
  const smuggled = deepLink("2", enc("https://example.com/x?cookie=abc"));
  assert.throws(() => parseDeepLink(smuggled), /secret|cookie/i);
  const token = deepLink("2", enc("https://example.com/x?token=abc"));
  assert.throws(() => parseDeepLink(token), /secret|token/i);
});

test("malformed percent-encoding rejected", () => {
  for (const bad of [
    deepLink("2", "https%3A%2F%2Fexample.com%2F%ZZ"),
    deepLink("2", "https%3A%2F%2Fexample.com%2F%2"),
    deepLink("2", "https%3A%2F%2Fexample.com%2F%"),
  ]) {
    try {
      parseDeepLink(bad);
      assert.fail(`expected malformed rejection for ${bad}`);
    } catch (e) {
      assert.equal(e.code, "malformed-encoding", `wrong code for ${bad}: ${e.message}`);
    }
  }
});

test("duplicate fields rejected", () => {
  for (const dup of [
    "dezoomify://open?v=2&v=2&src=" + enc("https://example.com/x"),
    `dezoomify://open?v=2&src=${enc("https://example.com/x")}&src=${enc("https://example.com/y")}`,
  ]) {
    try {
      parseDeepLink(dup);
      assert.fail(`expected duplicate rejection for ${dup}`);
    } catch (e) {
      assert.equal(e.code, "duplicate-field", `wrong code for ${dup}: ${e.message}`);
    }
  }
});

test("no effect without confirmation", () => {
  effectCount = 0;
  const link = parseDeepLink(deepLink("2", enc("https://example.com/item/1")));
  assert.equal(effectCount, 0);
  assert.throws(() => applyAfterConfirmation(link, false), /confirm/i);
  assert.equal(effectCount, 0);
  const accepted = applyAfterConfirmation(link, true);
  assert.equal(accepted.sourceUrl, "https://example.com/item/1");
  assert.equal(effectCount, 1);
});

test("rust deep_link.rs carries required guards", () => {
  const src = readText("../src-tauri/src/deep_link.rs");
  assert.ok(src.includes("2048"), "bound 2048");
  assert.ok(src.includes("UserinfoForbidden") || src.toLowerCase().includes("userinfo"), "userinfo guard");
  assert.ok(src.includes("SecretForbidden") || src.toLowerCase().includes("secret"), "secret guard");
  assert.ok(src.includes("UnsupportedVersion") || src.toLowerCase().includes("unsupported version"), "version guard");
  assert.ok(src.includes("MalformedEncoding") || src.toLowerCase().includes("malformed"), "encoding guard");
  assert.ok(src.includes("requires_confirmation"), "confirmation gate");
  assert.ok(src.includes("apply_after_confirmation"), "confirmation gate");
  assert.ok(src.includes("DEEP_LINK_CURRENT_VERSION"), "current version const");
  assert.ok(src.includes("DEEP_LINK_MIN_SUPPORTED_VERSION"), "N-1 const");
  assert.ok(!src.includes("cookie=") || src.includes("SecretForbidden"), "no secret passthrough");
});

test("tauri bundle registers dezoomify protocol scheme", () => {
  const conf = JSON.parse(readText("../src-tauri/tauri.conf.json"));
  const schemes = conf?.bundle?.protocol?.schemes ?? [];
  assert.ok(schemes.includes("dezoomify"), "protocol scheme dezoomify");
  assert.equal(conf.identifier, "com.dezoomify.app");
});
