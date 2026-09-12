import test from "node:test";
import assert from "node:assert/strict";
import { act, click, document, makeContainer } from "./react-dom.mjs";
import {
  renderView,
  openModal,
  openConfirmModal,
  openImagePicker,
  openLevelPicker,
  showExtensionGuidance,
} from "../packages/shared-ui/src/view.tsx";

const callbacks = {
  onSubmitUrl: () => {},
  onCancel: () => {},
  onReset: () => {},
  onSave: () => {},
};

function render(el, state, cb, ctx) {
  act(() => renderView(el, state, cb ?? callbacks, ctx));
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
  render(el, { status: "idle", seq: 0, sessionId: "s1", imageCount: 0, transport: null });
  const card = el.querySelector(".dz-card");
  const input = card.querySelector("#dz-url-input");
  assert.ok(input, "url input mounted");
  assert.ok((input.getAttribute("aria-label") || "").length > 0, "url input has an accessible name");
  assert.ok((input.getAttribute("placeholder") || "").length > 0, "url input keeps a visible hint");
  const clear = card.querySelector("#dz-btn-clear");
  assert.ok(clear, "clear control mounted");
  assert.ok((clear.getAttribute("aria-label") || "").length > 0, "clear control is labelled");
  assertButtonsNamed(card, "idle");
});

test("static accessibility contract: live job region announces progress with a labelled progressbar", () => {
  const el = makeContainer();
  render(
    el,
    { status: "downloading", seq: 1, sessionId: "s1", imageCount: 0, transport: "direct" },
    callbacks,
    {
      currentProgress: { current: 3, total: 12 },
      jobActivity: { url: "https://museum.example.org/x", startedAt: Date.now() - 3000, now: Date.now() },
    },
  );
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
  assert.ok((track.getAttribute("aria-label") || "").length > 0, "progressbar has an accessible name");
  assert.equal(track.getAttribute("aria-valuetext"), "3 done, 0 in progress, 9 remaining");
  assertButtonsNamed(card, "job");
});

test("static accessibility contract: failed view layers guidance with named recovery actions", () => {
  const el = makeContainer();
  render(el, {
    status: "failed",
    seq: 1,
    sessionId: "s1",
    imageCount: 0,
    transport: "direct",
    error: { code: "X", category: "c", retryable: true, message: "No zoomable image could be found." },
  });
  const card = el.querySelector(".dz-card");
  assert.ok((card.querySelector("#dz-error-message").textContent || "").length > 0, "error message slot is populated");
  assertButtonsNamed(card, "failed");
  const report = card.querySelector(".dz-diagnostics-report");
  assert.ok(report, "bug-report path stays reachable from the failed view");
});

test("native completion opens saved output without browser save guidance", () => {
  const el = makeContainer();
  render(
    el,
    { status: "completed", seq: 1, sessionId: "s1", imageCount: 1, transport: "native" },
    { ...callbacks, onOpenOutput() {}, onRevealOutput() {} },
    { nativeSaved: { partial: false }, completedInfo: { width: 100, height: 80, mime: "image/png" } },
  );
  assert.equal(el.querySelector("#dz-btn-save"), null);
  assert.equal(el.querySelector("#dz-btn-open").textContent.trim(), "Open image");
  assert.equal(el.querySelector("#dz-btn-reveal").textContent.trim(), "Show in folder");
  assert.equal(el.querySelector(".dz-completed-title").textContent.trim(), "Image saved");
  assert.doesNotMatch(el.querySelector(".dz-completed-guidance").textContent, /browser|color profile/i);
});

test("history rows select a source without submitting it", () => {
  const el = makeContainer();
  const entry = { url: "https://museum.example/image", origin: "https://museum.example", at: 1 };
  let selected;
  let submitted = false;
  render(
    el,
    { status: "idle", seq: 1, sessionId: "s1", imageCount: 0 },
    { ...callbacks, onSubmitUrl() { submitted = true; }, onHistorySelect(value) { selected = value; } },
    { history: [entry] },
  );
  const button = el.querySelector(".dz-history-main");
  assert.equal(button.tagName, "BUTTON");
  click(button);
  assert.equal(selected, entry);
  assert.equal(submitted, false);
});

test("completion treats saved filenames as text", () => {
  const el = makeContainer();
  render(
    el,
    { status: "completed", seq: 1, sessionId: "s1", imageCount: 1 },
    callbacks,
    { savedOutput: { name: "<img src=x onerror=alert(1)>", width: 10, height: 10, doneTiles: 1, totalTiles: 1, failedTiles: 0 } },
  );
  assert.equal(el.querySelector(".dz-completed-summary").querySelector("img"), null);
});

test("static accessibility contract: completed and display-only views keep every action named", () => {
  const done = makeContainer();
  render(
    done,
    { status: "completed", seq: 1, sessionId: "s1", imageCount: 1, transport: "direct" },
    callbacks,
    { completedInfo: { width: 100, height: 80, mime: "image/png" }, originClean: true },
  );
  assertButtonsNamed(done.querySelector(".dz-card"), "completed");

  const preview = makeContainer();
  render(
    preview,
    { status: "display-only", seq: 1, sessionId: "s1", imageCount: 1, transport: "display" },
    callbacks,
    { originClean: false, desktopHandoffUrl: "dezoomify://open?v=2&src=https%3A%2F%2Fx" },
  );
  assertButtonsNamed(preview.querySelector(".dz-card"), "display-only");
});

test("static accessibility contract: modal dialogs are labelled, modal, and dismissible by name", () => {
  let backdrop;
  act(() => openModal(document, "Title", "Subtitle", "<p>Body</p>"));
  backdrop = document.querySelector(".dz-modal-backdrop");
  assert.ok(backdrop, "modal backdrop mounted");
  assert.equal(backdrop.getAttribute("role"), "dialog");
  assert.equal(backdrop.getAttribute("aria-modal"), "true");
  const labelledBy = backdrop.getAttribute("aria-labelledby");
  assert.ok(labelledBy, "dialog names its label");
  assert.ok(backdrop.querySelector(`#${labelledBy}`), "dialog label target exists");
  assertButtonsNamed(backdrop, "modal");

  act(() => {
    openImagePicker(document, {
      options: [
        { index: 0, title: "A", width: 10, height: 10, tiles: 1 },
        { index: 1, title: "B", width: 20, height: 20, tiles: 4 },
      ],
      onPick: () => {},
    });
  });
  const picker = document.querySelector(".dz-modal-backdrop");
  assert.ok(picker, "image picker mounted");
  assert.equal(picker.getAttribute("role"), "dialog");
  assert.equal(picker.getAttribute("aria-modal"), "true");
  const group = picker.querySelector(".dz-choice-group");
  assert.equal(group.getAttribute("role"), "radiogroup");
  assert.ok((group.getAttribute("aria-label") || "").length > 0, "radio group is labelled");
  assertButtonsNamed(picker, "image picker");

  act(() => {
    openLevelPicker(document, {
      options: [
        { index: 0, width: 10, height: 10, tiles: 1, fits: true },
        { index: 1, width: 20, height: 20, tiles: 4, fits: false },
      ],
      onPick: () => {},
    });
  });
  const levels = document.querySelector(".dz-modal-backdrop");
  assert.ok(levels, "level picker mounted");
  assert.equal(levels.getAttribute("role"), "dialog");
  assertButtonsNamed(levels, "level picker");
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

test("static accessibility contract: confirm dialog names its actions and focuses decline first", async () => {
  const prototype = document.defaultView.HTMLElement.prototype;
  const originalFocus = prototype.focus;
  let focused = null;
  prototype.focus = function focus() {
    focused = this;
  };
  try {
    let pending;
    act(() => {
      pending = openConfirmModal(document, {
        title: "Send to desktop app?",
        subtitle: "Host: dev.ophir.dezoomify.native_host",
        bodyLines: [
          "Origins: https://museum.example/",
          "Cookies: <img src=x>",
          "Job: job:1",
          "Nothing is sent until you confirm.",
        ],
        confirmLabel: "Send to desktop app",
        declineLabel: "Stay in extension",
      });
    });
    assert.ok(pending instanceof Promise, "consent resolves asynchronously on explicit choice");
    const backdrop = document.querySelector(".dz-modal-backdrop");
    assert.ok(backdrop, "dialog mounted");
    assert.equal(backdrop.getAttribute("role"), "dialog");
    assert.equal(backdrop.getAttribute("aria-modal"), "true");
    assert.equal(backdrop.getAttribute("aria-labelledby"), "dz-modal-title");
    assertButtonsNamed(backdrop, "confirm dialog");
    const text = backdrop.textContent;
    assert.match(text, /Send to desktop app\?/);
    assert.match(text, /Stay in extension/);
    assert.ok(text.includes("Cookies: <img src=x>"), "site-influenced lines stay literal text");
    assert.equal(focused?.textContent, "Stay in extension", "initial focus fails safe on decline");
  } finally {
    prototype.focus = originalFocus;
  }
});

function luminance(hex) {
  const c = hex.replace("#", "");
  const channel = (i) => {
    const v = parseInt(c.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
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
    assert.ok(contrast(fg, bg) >= 4.5, `${label} contrast ${contrast(fg, bg).toFixed(2)} below AA 4.5`);
  }
});
