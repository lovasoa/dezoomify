import test from "node:test";
import assert from "node:assert/strict";
import { createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { act, click, document, makeContainer } from "../../../test/react-dom.mjs";
import { DesktopJobView } from "../src/desktopView.tsx";
import { DesktopSettingsView } from "../src/settingsView.tsx";
import { defaultSettings } from "../src/settings.ts";

function props(overrides = {}) {
  return {
    status: "downloading",
    decision: null,
    format: "png",
    queue: { activeId: "jobq:0", nextId: 2, entries: [
      { id: "jobq:0", inputUrl: "https://one.example/image", origin: "https://one.example", status: "active", progress: { acquired: 2, total: 5 } },
      { id: "jobq:1", inputUrl: "https://two.example/image", origin: "https://two.example", status: "queued", progress: { acquired: 0, total: 0 } },
    ] },
    queueEnabled: true,
    completedPartial: false,
    completedMissing: [],
    completedSibling: null,
    onFormatChange() {},
    onChooseOutput() {},
    onRecoveryRetry() {},
    onPartialChoice() {},
    onQueueCancel() {},
    onQueueRetry() {},
    onQueueCancelAll() {},
    ...overrides,
  };
}

function mount(initial) {
  const container = makeContainer();
  const root = createRoot(container);
  act(() => root.render(createElement(DesktopJobView, initial)));
  return { container, root };
}

test("desktop queue and recovery controls render through React callbacks", () => {
  const cancelled = [];
  let selectedFormat = null;
  let choseOutput = false;
  const initial = props({
    decision: { kind: "destination-recovery", reason: "destination" },
    onQueueCancel(id) { cancelled.push(id); },
    onFormatChange(format) { selectedFormat = format; },
    onChooseOutput() { choseOutput = true; },
  });
  const { container } = mount(initial);
  assert.ok(container.querySelector("#dz-desktop-job-panel"));
  assert.equal(container.querySelectorAll(".dz-queue-item").length, 2);
  click(container.querySelector('input[value="jpeg"]'));
  assert.equal(selectedFormat, "jpeg");
  click(container.querySelector(".dz-recovery-dialog .dz-btn-tactile"));
  assert.equal(choseOutput, true);
  click(container.querySelector(".dz-queue-item .dz-btn-secondary"));
  assert.deepEqual(cancelled, ["jobq:0"]);
});

test("desktop partial completion and output errors are declarative", () => {
  const initial = props({
    status: "completed",
    queue: { activeId: null, nextId: 0, entries: [] },
    completedPartial: true,
    completedMissing: ["3,4"],
    completedSibling: "image.partial.png",
    outputActionError: { action: "folder", code: "output.launch-failed" },
  });
  const { container } = mount(initial);
  assert.match(container.querySelector(".dz-partial-note").textContent, /image\.partial\.png/);
  assert.match(container.querySelector("#dz-open-error").textContent, /output\.launch-failed/);
});

test("desktop recovery keeps its keyboard cycle and Escape route", () => {
  const cancel = document.createElement("button");
  cancel.id = "dz-btn-cancel";
  document.body.append(cancel);
  const { container } = mount(props({
    decision: { kind: "partial-recovery", reason: "partial", missingTiles: ["3,4"] },
  }));
  const actions = container.querySelectorAll(".dz-recovery-dialog button");
  act(() => {
    actions[2].focus();
    const event = new window.Event("keydown", { bubbles: true, cancelable: true });
    Object.defineProperties(event, { key: { value: "Tab" }, shiftKey: { value: false } });
    actions[2].dispatchEvent(event);
  });
  assert.equal(document.activeElement, actions[0], "Tab wraps to the first recovery action");
  act(() => {
    const event = new window.Event("keydown", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "key", { value: "Escape" });
    actions[0].dispatchEvent(event);
  });
  assert.equal(document.activeElement, cancel, "Escape moves focus to the shared Cancel action");
  cancel.remove();
});

test("desktop settings keep size in the quick strip and open an advanced dialog", () => {
  let currentSettings = defaultSettings();
  function SettingsHarness() {
    const [settings, setSettings] = useState(currentSettings);
    currentSettings = settings;
    return createElement(DesktopSettingsView, {
      settings,
      error: null,
      onChange: setSettings,
      onReset() {},
    });
  }

  const container = makeContainer();
  const root = createRoot(container);
  act(() => root.render(createElement(SettingsHarness)));

  const size = container.querySelector('select[aria-label="Size"]');
  assert.ok(size, "size preset remains a quick setting");
  act(() => {
    Object.defineProperty(size, "value", { configurable: true, value: "3840" });
    size.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
  assert.equal(currentSettings.maxWidth, 3840);
  assert.equal(currentSettings.maxHeight, null);

  click(container.querySelector(".dz-settings-more"));
  const dialog = container.querySelector(".dz-settings-dialog");
  assert.ok(dialog.hasAttribute("open"), "advanced settings opens as a dialog");
  assert.ok(dialog.querySelector(".dz-settings-sheet-head"));
  assert.equal(dialog.querySelectorAll(".dz-preference-row").length, 4);

  click(dialog.querySelector(".dz-settings-close"));
  assert.equal(dialog.hasAttribute("open"), false);
});
