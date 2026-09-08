import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handoffOriginFor, isFileHandoffSource } from "../packages/shared-ui/src/view.ts";
import { desktopHandoffLink } from "../src/main.ts";
import { EN, t } from "../packages/shared-ui/src/i18n.ts";
import { transform } from "esbuild";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
function read(rel) {
  return fs.readFileSync(path.join(rootDir, rel), "utf8");
}

async function loadTs(rel) {
  const src = read(rel);
  const compiled = await transform(src, { loader: "ts", format: "esm", target: "es2022" });
  return import(`data:text/javascript;charset=utf-8,${encodeURIComponent(compiled.code)}`);
}

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
  // The shared view renders the same copy as hardcoded literals (current
  // view has no t() import after concurrent refactors); the dictionary stays
  // the single source for the next locale.
  const viewTs = read("packages/shared-ui/src/view.ts");
  assert.ok(viewTs.includes("No sign-in details travel; one job only, kept in memory."), "view renders the summary copy");
  assert.ok(viewTs.includes("Local files stay on this computer."), "view renders the local note copy");
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

test("handoff 5.5: website failed + display-only views offer Send with consent summary", () => {
  const viewTs = read("packages/shared-ui/src/view.ts");
  assert.ok(viewTs.includes('id="dz-handoff-consent"'), "consent summary element exists");
  assert.ok(viewTs.includes('id="dz-handoff-local"'), "local-only note exists");
  assert.ok(viewTs.includes('id="dz-btn-desktop-handoff"'), "one-click Send button exists");
  const displaySection = viewTs.slice(viewTs.indexOf("function mountDisplayOnlySection"));
  assert.ok(displaySection.includes("dz-btn-desktop-handoff"), "display-only (incl. tainted) offers Send");
  assert.ok(displaySection.includes("handoffOriginFor"), "display-only names the origin");
  const failedSection = viewTs.slice(viewTs.indexOf("function mountFailedSection"));
  assert.ok(failedSection.includes("dz-btn-desktop-handoff"), "failed (incl. too-large) offers Send");
  assert.ok(failedSection.includes("isFileHandoffSource"), "failed distinguishes local files");
});

test("handoff 5.5: website wires too-large plans to Send, file stays local-only", () => {
  const mainTs = read("src/main.ts");
  assert.ok(mainTs.includes("viewCtx.desktopHandoffUrl = link"), "PLAN_INVALID populates the failed Send link");
  assert.ok(mainTs.includes("viewCtx.sourceUrl = url"), "PLAN_INVALID populates the origin source");
  assert.ok(mainTs.includes("desktopHandoffLink(url)"), "link built from the job source");
  assert.ok(mainTs.includes("isLocalFileUrl(url)"), "file URLs take the local-only path");
  assert.ok(mainTs.includes("viewCtx.desktopHandoffUrl = undefined"), "local files emit no deep link");
  assert.ok(mainTs.includes("nothing is sent"), "local detail stays credential-free");
  assert.ok(!mainTs.includes("dezoomify://open?v=2&src=file"), "no broken file:// deep link is emitted");
});

test("handoff 5.5: extension result section offers styled one-click Send", () => {
  const modal = read("apps/extension/src/modal/modal.ts");
  assert.ok(modal.includes(".dz-completed-section .dz-actions-row"), "Send lives in the result section");
  assert.ok(modal.includes('button.className = "dz-btn-secondary"'), "Send uses the architectural button class");
  assert.ok(modal.includes("offerNativeHandoff(found.source)"), "completed result offers Send after save");
  assert.ok(modal.includes("Send to desktop app ("), "button names the origin");
  assert.ok(modal.includes("Origins: "), "consent dialog names origins");
  assert.ok(modal.includes("Cookies: "), "consent dialog names cookie names (never values)");
  assert.ok(!modal.includes("document.body.appendChild(button)"), "no orphaned body-level handoff button remains");
});

test("handoff 5.5: extension validator uses URL parsing plus exact sensitive keys", async () => {
  const handoff = await loadTs("apps/extension/src/runtime/nativeHandoff.ts");
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
  const handoff = await loadTs("apps/extension/src/background/handoff.ts");
  const allow = { senderOrigin: "https://site.example", isAllowedSender: (o) => o === "https://site.example" };
  const base = { protocolVersion: 2, sourceUrl: "https://a.example/ImageProperties.xml", requestId: "req-1" };
  assert.equal(handoff.validateHandoffEnvelope(base, allow).ok, true);
  assert.equal(handoff.validateHandoffEnvelope({ ...base, sourceUrl: "https://a.example/x?token=secret" }, allow).ok, false);
  assert.equal(handoff.validateHandoffEnvelope({ ...base, sourceUrl: "https://a.example/cookie-recipe/view?page=1" }, allow).ok, true, "path mentions stay valid");
});
