import test from "node:test";
import assert from "node:assert/strict";
import { createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { act, click, makeContainer } from "../../../test/react-dom.mjs";
import { DesktopSettingsView } from "../src/settingsView.tsx";
import { defaultSettings } from "../src/settings.ts";

function renderSettings() {
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
  return { container, root, current: () => currentSettings };
}

test("desktop quick strip keeps the output size preset", () => {
  const { container, current } = renderSettings();
  const size = container.querySelector('select[aria-label="Size"]');
  assert.ok(size, "size preset remains a quick setting");
  act(() => {
    Object.defineProperty(size, "value", { configurable: true, value: "3840" });
    size.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
  assert.equal(current().maxWidth, 3840);
  assert.equal(current().maxHeight, null);
});

test("desktop advanced settings open as a labelled dialog and dismiss cleanly", () => {
  const { container, root } = renderSettings();
  click(container.querySelector(".dz-settings-more"));
  const dialog = container.querySelector(".dz-settings-dialog");
  assert.ok(dialog, "advanced settings render a dialog");
  assert.ok(dialog.hasAttribute("open"), "advanced settings opens as a dialog");
  assert.ok(dialog.querySelector(".dz-settings-sheet-head"));
  assert.equal(dialog.querySelectorAll(".dz-preference-row").length, 4);
  click(dialog.querySelector(".dz-settings-close"));
  assert.equal(dialog.hasAttribute("open"), false);
  act(() => root.unmount());
});
