import test from "node:test";
import assert from "node:assert/strict";
import { handoffOriginFor, isFileHandoffSource } from "../packages/shared-ui/src/view.tsx";
import { desktopHandoffLink } from "../src/main.ts";
import { EN, t } from "../packages/shared-ui/src/i18n.ts";
import { act } from "./react-dom.mjs";
import { renderView } from "../packages/shared-ui/src/view.tsx";
import { presentFailure, presentStatus } from "../packages/shared-ui/src/snapshot-view.ts";
import * as runtimeHandoff from "../apps/extension/src/runtime/nativeHandoff.ts";
import * as backgroundHandoff from "../apps/extension/src/background/handoff.ts";

test("handoff 5.5: one-click Send copy names origin/scope with memory-only note", () => {
  for (const key of [
    "view.handoff.send",
    "view.handoff.sendOrigin",
    "view.handoff.summary",
    "view.handoff.localNote",
  ]) {
    assert.ok(Object.hasOwn(EN, key), `dictionary covers ${key}`);
    assert.ok(String(EN[key]).length > 0, `${key} non-empty`);
  }
  const summary = t("view.handoff.summary", { origin: "https://example.com/" });
  assert.ok(summary.includes("https://example.com/"), "summary names the origin");
  assert.ok(summary.includes("No sign-in details"), "summary names the non-secret scope");
  assert.ok(summary.includes("one job only"), "summary names single-use scope");
  assert.ok(summary.includes("memory"), "summary names memory-only");
  const label = t("view.handoff.sendOrigin", { origin: "https://example.com/" });
  assert.ok(label.includes("https://example.com/"), "button names the origin");
});

test("handoff 5.5: origin helper is redacted origins-only, file-aware, exact-match", () => {
  assert.equal(handoffOriginFor("dezoomify://open?v=2&src=https%3A%2F%2Fexample.com%2Fx", "https://example.com/x"), "https://example.com/");
  assert.equal(handoffOriginFor("", "https://example.com:8080/view?page=1"), "https://example.com:8080/");
  assert.equal(handoffOriginFor("dezoomify://open?v=2&src=https%3A%2F%2Fexample.com%2Fx", undefined), "https://example.com/");
  assert.equal(handoffOriginFor("", "file:///tmp/image.dzi"), "", "local files carry no origin link");
  assert.equal(handoffOriginFor("not a link", "not a url"), "", "unparseable input yields no link");
  assert.equal(isFileHandoffSource("file:///tmp/a.dzi"), true);
  assert.equal(isFileHandoffSource("https://example.com/x"), false);
});

test("handoff 5.5: desktop link carries bounded http(s) only, never file or credentials", () => {
  const link = desktopHandoffLink("https://example.com/view?page=1");
  assert.ok(link.startsWith("dezoomify://open?v=2&src="), "http(s) sources get a deep link");
  assert.equal(desktopHandoffLink("file:///tmp/a.dzi"), "", "local files get no deep link");
  assert.equal(desktopHandoffLink("not a url"), "", "unparseable input gets no link");
  assert.equal(desktopHandoffLink("ftp://example.com/x"), "", "non-http(s) gets no link");
});

function renderContainer() {
  const el = globalThis.document.createElement("div");
  globalThis.document.body.appendChild(el);
  return el;
}

const viewCallbacks = {
  onSubmitUrl: () => {},
  onCancel: () => {},
  onReset: () => {},
  onSave: () => {},
};

const failedState = presentFailure(
  {
    code: "PLAN_INVALID",
    category: "engine",
    retryable: false,
    message: "This picture is too large for a browser tab.",
  },
  "direct",
);

test("handoff 5.5: failed and display-only views offer Send with consent summary", () => {
  const link = desktopHandoffLink("https://example.com/view?page=1");
  assert.ok(link.startsWith("dezoomify://open?v=2&src="), "test precondition: http(s) source links");

  const el = renderContainer();
  act(() => renderView(el, failedState, viewCallbacks, {
    sourceUrl: "https://example.com/view?page=1",
    desktopHandoffUrl: link,
  }));
  const send = el.querySelector("#dz-btn-desktop-handoff");
  assert.ok(send, "failed view offers Send");
  assert.equal(send.getAttribute("href"), link);
  assert.ok(send.textContent.includes("https://example.com/"), "Send button names the origin");
  const consent = el.querySelector("#dz-handoff-consent");
  assert.ok(consent, "consent summary element exists");
  assert.ok(consent.textContent.includes("https://example.com/"), "consent summary names the origin");

  const displayOnly = renderContainer();
  act(() => renderView(displayOnly, presentStatus("display-only", { transport: "browser-session" }), viewCallbacks, {
    sourceUrl: "https://example.com/view?page=1",
    desktopHandoffUrl: link,
  }));
  assert.ok(displayOnly.querySelector("#dz-btn-desktop-handoff"), "display-only (incl. tainted) offers Send");
});

test("handoff 5.5: local files stay local-only, never a deep link", () => {
  const el = renderContainer();
  act(() => renderView(el, failedState, viewCallbacks, {
    sourceUrl: "file:///tmp/a.dzi",
    desktopHandoffUrl: "",
  }));
  assert.equal(el.querySelector("#dz-btn-desktop-handoff"), null, "local files get no Send button");
  assert.ok(el.querySelector("#dz-handoff-local"), "local-only note exists");
});

test("handoff 5.5: extension validator uses URL parsing plus exact sensitive keys", async () => {
  const handoff = runtimeHandoff;
  assert.equal(handoff.validateHandoffSource("https://example.com/cookie-recipe/view?page=1").ok, true, "/cookie-recipe/ stays valid (no substring false positive)");
  assert.equal(handoff.validateHandoffSource("https://example.com/view?view=1&page=2").ok, true);
  assert.equal(handoff.validateHandoffSource("https://example.com/item?token=secret").ok, false);
  assert.equal(handoff.validateHandoffSource("https://example.com/item?APIKEY=secret").ok, false);
  assert.equal(handoff.validateHandoffSource("https://user:pass@example.com/item").ok, false);
  assert.equal(handoff.validateHandoffSource("file:///etc/passwd").ok, false);
  assert.equal(handoff.validateHandoffSource("https://example.com/item#token=secret").ok, false, "sensitive fragment rejected");
  assert.ok(handoff.SECRET_QUERY_KEYS.includes("access-token"), "single shared vocabulary covers access-token");
  assert.ok(handoff.SECRET_QUERY_KEYS.includes("x-api-key"), "single shared vocabulary covers x-api-key");
});

test("handoff 5.5: background envelope rejects secret-bearing source URLs", async () => {
  const handoff = backgroundHandoff;
  const allow = { senderOrigin: "https://site.example", isAllowedSender: (o) => o === "https://site.example" };
  const base = { protocolVersion: 2, sourceUrl: "https://a.example/ImageProperties.xml", requestId: "req-1" };
  assert.equal(handoff.validateHandoffEnvelope(base, allow).ok, true);
  assert.equal(handoff.validateHandoffEnvelope({ ...base, sourceUrl: "https://a.example/x?token=secret" }, allow).ok, false);
  assert.equal(handoff.validateHandoffEnvelope({ ...base, sourceUrl: "https://a.example/cookie-recipe/view?page=1" }, allow).ok, true, "path mentions stay valid");
});
