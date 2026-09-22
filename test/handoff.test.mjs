import assert from "node:assert/strict";
import test from "node:test";
import { validateDeepLinkPayload } from "../apps/desktop/src/errorCopy.ts";
import { desktopHandoffLink } from "../packages/browser-runtime/src/plan-gates.ts";
import { EN, t } from "../packages/shared-ui/src/i18n.ts";
import { presentFailure, presentStatus } from "../packages/shared-ui/src/snapshot-view.ts";
import {
  handoffOriginFor,
  isFileHandoffSource,
  renderView,
} from "../packages/shared-ui/src/view.tsx";
import { act } from "./react-dom.mjs";

test("deep-link copy names the destination and source origin", () => {
  for (const key of ["view.handoff.send", "view.handoff.sendOrigin", "view.handoff.localNote"]) {
    assert.ok(Object.hasOwn(EN, key), `dictionary covers ${key}`);
    assert.ok(String(EN[key]).length > 0, `${key} non-empty`);
  }
  const label = t("view.handoff.sendOrigin", { origin: "https://example.com/" });
  assert.ok(label.includes("https://example.com/"), "button names the origin");
});

test("handoff 5.5: origin helper is redacted origins-only, file-aware, exact-match", () => {
  assert.equal(
    handoffOriginFor(
      "dezoomify://open?v=2&src=https%3A%2F%2Fexample.com%2Fx",
      "https://example.com/x",
    ),
    "https://example.com/",
  );
  assert.equal(
    handoffOriginFor("", "https://example.com:8080/view?page=1"),
    "https://example.com:8080/",
  );
  assert.equal(
    handoffOriginFor("dezoomify://open?v=2&src=https%3A%2F%2Fexample.com%2Fx", undefined),
    "https://example.com/",
  );
  assert.equal(
    handoffOriginFor("", "file:///tmp/image.dzi"),
    "",
    "local files carry no origin link",
  );
  assert.equal(handoffOriginFor("not a link", "not a url"), "", "unparseable input yields no link");
  assert.equal(isFileHandoffSource("file:///tmp/a.dzi"), true);
  assert.equal(isFileHandoffSource("https://example.com/x"), false);
});

test("desktop deep link is accepted by the receiver's actual validator", () => {
  const source = "https://example.com/view?page=1";
  const link = desktopHandoffLink(source);
  assert.ok(link.startsWith("dezoomify://open?v=2&src="), "http(s) sources get a deep link");
  assert.deepEqual(validateDeepLinkPayload({ source_url: link }), {
    sourceUrl: source,
    hint: null,
    version: 2,
  });
  assert.equal(desktopHandoffLink("file:///tmp/a.dzi"), "", "local files get no deep link");
  assert.equal(desktopHandoffLink("not a url"), "", "unparseable input gets no link");
  assert.equal(desktopHandoffLink("ftp://example.com/x"), "", "non-http(s) gets no link");
  assert.equal(
    desktopHandoffLink("https://example.com/item?token=secret"),
    "",
    "secret-bearing URLs never reach the OS handler",
  );
  assert.equal(
    desktopHandoffLink(`https://example.com/${"x".repeat(2048)}`),
    "",
    "oversized sources get no link",
  );
});

test("desktop deep-link validation rejects sensitive or local sources", () => {
  for (const sourceUrl of [
    "https://example.com/item?token=secret",
    "https://example.com/item?APIKEY=secret",
    "https://user:pass@example.com/item",
    "file:///etc/passwd",
    "https://example.com/item#token=secret",
  ]) {
    assert.equal(validateDeepLinkPayload({ source_url: sourceUrl, version: 2 }), null, sourceUrl);
  }
  assert.ok(
    validateDeepLinkPayload({
      source_url: "https://example.com/cookie-recipe/view?page=1",
      version: 2,
    }),
    "path mentions do not count as sensitive query keys",
  );
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

test("failed and display-only views offer the desktop deep link", () => {
  const link = desktopHandoffLink("https://example.com/view?page=1");
  assert.ok(
    link.startsWith("dezoomify://open?v=2&src="),
    "test precondition: http(s) source links",
  );

  const el = renderContainer();
  act(() =>
    renderView(el, failedState, viewCallbacks, {
      sourceUrl: "https://example.com/view?page=1",
      desktopHandoffUrl: link,
    }),
  );
  const send = el.querySelector("#dz-btn-desktop-handoff");
  assert.ok(send, "failed view offers Send");
  assert.equal(send.getAttribute("href"), link);
  assert.ok(send.textContent.includes("https://example.com/"), "Send button names the origin");
  const displayOnly = renderContainer();
  act(() =>
    renderView(
      displayOnly,
      presentStatus("display-only", { transport: "browser-session" }),
      viewCallbacks,
      {
        sourceUrl: "https://example.com/view?page=1",
        desktopHandoffUrl: link,
      },
    ),
  );
  assert.ok(
    displayOnly.querySelector("#dz-btn-desktop-handoff"),
    "display-only (incl. tainted) offers Send",
  );
});

test("local files stay local-only, never a deep link", () => {
  const el = renderContainer();
  act(() =>
    renderView(el, failedState, viewCallbacks, {
      sourceUrl: "file:///tmp/a.dzi",
      desktopHandoffUrl: "",
    }),
  );
  assert.equal(el.querySelector("#dz-btn-desktop-handoff"), null, "local files get no Send button");
  assert.ok(el.querySelector("#dz-handoff-local"), "local-only note exists");
});
