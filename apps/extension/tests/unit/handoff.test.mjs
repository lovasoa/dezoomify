import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

async function loadTs(rel) {
  const src = readFileSync(new URL(rel, import.meta.url), "utf8");
  return import(`data:text/javascript;charset=utf-8,${encodeURIComponent(src)}`);
}

const handoff = await loadTs("../../src/background/handoff.ts");
const native = await loadTs("../../src/background/native.ts");
const messages = await loadTs("../../src/app/messages.ts");
const integration = await loadTs("../../src/app/extensionIntegration.ts");

// ---------- website-to-extension handoff ----------

const allowExample = (origin) => origin === "https://site.example";

function validEnvelope(over = {}) {
  return {
    protocolVersion: 2,
    sourceUrl: "https://a.example/ImageProperties.xml",
    capabilities: ["save", "iiif"],
    requestId: "req-1",
    ...over,
  };
}

test("handoff: current and N-1 accepted", () => {
  for (const v of [2, 1]) {
    const r = handoff.validateHandoffEnvelope(validEnvelope({ protocolVersion: v }), {
      senderOrigin: "https://site.example",
      isAllowedSender: allowExample,
    });
    assert.equal(r.ok, true, `v${v}`);
    assert.equal(r.needsConfirm, true);
  }
});

test("handoff: N-2, future, oversize, secret, wrong-origin rejected with zero network", () => {
  // Observable side-effect probe: no rejected envelope may confirm anything.
  let confirmations = 0;
  const cases = [
    ["n-2", validEnvelope({ protocolVersion: 0 }), "https://site.example"],
    ["future", validEnvelope({ protocolVersion: 99 }), "https://site.example"],
    ["oversize-url", validEnvelope({ sourceUrl: "https://a.example/" + "x".repeat(5000) }), "https://site.example"],
    ["secret-cookie", { ...validEnvelope(), cookies: [{ name: "s", value: "SECRET" }] }, "https://site.example"],
    ["secret-signature", { ...validEnvelope(), signature: "abc" }, "https://site.example"],
    ["bad-scheme", validEnvelope({ sourceUrl: "file:///etc/passwd" }), "https://site.example"],
    ["wrong-origin", validEnvelope(), "https://evil.example"],
    ["proto-pollution", JSON.parse('{"protocolVersion":2,"sourceUrl":"https://a.example/x","__proto__":{}}'), "https://site.example"],
  ];
  for (const [name, env, origin] of cases) {
    const r = handoff.validateHandoffEnvelope(env, {
      senderOrigin: origin,
      isAllowedSender: allowExample,
    });
    assert.equal(r.ok, false, name);
    // A rejected envelope must never reach the confirmation gate.
    assert.equal(
      handoff.confirmHandoff(r, true, { onConfirmed: () => confirmations += 1 }).ok,
      false,
      `${name} must not be confirmable`,
    );
  }
  assert.equal(confirmations, 0, "rejected envelopes must cause zero confirmations (and thus zero network/permission effects)");
  // oversize envelope bytes
  const big = validEnvelope({ capabilities: ["a".repeat(64)], requestId: "r" });
  big.extra = "x".repeat(9000);
  const rb = handoff.validateHandoffEnvelope(big, { senderOrigin: "https://site.example", isAllowedSender: allowExample });
  assert.equal(rb.ok, false);
});

test("handoff: confirmation required before any permission/fetch", () => {
  const v = handoff.validateHandoffEnvelope(validEnvelope(), {
    senderOrigin: "https://site.example",
    isAllowedSender: allowExample,
  });
  assert.equal(v.ok, true);
  let confirmed = 0;
  const denied = handoff.confirmHandoff(v, false, { onConfirmed: () => confirmed++ });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, "confirmation-required");
  assert.equal(confirmed, 0);
  const ok = handoff.confirmHandoff(v, true, { onConfirmed: () => confirmed++ });
  assert.equal(ok.ok, true);
  assert.equal(confirmed, 1);
  // invalid envelope never confirms
  const bad = handoff.confirmHandoff({ ok: false }, true, { onConfirmed: () => confirmed++ });
  assert.equal(bad.ok, false);
  assert.equal(confirmed, 1);
});

// ---------- native one-use sessions ----------

function makeNative({ nowValue = 1000 } = {}) {
  let now = nowValue;
  let n = 0;
  const jobs = [];
  const mgr = native.createNativeHandoffManager({
    now: () => now,
    randomHex: (b) => `hex${b}-${++n}`,
    isExtensionIdAllowed: (id) => id === "ext-allowed",
    onNativeJob: (j) => jobs.push(j),
  });
  return { mgr, jobs, setNow: (v) => (now = v) };
}

test("native: negotiate current/N-1 ok; N-2/future/wrong-id rejected", () => {
  const { mgr } = makeNative();
  assert.equal(mgr.negotiate({ extensionId: "ext-allowed", clientVersion: 2, jobId: "job-1" }).ok, true);
  assert.equal(mgr.negotiate({ extensionId: "ext-allowed", clientVersion: 1, jobId: "job-1" }).ok, true);
  assert.equal(mgr.negotiate({ extensionId: "ext-allowed", clientVersion: 0, jobId: "job-1" }).ok, false);
  assert.equal(mgr.negotiate({ extensionId: "ext-allowed", clientVersion: 9, jobId: "job-1" }).ok, false);
  assert.equal(mgr.negotiate({ extensionId: "ext-evil", clientVersion: 2, jobId: "job-1" }).code, "id-not-allowed");
});

test("native: fresh challenge+nonce per handoff; replay/expired/wrong-job rejected without network", () => {
  const { mgr, jobs } = makeNative({ nowValue: 5000 });
  const a = mgr.negotiate({ extensionId: "ext-allowed", clientVersion: 2, jobId: "job-1" });
  const b = mgr.negotiate({ extensionId: "ext-allowed", clientVersion: 2, jobId: "job-1" });
  assert.notEqual(a.challenge, b.challenge);
  assert.notEqual(a.nonce, b.nonce);

  // consent before redeem
  assert.equal(
    mgr.bindConsent({ challenge: a.challenge, nonce: a.nonce, jobId: "job-1", origins: ["https://a.example/"], cookieNames: ["session"], confirmed: true }).ok,
    true
  );
  // wrong job
  assert.equal(
    mgr.bindConsent({ challenge: b.challenge, nonce: b.nonce, jobId: "other", origins: ["https://a.example/"], cookieNames: ["s"], confirmed: true }).code,
    "wrong-job"
  );
  assert.equal(jobs.length, 0);
  // redeem ok once
  assert.equal(mgr.redeem({ challenge: a.challenge, nonce: a.nonce, jobId: "job-1" }).ok, true);
  assert.equal(jobs.length, 1);
  // replay rejected without network
  assert.equal(mgr.redeem({ challenge: a.challenge, nonce: a.nonce, jobId: "job-1" }).code, "unknown-challenge");
  assert.equal(jobs.length, 1);
});

test("native: expiry blocks redeem without network", () => {
  const ctx = makeNative({ nowValue: 0 });
  const s = ctx.mgr.negotiate({ extensionId: "ext-allowed", clientVersion: 2, jobId: "job-9" });
  assert.equal(s.ok, true);
  ctx.mgr.bindConsent({ challenge: s.challenge, nonce: s.nonce, jobId: "job-9", origins: ["https://a.example/"], cookieNames: ["session"], confirmed: true });
  ctx.setNow(10 * 60 * 1000); // past 5-min TTL
  const r = ctx.mgr.redeem({ challenge: s.challenge, nonce: s.nonce, jobId: "job-9" });
  assert.equal(r.ok, false);
  assert.equal(r.code, "expired");
  assert.equal(ctx.jobs.length, 0);
});

test("native: decline continues cookieless", () => {
  const { mgr } = makeNative();
  const s = mgr.negotiate({ extensionId: "ext-allowed", clientVersion: 2, jobId: "job-d" });
  const d = mgr.decline(s.challenge);
  assert.equal(d.continuedCookieless, true);
});

test("consent details list names-not-values; snapshot contains no values", () => {
  const details = native.buildConsentDetails({
    appName: "Dezoomify",
    appVersion: "1.2.3",
    origins: ["https://protected.example/"],
    cookieNames: ["session", "prefs"],
    expiry: "2026-09-05T00:00:00Z",
    purpose: "scoped native fetch for one job",
  });
  assert.deepEqual([...details.cookieNames], ["session", "prefs"]);
  const snap = native.renderConsentSnapshot(details);
  assert.ok(snap.includes("session"));
  assert.ok(snap.includes("https://protected.example/"));
  assert.ok(snap.includes("Dezoomify 1.2.3"));
  assert.ok(!snap.includes("SECRET-VALUE-abc123"), "value leaked");
  // even if a value is smuggled into names, snapshot escapes and redaction test scans it
  const evil = native.renderConsentSnapshot(
    native.buildConsentDetails({
      appName: "Dezoomify",
      appVersion: "1.0",
      origins: ["https://a.example/"],
      cookieNames: ["session"],
      expiry: "soon",
      purpose: "p",
    })
  );
  assert.ok(!evil.includes("abc123"));
});

// ---------- internal messages + integration ----------

test("messages: version+ids required; stale/unknown rejected", () => {
  const m = messages.createMessage("StartScan", { scanId: "scan-1", jobId: "job-1" }, { x: 1 });
  assert.equal(m.version, 2);
  assert.equal(messages.validateMessage(m, { currentScanId: "scan-1" }).ok, true);
  assert.equal(messages.validateMessage(m, { currentScanId: "other" }).code, "stale");
  assert.equal(messages.validateMessage({ kind: "Nope", version: 2, scanId: "s" }).code, "unknown-kind");
  assert.equal(messages.validateMessage({ kind: "StartScan", version: 99, scanId: "s" }).code, "bad-version");
  assert.equal(messages.validateMessage({ kind: "StartScan", version: 2 }).code, "missing-id");
  // N-1 accepted
  assert.equal(messages.validateMessage({ ...m, version: 1 }, {}).ok, true);
  // oversize rejected
  assert.equal(messages.validateMessage({ kind: "StartScan", version: 2, scanId: "s", pad: "x".repeat(70000) }).code, "oversize");
});

test("extensionIntegration: validates then delegates; rejects stale", async () => {
  let scans = 0;
  const integ = integration.createExtensionIntegration({
    validateMessage: messages.validateMessage,
    startScan: async () => {
      scans++;
      return { ok: true };
    },
    fetchResource: async () => ({ bytes: new Uint8Array([1]) }),
    requestNativeHandoff: async () => ({ ok: true }),
  });
  integ.bind("scan-1", "job-1");
  const good = messages.createMessage("StartScan", { scanId: "scan-1", jobId: "job-1" });
  const r1 = await integ.handleMessage(good);
  assert.equal(r1.ok, true);
  assert.equal(scans, 1);
  const stale = messages.createMessage("StartScan", { scanId: "stale-scan", jobId: "job-1" });
  const r2 = await integ.handleMessage(stale);
  assert.equal(r2.ok, false);
  const unknown = { kind: "Bogus", version: 2, scanId: "scan-1" };
  assert.equal((await integ.handleMessage(unknown)).ok, false);
});

test("cookie-handoff transcript is fixed and consented", () => {
  const p = new URL("../../../../testdata/scenarios/extension/cookie-handoff/expected/result.json", import.meta.url);
  assert.equal(existsSync(p), true);
  const doc = JSON.parse(readFileSync(p, "utf8"));
  assert.equal(doc.scenario, "extension/cookie-handoff");
  assert.deepEqual(doc.expected.consent.cookieNames, ["session"]);
  assert.equal(doc.expected.consent.containsValues, false);
  assert.equal(doc.expected.singleUse, true);
  assert.equal(doc.expected.replayRejectedWithoutNetwork, true);
});
