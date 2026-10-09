import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { createDiagnosticRecorder } from "../packages/shared-ui/src/diagnostics.ts";
import {
  presentFailure,
  presentIdle,
  presentOutput,
  presentProgress,
} from "../packages/shared-ui/src/presentation.ts";
import { openModal, renderView, showExtensionGuidance } from "../packages/shared-ui/src/view.tsx";
import { act, click, document, makeContainer } from "./react-dom.mjs";

const callbacks = {
  onSubmitUrl: () => {},
  onCancel: () => {},
  onReset: () => {},
  onSave: () => {},
};

function render(el, presentation, cb, ctx, options) {
  const d = createDiagnosticRecorder({
    id: "view",
    now: () => 0,
    context: { input: ctx?.sourceUrl },
  });
  if (presentation.error) d.finish("failed", presentation.error);
  act(() =>
    renderView(
      el,
      presentation,
      cb ?? callbacks,
      { diagnosticReport: d.report(), ...ctx },
      options,
    ),
  );
}

function progressPresentation(current, total) {
  return presentProgress({ phase: "acquisition", completed: current, total });
}

/** Every button must expose a non-empty accessible name (text or aria-label). */
function assertButtonsNamed(root, where) {
  const buttons = root.querySelectorAll("button");
  assert.ok(buttons.length > 0, `${where}: expected buttons to audit`);
  for (const b of buttons) {
    const name = (b.textContent || "").trim() || (b.getAttribute("aria-label") || "").trim();
    assert.ok(name.length > 0, `${where}: button without accessible name`);
  }
}

test("static accessibility contract: idle form controls are labelled and the submit action is named", () => {
  const el = makeContainer();
  render(el, presentIdle());
  const card = el.querySelector(".dz-card");
  const input = card.querySelector("#dz-url-input");
  assert.ok(input, "url input mounted");
  assert.ok(
    (input.getAttribute("aria-label") || "").length > 0,
    "url input has an accessible name",
  );
  assert.ok((input.getAttribute("placeholder") || "").length > 0, "url input keeps a visible hint");
  const clear = card.querySelector("#dz-btn-clear");
  assert.ok(clear, "clear control mounted");
  assert.ok((clear.getAttribute("aria-label") || "").length > 0, "clear control is labelled");
  assertButtonsNamed(card, "idle");
});

test("static accessibility contract: live job region announces progress with a labelled progressbar", () => {
  const el = makeContainer();
  render(el, progressPresentation(3, 12), callbacks, {
    jobActivity: {
      url: "https://museum.example.org/x",
      startedAt: 0,
      now: 3_000,
    },
  });
  const card = el.querySelector(".dz-card");
  const sec = card.querySelector(".dz-job-section");
  assert.equal(sec.getAttribute("role"), "status");
  assert.equal(sec.getAttribute("aria-live"), "polite");
  const track = card.querySelector("#dz-job-track");
  assert.equal(track.getAttribute("role"), "progressbar");
  assert.equal(track.getAttribute("aria-valuemin"), "0");
  assert.equal(track.getAttribute("aria-valuemax"), "12");
  const now = Number(track.getAttribute("aria-valuenow"));
  assert.ok(Number.isFinite(now) && now >= 0 && now <= 12, "aria-valuenow stays within bounds");
  assert.ok(
    (track.getAttribute("aria-label") || "").length > 0,
    "progressbar has an accessible name",
  );
  assert.equal(track.getAttribute("aria-valuetext"), "3 done, 0 in progress, 9 remaining");
  assertButtonsNamed(card, "job");
});

test("static accessibility contract: failed view layers guidance with named recovery actions", () => {
  const el = makeContainer();
  render(
    el,
    presentFailure({
      code: "X",
      phase: "discovery",
      retryable: true,
      message: "No zoomable image could be found.",
    }),
    callbacks,
    { sourceUrl: "https://museum.example.org/viewer?page=1" },
  );
  const card = el.querySelector(".dz-card");
  assert.ok(
    (card.querySelector("#dz-error-message").textContent || "").length > 0,
    "error message slot is populated",
  );
  assertButtonsNamed(card, "failed");
  const report = card.querySelector(".dz-details a");
  assert.ok(report, "bug-report path stays reachable from the failed view");
  const href = report.getAttribute("href") || "";
  const parsed = new URL(href);
  assert.equal(
    `${parsed.origin}${parsed.pathname}`,
    "https://github.com/lovasoa/dezoomify/issues/new",
  );
  const body = parsed.searchParams.get("body") || "";
  assert.ok(
    body.includes("https://museum.example.org/viewer?page=1"),
    "body carries the source address",
  );
  assert.ok(body.includes("No zoomable image could be found."), "body carries the discovery error");
  assert.ok(body.includes('"code": "X"'), "body carries the full error in the code block");
});

test("native completion opens saved output without browser save guidance", () => {
  const el = makeContainer();
  render(
    el,
    presentOutput({
      disposition: "native-publication",
      format: "png",

      canvas: { width: 100, height: 80 },
    }),
    { ...callbacks, onOpenOutput() {}, onRevealOutput() {} },
  );
  assert.equal(el.querySelector("#dz-btn-save"), null);
  assert.equal(el.querySelector("#dz-btn-open").textContent.trim(), "Open image");
  assert.equal(el.querySelector("#dz-btn-reveal").textContent.trim(), "Show in folder");
  assert.equal(el.querySelector(".dz-completed-title").textContent.trim(), "Image saved");
  assert.doesNotMatch(
    el.querySelector(".dz-completed-guidance").textContent,
    /browser|color profile/i,
  );
});

test("recent pictures prefill and focus the URL field without submitting, even after edits", () => {
  const el = makeContainer();
  const entry = { url: "https://museum.example/image", origin: "https://museum.example", at: 1 };
  let submitted = false;
  render(
    el,
    presentIdle(),
    {
      ...callbacks,
      onSubmitUrl() {
        submitted = true;
      },
    },
    { history: [entry] },
  );
  const button = el.querySelector(".dz-history-main");
  assert.equal(button.tagName, "BUTTON");
  const input = el.querySelector("#dz-url-input");
  let focused = false;
  input.focus = () => {
    focused = true;
  };
  input.value = "https://other.example/edited";
  click(button);
  assert.equal(input.value, entry.url);
  assert.equal(focused, true);
  assert.equal(el.querySelector("#dz-btn-clear").style.display, "flex");
  input.value = "https://other.example/another-edit";
  click(button);
  assert.equal(input.value, entry.url);
  assert.equal(submitted, false);
});

test("recent table separates metadata and removes just the requested row", () => {
  const el = makeContainer();
  const entries = [
    {
      url: "https://museum.example/image",
      origin: "https://museum.example",
      at: 0,
      title: "A painting",
      width: 1200,
      height: 800,
      status: "failed",
    },
    { url: "https://museum.example/unknown", origin: "https://museum.example", at: 1 },
  ];
  let removed;
  render(
    el,
    presentIdle(),
    {
      ...callbacks,
      onRemoveHistory(entry) {
        removed = entry;
      },
    },
    { history: entries, historyNow: 120_000 },
  );
  const rows = el.querySelectorAll("tbody tr");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].querySelector(".dz-history-main").textContent, "A painting");
  assert.equal(rows[0].querySelector(".dz-history-main").title, entries[0].url);
  assert.match(rows[0].textContent, /2 minutes ago/);
  assert.match(rows[0].textContent, /1200 × 800/);
  assert.match(rows[0].textContent, /Failed/);
  assert.equal(rows[1].querySelector(".dz-history-main").textContent, entries[1].url);
  assert.equal(
    rows[1].querySelectorAll("td")[3].textContent,
    "–",
    "unknown outcomes remain neutral",
  );
  assertButtonsNamed(el, "recent pictures");
  click(rows[0].querySelector(".dz-history-remove"));
  assert.equal(removed, entries[0]);
  assert.equal(el.querySelector("#dz-url-input").value, "");
});

test("idle product content renders between the URL input and recent pictures", () => {
  const el = makeContainer();
  render(
    el,
    presentIdle(),
    callbacks,
    { history: [{ url: "https://museum.example/image", origin: "https://museum.example", at: 1 }] },
    { idleBeforeHistory: createElement("section", { id: "product-settings" }) },
  );
  assert.equal(el.querySelector("#product-settings").nextElementSibling.id, "dz-history");
  assert.ok(
    el.querySelector("#product-settings").previousElementSibling.querySelector("#dz-url-input"),
  );
});

test("confirmed saves name the output and never offer another save", () => {
  for (const disposition of ["native-publication", "browser-save-initiated"]) {
    const el = makeContainer();
    render(
      el,
      presentOutput({
        disposition,
        format: "png",

        canvas: { width: 100, height: 80 },
      }),
      callbacks,
    );
    assert.equal(el.querySelector(".dz-completed-title").textContent, "Image saved");
    assert.equal(el.querySelector("#dz-btn-save"), null);
    assertButtonsNamed(el, disposition);
  }
});

test("static accessibility contract: completed and display-only views keep every action named", () => {
  const done = makeContainer();
  render(
    done,
    presentOutput({
      disposition: "browser-save-ready",
      format: "png",

      canvas: { width: 100, height: 80 },
    }),
    callbacks,
  );
  assert.ok(done.querySelector("#dz-btn-save"));
  assertButtonsNamed(done.querySelector(".dz-card"), "completed");

  const preview = makeContainer();
  render(
    preview,
    presentOutput({
      disposition: "display-only",
      format: "png",

      canvas: { width: 100, height: 80 },
    }),
    callbacks,
  );
  assert.equal(preview.querySelector("#dz-btn-save"), null);
  assertButtonsNamed(preview.querySelector(".dz-card"), "display-only");
});

test("static accessibility contract: modal dialogs are labelled, modal, and dismissible by name", () => {
  act(() => openModal(document, "Title", "Subtitle", "Body"));
  const backdrop = document.querySelector(".dz-modal-backdrop");
  assert.ok(backdrop, "modal backdrop mounted");
  assert.equal(backdrop.getAttribute("role"), "dialog");
  assert.equal(backdrop.getAttribute("aria-modal"), "true");
  const labelledBy = backdrop.getAttribute("aria-labelledby");
  assert.ok(labelledBy, "dialog names its label");
  assert.ok(backdrop.querySelector(`#${labelledBy}`), "dialog label target exists");
  assertButtonsNamed(backdrop, "modal");
});

test("static accessibility contract: extension guidance renders a labelled React dialog", () => {
  act(() => showExtensionGuidance(document));
  const backdrop = document.querySelector(".dz-modal-backdrop");
  assert.ok(backdrop, "guidance dialog mounted");
  assert.equal(backdrop.getAttribute("role"), "dialog");
  assert.equal(backdrop.getAttribute("aria-modal"), "true");
  assertButtonsNamed(backdrop, "extension guidance");
  assert.match(backdrop.textContent, /Chrome Web Store/);
});

function luminance(hex) {
  const c = hex.replace("#", "");
  const channel = (i) => {
    const v = parseInt(c.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

function contrast(fg, bg) {
  const a = luminance(fg);
  const b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

test("static accessibility contract: text and link contrast meets AA in both color schemes", () => {
  const pairs = [
    ["#1c1917", "#fcfeff", "light body text"],
    ["#44403c", "#fcfeff", "light secondary text"],
    ["#1d4ed8", "#fcfeff", "light links"],
    ["#991b1b", "#fcfeff", "light errors"],
    ["#166534", "#fcfeff", "light completion"],
    ["#ece5dd", "#181615", "dark body text"],
    ["#b8ada2", "#181615", "dark secondary text"],
    ["#acaf50", "#181615", "dark links"],
  ];
  for (const [fg, bg, label] of pairs) {
    assert.ok(
      contrast(fg, bg) >= 4.5,
      `${label} contrast ${contrast(fg, bg).toFixed(2)} below AA 4.5`,
    );
  }
});
