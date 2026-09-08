import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

async function loadTs(rel) {
  const src = readFileSync(new URL(rel, import.meta.url), "utf8");
  return import(`data:text/javascript;charset=utf-8,${encodeURIComponent(src)}`);
}

const handoff = await loadTs("../../src/runtime/nativeHandoff.ts");

function fakeHost({ handoffCapable = true, negotiatedVersion = 2 } = {}) {
  const calls = [];
  let challenge = "ch-1";
  let nonce = "n-1";
  let consented = false;
  const used = new Set();
  async function sendNativeMessage(msg) {
    calls.push(msg);
    if (msg.kind === "handshake") {
      return { kind: "handshake-ack", capabilities: { handoff: handoffCapable } };
    }
    if (msg.kind === "negotiate") {
      if (msg.clientVersion !== 2) return { error: { code: "protocol.incompatible" } };
      challenge = "ch-1";
      nonce = "n-1";
      consented = false;
      return { kind: "negotiated", negotiatedVersion, challenge, nonce, expiresAt: 999 };
    }
    if (msg.kind === "consent") {
      if (msg.challenge !== challenge || msg.nonce !== nonce) {
        return { error: { code: "bad-nonce" } };
      }
      if (msg.confirmed !== true) return { error: { code: "confirmation-required" } };
      consented = true;
      return { kind: "consented" };
    }
    if (msg.kind === "credential") {
      if (used.has(msg.nonce)) return { error: { code: "replay" } };
      if (!consented) return { error: { code: "consent-required" } };
      if (msg.challenge !== challenge || msg.nonce !== nonce) {
        return { error: { code: "bad-nonce" } };
      }
      used.add(msg.nonce);
      // Sibling isolation enforced host-side too.
      for (const c of msg.cookies ?? []) {
        if (!msg.origins.includes(c.origin)) return { error: { code: "bad-origins" } };
      }
      return { kind: "job-started", job: "job:native-1" };
    }
    if (msg.kind === "decline") {
      return { kind: "declined", continuedCookieless: true };
    }
    return { error: { code: "capability.unavailable" } };
  }
  return { sendNativeMessage, calls };
}

function baseArgs(over = {}) {
  const host = fakeHost();
  return {
    sourceUrl: "https://protected.example/item",
    origins: ["https://protected.example/"],
    cookieNames: ["session"],
    jobId: "job:ext-1",
    sendNativeMessage: host.sendNativeMessage,
    getCookies: async () => [{ name: "session", value: "CANARY-abc123" }],
    showConsent: async () => true,
    _host: host,
    ...over,
  };
}

test("source validation rejects secrets without native calls", async () => {
  for (const bad of [
    "file:///etc/passwd",
    "https://user:pass@example.com/x",
    "https://example.com/x?token=secret",
    "https://example.com/x?cookie=abc",
    "https://example.com/" + "a".repeat(3000),
  ]) {
    let calls = 0;
    const r = await handoff.requestNativeHandoff({
      ...baseArgs(),
      sourceUrl: bad,
      sendNativeMessage: async (m) => { calls++; return m; },
    });
    assert.equal(r.ok, false, bad);
    assert.equal(calls, 0, `secret source must cause zero native messages: ${bad}`);
    assert.equal(r.credentialSent, false);
  }
  assert.equal(handoff.validateHandoffSource("https://example.com/item").ok, true);
});

test("origins and cookie names validated before handshake", async () => {
  for (const origins of [[], ["file:///x"], ["https://user:p@example.com/"]]) {
    let calls = 0;
    const r = await handoff.requestNativeHandoff({
      ...baseArgs(),
      origins,
      sendNativeMessage: async (m) => { calls++; return m; },
    });
    assert.equal(r.ok, false);
    assert.equal(calls, 0, `bad origins must cause zero native messages: ${JSON.stringify(origins)}`);
  }
  assert.equal(handoff.validateHandoffOrigins(["https://a.example/"]).ok, true);
  assert.equal(handoff.validateHandoffCookieNames(["session"]).ok, true);
  assert.equal(handoff.validateHandoffCookieNames(["a=b"]).ok, false);
});

test("handshake without handoff support fails closed", async () => {
  const host = fakeHost({ handoffCapable: false });
  const r = await handoff.requestNativeHandoff({ ...baseArgs(), sendNativeMessage: host.sendNativeMessage });
  assert.equal(r.ok, false);
  assert.equal(r.code, "capability.unavailable");
  assert.equal(r.credentialSent, false);
  assert.equal(host.calls.length, 1, "no negotiate after failed handshake");
});

test("full consented handoff sends one credential and reports job", async () => {
  const args = baseArgs();
  let consentDetails = null;
  args.showConsent = async (details) => { consentDetails = details; return true; };
  const r = await handoff.requestNativeHandoff(args);
  assert.equal(r.ok, true);
  assert.equal(r.job, "job:native-1");
  assert.equal(r.credentialSent, true);
  // Consent UI saw names/scopes only, never values.
  assert.deepEqual([...consentDetails.cookieNames], ["session"]);
  assert.deepEqual([...consentDetails.origins], ["https://protected.example/"]);
  const snapshot = JSON.stringify({ details: consentDetails, calls: args._host.calls });
  assert.ok(!snapshot.includes("CANARY-abc123"), "value leaked into consent/calls");
  // Credential carried the value once (host-side), sibling never sent.
  const credential = args._host.calls.find((m) => m.kind === "credential");
  assert.ok(credential, "one credential message");
  assert.equal(credential.cookies.length, 1);
  assert.equal(credential.cookies[0].origin, "https://protected.example/");
  assert.ok(!args._host.calls.some((m) => JSON.stringify(m).includes("sibling.example")));
});

test("decline continues cookieless with zero credential send", async () => {
  const args = baseArgs({ showConsent: async () => false });
  let cookieReads = 0;
  args.getCookies = async () => { cookieReads++; return []; };
  const r = await handoff.requestNativeHandoff(args);
  assert.equal(r.ok, true);
  assert.equal(r.continuedCookieless, true);
  assert.equal(r.credentialSent, false);
  assert.equal(cookieReads, 0, "declined consent must not read cookies");
  assert.ok(args._host.calls.some((m) => m.kind === "decline"), "decline reported");
  assert.ok(!args._host.calls.some((m) => m.kind === "credential"), "no credential on decline");
});

test("sibling cookies rejected without credential send", async () => {
  // Direct scope check: sibling origin outside consent.
  assert.equal(
    handoff.validateCredentialCookies(
      [{ name: "session", value: "CANARY", origin: "https://sibling.example/" }],
      ["https://protected.example/"],
      ["session"],
    ).code,
    "bad-origins",
  );
  // Undisclosed cookie name outside consent.
  assert.equal(
    handoff.validateCredentialCookies(
      [{ name: "other", value: "CANARY", origin: "https://protected.example/" }],
      ["https://protected.example/"],
      ["session"],
    ).code,
    "bad-cookies",
  );
  // End-to-end: undisclosed name causes decline, no credential.
  const args = baseArgs({
    getCookies: async () => [{ name: "other", value: "CANARY" }],
  });
  const r = await handoff.requestNativeHandoff(args);
  assert.equal(r.ok, false);
  assert.equal(r.credentialSent, false);
  assert.ok(!args._host.calls.some((m) => m.kind === "credential"));
});

test("permission denial keeps job cookieless", async () => {
  const args = baseArgs({
    getCookies: async () => { throw Object.assign(new Error("denied"), { code: "permission-denied" }); },
  });
  const r = await handoff.requestNativeHandoff(args);
  assert.equal(r.ok, false);
  assert.equal(r.code, "permission-denied");
  assert.equal(r.continuedCookieless, true);
  assert.equal(r.credentialSent, false);
});

test("replay error surfaces without leaking values", async () => {
  const host = fakeHost();
  // First handoff consumes the nonce.
  const first = await handoff.requestNativeHandoff({ ...baseArgs(), sendNativeMessage: host.sendNativeMessage });
  assert.equal(first.ok, true);
  // Second credential with the same nonce is replay (host-side).
  const replay = await host.sendNativeMessage({
    kind: "credential",
    challenge: "ch-1",
    nonce: "n-1",
    jobId: "job:ext-1",
    sourceUrl: "https://protected.example/item",
    origins: ["https://protected.example/"],
    cookies: [{ name: "session", value: "CANARY", origin: "https://protected.example/" }],
  });
  assert.equal(replay.error?.code, "replay");
  assert.ok(!JSON.stringify(replay).includes("CANARY"));
});

test("consent details carry names only; drop overwrites values", async () => {
  const details = handoff.buildHandoffConsentDetails({
    origins: ["https://protected.example/"],
    cookieNames: ["session"],
    jobId: "job:1",
  });
  assert.deepEqual([...details.cookieNames], ["session"]);
  assert.ok(!JSON.stringify(details).includes("CANARY"));
  const cookies = [{ name: "session", value: "CANARY-xyz" }];
  handoff.dropCredentialValues(cookies);
  assert.equal(cookies[0].value, "");
});

test("wire shapes match the native host envelope", async () => {
  const src = readFileSync(new URL("../../src/runtime/nativeHandoff.ts", import.meta.url), "utf8");
  for (const kind of ['"handshake"', '"negotiate"', '"consent"', '"credential"', '"decline"']) {
    assert.ok(src.includes(kind), `client must speak ${kind}`);
  }
});

function fakePortHost({ disconnectAt = null, oversized = false } = {}) {
  const sent = [];
  const messageListeners = [];
  const disconnectListeners = [];
  const port = {
    sent,
    onMessage: { addListener: (fn) => messageListeners.push(fn) },
    onDisconnect: { addListener: (fn) => disconnectListeners.push(fn) },
    postMessage(message) {
      sent.push(message);
      if (disconnectAt === message.kind) { for (const fn of disconnectListeners) fn(); return; }
      const reply = oversized ? { requestId: message.requestId, pad: "x".repeat(1024 * 1024 + 1) } :
        message.kind === "handshake" ? { requestId: message.requestId, kind: "handshake-ack", capabilities: { handoff: true } } :
        message.kind === "negotiate" ? { requestId: message.requestId, kind: "negotiated", negotiatedVersion: 2, challenge: "ch-1", nonce: "n-1" } :
        message.kind === "consent" ? { requestId: message.requestId, kind: "consented" } :
        message.kind === "credential" ? { requestId: message.requestId, kind: "job-started", job: "native-job" } :
        { requestId: message.requestId, kind: "declined", continuedCookieless: true };
      queueMicrotask(() => messageListeners.forEach((fn) => fn(reply)));
    },
    disconnect() {},
  };
  return port;
}

test("persistent port carries one bound job and requestId on every exchange", async () => {
  const port = fakePortHost();
  const r = await handoff.requestNativeHandoff({
    ...baseArgs(),
    connectNative: () => port,
    job: { jobId: "job:ext-1", tabId: 7, frameId: 0, documentGeneration: "doc-1" },
  });
  assert.equal(r.ok, true);
  assert.ok(port.sent.length >= 4);
  assert.equal(new Set(port.sent.map((m) => m.requestId)).size, port.sent.length);
  assert.ok(port.sent.every((m) => m.job?.tabId === 7 && m.job?.documentGeneration === "doc-1"));
});

test("persistent port disconnect is typed at every stage and decline never reads cookies", async () => {
  for (const stage of ["handshake", "negotiate", "consent", "credential"]) {
    const port = fakePortHost({ disconnectAt: stage });
    let reads = 0;
    const r = await handoff.requestNativeHandoff({
      ...baseArgs(), connectNative: () => port,
      job: { jobId: "job:ext-1", tabId: 7, frameId: 0, documentGeneration: "doc-1" },
      getCookies: async () => { reads++; return [{ name: "session", value: "CANARY" }]; },
    });
    assert.equal(r.code, "native-disconnected", stage);
    if (stage !== "credential") assert.equal(reads, 0);
  }
});

test("persistent port rejects missing/stale binding and bounded frames", async () => {
  const port = fakePortHost();
  const base = { ...baseArgs(), connectNative: () => port };
  assert.equal((await handoff.requestNativeHandoff(base)).code, "bad-job-binding");
  assert.equal((await handoff.requestNativeHandoff({ ...base, job: { jobId: "job:ext-1", tabId: 1, frameId: 0, documentGeneration: "doc-1" }, connectNative: () => fakePortHost({ oversized: true }) })).code, "oversize");
});
