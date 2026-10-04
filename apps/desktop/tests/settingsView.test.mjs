import assert from "node:assert/strict";
import test from "node:test";
import { createElement, useState } from "react";
import { act, click, makeContainer } from "../../../test/react-dom.mjs";
import { defaultSettings } from "../src/settings.ts";

// linkedom documents lack `oninput`, which keeps React's text-input change
// detection disabled. Arm it before react-dom loads so edits fire onChange.
document.oninput = null;
const { createRoot } = await import("react-dom/client");
const { DesktopSettingsView } = await import("../src/settingsView.tsx");

/** Type into a controlled field the way the select preset test does. */
function typeInto(element, value) {
  act(() => {
    Object.defineProperty(element, "value", { configurable: true, writable: true, value });
    element.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
}

function renderSettings({ error = null, settings = {} } = {}) {
  let currentSettings = { ...defaultSettings(), ...settings };
  function SettingsHarness() {
    const [settings, setSettings] = useState(currentSettings);
    currentSettings = settings;
    return createElement(DesktopSettingsView, {
      settings,
      error,
      onChange: setSettings,
      onReset() {},
    });
  }
  const container = makeContainer();
  const root = createRoot(container);
  act(() => root.render(createElement(SettingsHarness)));
  return { container, root, current: () => currentSettings };
}

test("desktop quick choices apply sizes and update estimates with the format", () => {
  const { container, root, current } = renderSettings();
  const size = container.querySelector('.dz-quick-menu[aria-label="Size"]');
  assert.ok(size, "size preset remains a quick setting");
  const presets = [...size.querySelectorAll("button")];
  assert.deepEqual(
    presets.map((button) => button.firstElementChild.textContent),
    ["Full resolution", "Full HD", "QHD", "4K", "8K", "16K", "32K", "64K", "Custom…"],
  );
  assert.equal(
    presets
      .find((button) => button.firstElementChild.textContent === "Full HD")
      .querySelector(".dz-choice-hint").textContent,
    "<5 MB",
  );
  const dimensions = [
    [1920, 1080],
    [2560, 1440],
    [3840, 2160],
    [7680, 4320],
    [15360, 8640],
    [30720, 17280],
    [61440, 34560],
  ];
  for (const [index, button] of presets.slice(1, -1).entries()) {
    click(button);
    assert.deepEqual([current().max_width, current().max_height], dimensions[index]);
  }
  for (const button of presets.slice(1, -1)) {
    const hint = button.querySelector(".dz-choice-hint").textContent;
    assert.match(hint, /^<\d+ MB$/);
    assert.equal(Number(hint.slice(1, -3)) % 5, 0);
  }
  const button = [...size.querySelectorAll("button")].find(
    (button) => button.firstElementChild.textContent === "4K",
  );
  const jpegEstimate = button.querySelector(".dz-choice-hint").textContent;
  click(button);
  assert.equal(current().max_width, 3840);
  assert.equal(current().max_height, 2160);
  const format = container.querySelector('.dz-quick-menu[aria-label="Format"]');
  click(
    [...format.querySelectorAll("button")].find((button) => button.textContent.startsWith("PNG")),
  );
  assert.equal(current().output_format, "png");
  assert.notEqual(button.querySelector(".dz-choice-hint").textContent, jpegEstimate);
  click(
    [...size.querySelectorAll("button")].find(
      (button) => button.firstElementChild.textContent === "32K",
    ),
  );
  assert.equal(current().max_width, 30720);
  click(
    [...size.querySelectorAll("button")].find((button) =>
      button.textContent.includes("Full resolution"),
    ),
  );
  assert.equal(current().max_width, null);
  assert.equal(current().max_height, null);
  assert.equal(size.querySelector(".dz-quick-info"), null);
  click(container.querySelector('button[aria-label="Size: More information"]'));
  const explanation = container.querySelector(".dz-settings-explanation");
  assert.match(explanation.textContent, /width × height/);
  assert.match(explanation.textContent, /Estimated size \(PNG\)/);
  assert.deepEqual(
    [...explanation.querySelectorAll("tbody tr")]
      .slice(1, -1)
      .map((row) =>
        [...row.querySelectorAll("td")]
          .slice(0, 2)
          .map((cell) => Number(cell.textContent.replace(/[^0-9]/g, ""))),
      ),
    dimensions,
  );
  act(() => root.unmount());
});

test("size and format choices prevent exceeding JPEG and WebP dimensions", () => {
  const { container, root, current } = renderSettings();
  const formatButton = (name) =>
    [...container.querySelectorAll('.dz-quick-menu[aria-label="Format"] button')].find(
      (button) => button.firstElementChild.textContent === name,
    );
  const sizeButton = (name) =>
    [...container.querySelectorAll('.dz-quick-menu[aria-label="Size"] button')].find(
      (button) => button.firstElementChild.textContent === name,
    );
  click(formatButton("WebP"));
  assert.ok(sizeButton("32K").disabled);
  assert.ok(sizeButton("64K").disabled);
  assert.equal(sizeButton("16K").disabled, false);
  click(sizeButton("32K"));
  assert.equal(current().max_width, null);
  click(container.querySelector(".dz-settings-more"));
  const width = container.querySelector('input[aria-label="Width"]');
  assert.equal(width.getAttribute("max"), "16383");
  typeInto(width, "16383");
  assert.equal(current().max_width, 16383);
  typeInto(width, "16384");
  assert.equal(current().max_width, 16383);
  click(container.querySelector(".dz-settings-close"));
  click(formatButton("PNG"));
  click(sizeButton("64K"));
  assert.ok(formatButton("WebP").disabled);
  assert.equal(formatButton("JPEG").disabled, false);
  act(() => root.unmount());

  for (const dimension of ["max_width", "max_height"]) {
    const rendered = renderSettings({ settings: { [dimension]: 65_536 } });
    const buttons = rendered.container.querySelectorAll(
      '.dz-quick-menu[aria-label="Format"] button',
    );
    const jpeg = [...buttons].find((button) => button.firstElementChild.textContent === "JPEG");
    assert.ok(jpeg.disabled);
    click(jpeg);
    assert.equal(rendered.current().output_format, "auto");
    act(() => rendered.root.unmount());
  }
});

test("file size estimates follow the output encoder and JPEG quality", () => {
  const estimates = {};
  for (const format of ["auto", "jpeg", "png", "tiff", "webp", "zif", "iiif-dir"]) {
    const { container, root } = renderSettings({ settings: { output_format: format } });
    const preset = [...container.querySelectorAll('.dz-quick-menu[aria-label="Size"] button')].find(
      (button) => button.firstElementChild.textContent === "8K",
    );
    estimates[format] = preset.querySelector(".dz-choice-hint").textContent;
    act(() => root.unmount());
  }
  assert.deepEqual(estimates, {
    auto: "<15 MB",
    jpeg: "<15 MB",
    png: "<60 MB",
    tiff: "<110 MB",
    webp: "<50 MB",
    zif: "<150 MB",
    "iiif-dir": "<20 MB",
  });
  const { container, root } = renderSettings({
    settings: { output_format: "jpeg", compression: 50 },
  });
  const preset = [...container.querySelectorAll('.dz-quick-menu[aria-label="Size"] button')].find(
    (button) => button.firstElementChild.textContent === "8K",
  );
  assert.equal(preset.querySelector(".dz-choice-hint").textContent, "<10 MB");
  act(() => root.unmount());
});

test("estimation buffer is applied consistently before rounding to 5 MB", () => {
  for (const [format, compression, label, expected] of [
    ["png", 5, "Full HD", "<5 MB"],
    ["png", 5, "QHD", "<10 MB"],
    // 32K PNG is 849.35 MB before buffering, 934.28 MB afterwards.
    ["png", 5, "32K", "<935 MB"],
    // Quality-50 8K JPEG crosses the 5 MB bucket only with the buffer.
    ["jpeg", 50, "8K", "<10 MB"],
    ["jpeg", 2, "8K", "<20 MB"],
    ["jpeg", 0, "8K", "<20 MB"],
    ["webp", 5, "8K", "<50 MB"],
  ]) {
    const { container, root } = renderSettings({
      settings: { output_format: format, compression },
    });
    const preset = [...container.querySelectorAll('.dz-quick-menu[aria-label="Size"] button')].find(
      (button) => button.firstElementChild.textContent === label,
    );
    assert.equal(preset.querySelector(".dz-choice-hint").textContent, expected);
    act(() => root.unmount());
  }
});

test("label information opens the existing modal with every format explanation", () => {
  const { container, root } = renderSettings();
  const info = container.querySelector('button[aria-label="Format: More information"]');
  assert.ok(info.closest(".dz-quick-label"));
  assert.equal(container.querySelectorAll(".dz-quick-menu .dz-quick-info").length, 0);
  click(info);
  const dialog = container.querySelector(".dz-settings-dialog");
  assert.ok(dialog.hasAttribute("open"));
  assert.equal(dialog.querySelector("h2").textContent, "Format");
  assert.deepEqual(
    [...dialog.querySelectorAll("dt")].map((item) => item.textContent),
    ["Auto", "PNG", "JPEG", "TIFF", "WebP", "ZIF", "IIIF folder"],
  );
  assert.match(dialog.textContent, /65,535/);
  assert.match(dialog.textContent, /16,383/);
  click(dialog.querySelector(".dz-settings-close"));
  assert.equal(dialog.hasAttribute("open"), false);
  click(container.querySelector(".dz-settings-more"));
  assert.equal(dialog.querySelector("h2").textContent, "Advanced settings");
  act(() => root.unmount());
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

test("header text is submitted as raw lines without client-side parsing", () => {
  const { container, root, current } = renderSettings();
  click(container.querySelector(".dz-settings-more"));
  const textarea = container.querySelector(".dz-headers-disclosure textarea");
  assert.ok(textarea, "request headers stay in advanced settings");
  const text = "Referer: https://example.com/viewer\nnot a header line\nX-Test: a b";
  typeInto(textarea, text);
  assert.deepEqual(
    current().headers,
    text.split("\n"),
    "raw header text reaches the settings as-is; nothing is blocked client-side",
  );
  act(() => root.unmount());
});

test("Rust save rejection reasons are displayed as typed messages", () => {
  const { container, root } = renderSettings({ error: "invalid header: bad name" });
  const message = container.querySelector("#dz-settings-error");
  assert.ok(message, "the save rejection reason is shown");
  assert.equal(message.getAttribute("role"), "alert");
  assert.match(message.textContent, /invalid header: bad name/);
  act(() => root.unmount());
});
