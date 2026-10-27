import assert from "node:assert/strict";
import test from "node:test";
import { createElement, useState } from "react";
import { act, click, input, makeContainer, onCleanup } from "../../../test/react-dom.mjs";
import { defaultSettings, loadSettings, saveSettings } from "../src/settings.ts";

// linkedom documents lack `oninput`, which keeps React's text-input change
// detection disabled. Arm it before react-dom loads so edits fire onChange.
document.oninput = null;
const { createRoot } = await import("react-dom/client");
const { setLocale } = await import("@dezoomify/shared-ui");
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
  onCleanup(() => root.unmount());
  act(() => root.render(createElement(SettingsHarness)));
  return { container, root, current: () => currentSettings };
}

test("desktop quick choices apply sizes and update estimates with the format", () => {
  const { container, root, current } = renderSettings();
  const size = container.querySelector('.dz-quick-menu[aria-label="Size"]');
  assert.ok(container.querySelector('summary[aria-label="Format: Auto"]'));
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
    "Up to about 1.3 MB",
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
    assert.match(hint, /^Up to about [\d,.]+ MB$/);
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
  assert.ok(container.querySelector('summary[aria-label="Format: PNG"]'));
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
  assert.match(explanation.textContent, /interpolate measurements for the codec/);
  assert.match(explanation.textContent, /Estimate at max size \(PNG\)/);
  assert.match(explanation.textContent, /image filling the preset's maximum width and height/);
  assert.match(explanation.textContent, /much smaller file/);
  assert.match(explanation.textContent, /Auto assumes an opaque JPEG/);
  assert.doesNotMatch(container.textContent, /≈/);
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

test("network presets share a numerical help table and default to Automatic", () => {
  const { container, root, current } = renderSettings();
  const network = container.querySelector('.dz-quick-menu[aria-label="Network"]');
  assert.ok(container.querySelector('summary[aria-label="Network: Automatic"]'));
  const buttons = [...network.querySelectorAll("button")];
  for (const [index, profile] of ["gentle", "automatic", "aggressive"].entries()) {
    click(buttons[index]);
    assert.equal(current().network_profile, profile);
  }
  click(container.querySelector('button[aria-label="Network: More information"]'));
  const dialog = container.querySelector("dialog");
  assert.ok(dialog.hasAttribute("open"));
  assert.deepEqual(
    [...dialog.querySelectorAll("thead th")].map((cell) => cell.textContent),
    ["Mode", "Starts at", "Can increase to"],
  );
  assert.deepEqual(
    [...dialog.querySelectorAll("tbody tr")].map((row) =>
      [...row.children].map((cell) => cell.textContent),
    ),
    [
      ["Gentle", "2 requests/s", "2 requests/s"],
      ["Automatic", "5 requests/s", "16 requests/s"],
      ["Aggressive", "16 requests/s", "128 requests/s"],
    ],
  );
  act(() => root.unmount());
});

test("saved network profiles migrate without changing the new default", () => {
  for (const [old, profile] of [
    ["maximum", "aggressive"],
    ["balanced", "automatic"],
  ]) {
    saveSettings({ ...defaultSettings(), network_profile: old });
    assert.equal(loadSettings().network_profile, profile);
  }
  saveSettings(defaultSettings());
});

test("quick settings translate the automatic preference and estimated units", () => {
  setLocale("fr");
  const { container, root } = renderSettings();
  try {
    assert.ok(container.querySelector('summary[aria-label="Format: Automatique"]'));
    const hints = [...container.querySelectorAll(".dz-choice-hint")].map(
      (hint) => hint.textContent,
    );
    assert.ok(hints.includes("Jusqu’à environ 1,3 Mo"));
    assert.ok(hints.some((hint) => hint === "Jusqu’à environ 1 300 Mo"));
  } finally {
    act(() => root.unmount());
    setLocale("en");
  }
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
    for (const label of ["JPEG", "AVIF"]) {
      const button = [...buttons].find((button) => button.firstElementChild.textContent === label);
      assert.ok(button.disabled);
      click(button);
    }
    assert.equal(rendered.current().output_format, "auto");
    act(() => rendered.root.unmount());
  }
});

test("file size estimates follow the output encoder and JPEG quality", () => {
  const estimates = {};
  for (const format of ["auto", "jpeg", "png", "tiff", "webp", "avif", "zif", "iiif-dir"]) {
    const { container, root } = renderSettings({ settings: { output_format: format } });
    const preset = [...container.querySelectorAll('.dz-quick-menu[aria-label="Size"] button')].find(
      (button) => button.firstElementChild.textContent === "8K",
    );
    estimates[format] = preset.querySelector(".dz-choice-hint").textContent;
    act(() => root.unmount());
  }
  assert.deepEqual(estimates, {
    auto: "Up to about 21 MB",
    jpeg: "Up to about 21 MB",
    png: "Up to about 59 MB",
    tiff: "Up to about 110 MB",
    webp: "Up to about 48 MB",
    avif: "Up to about 17 MB",
    zif: "Up to about 150 MB",
    "iiif-dir": "Up to about 27 MB",
  });
  const { container, root } = renderSettings({
    settings: { output_format: "jpeg", compression: 50 },
  });
  const preset = [...container.querySelectorAll('.dz-quick-menu[aria-label="Size"] button')].find(
    (button) => button.firstElementChild.textContent === "8K",
  );
  assert.equal(preset.querySelector(".dz-choice-hint").textContent, "Up to about 5.5 MB");
  act(() => root.unmount());
});

test("estimation buffer is applied before rounding to two significant digits", () => {
  for (const [format, compression, label, expected] of [
    ["png", 5, "Full HD", "Up to about 3.7 MB"],
    ["png", 5, "QHD", "Up to about 6.5 MB"],
    // 32K PNG is 849.35 MB before buffering, 934.28 MB afterwards.
    ["png", 5, "32K", "Up to about 940 MB"],
    ["jpeg", 50, "8K", "Up to about 5.5 MB"],
    ["jpeg", 2, "8K", "Up to about 32 MB"],
    ["jpeg", 0, "8K", "Up to about 42 MB"],
    ["webp", 5, "8K", "Up to about 48 MB"],
    ["avif", 100, "8K", "Up to about 440 kB"],
    ["avif", 50, "8K", "Up to about 3.7 MB"],
    ["avif", 25, "8K", "Up to about 5.5 MB"],
    ["avif", 2, "8K", "Up to about 26 MB"],
    ["avif", 0, "8K", "Up to about 42 MB"],
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

test("size budgets interpolate quality samples and clamp at the first sample", () => {
  for (const [format, compression, megabytes] of [
    ["avif", 10, 710],
    ["avif", 9, 780],
    ["avif", 8, 850],
    ["avif", 6, 990],
    ["avif", 5, 1100],
    ["avif", 4, 1300],
    ["avif", 1, 2200],
    ["avif", 0, 2700],
    ["avif", 99, 29],
    ["avif", 100, 29],
    ["jpeg", 100, 82],
    ["jpeg", 75, 200],
    ["jpeg", 74, 210],
    ["jpeg", 9, 1100],
    ["jpeg", 7, 1200],
    ["jpeg", 1, 2400],
    ["jpeg", 0, 2700],
  ]) {
    const { container, root } = renderSettings({
      settings: { output_format: format, compression },
    });
    const preset = [...container.querySelectorAll('.dz-quick-menu[aria-label="Size"] button')].find(
      (button) => button.firstElementChild.textContent === "64K",
    );
    assert.equal(
      preset.querySelector(".dz-choice-hint").textContent,
      `Up to about ${new Intl.NumberFormat("en").format(megabytes)} MB`,
      `${format} at quality ${100 - compression}`,
    );
    act(() => root.unmount());
  }
});

test("label information opens the existing modal with every format explanation", () => {
  const { container, root } = renderSettings();
  const avif = [...container.querySelectorAll('.dz-quick-menu[aria-label="Format"] button')].find(
    (button) => button.firstElementChild.textContent === "AVIF",
  );
  assert.equal(avif.querySelector(".dz-choice-hint").textContent, "advanced compression");
  const info = container.querySelector('button[aria-label="Format: More information"]');
  assert.ok(info.closest(".dz-quick-label"));
  assert.equal(container.querySelectorAll(".dz-quick-menu .dz-quick-info").length, 0);
  click(info);
  const dialog = container.querySelector(".dz-settings-dialog");
  assert.ok(dialog.hasAttribute("open"));
  assert.equal(dialog.querySelector("h2").textContent, "Format");
  assert.deepEqual(
    [...dialog.querySelectorAll("dt")].map((item) => item.textContent),
    ["Auto", "PNG", "JPEG", "TIFF", "WebP", "AVIF", "ZIF", "IIIF folder"],
  );
  assert.match(dialog.textContent, /65,535/);
  assert.match(dialog.textContent, /16,383/);
  assert.match(dialog.textContent, /Advanced compression with transparency/);
  click(dialog.querySelector(".dz-settings-close"));
  assert.equal(dialog.hasAttribute("open"), false);
  click(container.querySelector(".dz-settings-more"));
  assert.equal(dialog.querySelector("h2").textContent, "Advanced settings");
  act(() => root.unmount());
});

test("compression sits above sizes and updates budgets live without closing the menu", () => {
  const { container, root, current } = renderSettings({
    settings: { output_format: "avif", compression: 0 },
  });
  const menu = container.querySelector('.dz-quick-menu[aria-label="Size"]');
  const dropdown = menu.closest("details");
  const slider = menu.querySelector('input[aria-label="Compression"]');
  assert.equal(menu.firstElementChild.className, "dz-compression-control");
  assert.equal(slider.getAttribute("min"), "0");
  assert.equal(slider.getAttribute("max"), "100");
  assert.equal(slider.value, "0");
  act(() => {
    dropdown.open = true;
  });
  const estimate = () =>
    [...container.querySelectorAll('.dz-quick-menu[aria-label="Size"] button')]
      .find((button) => button.firstElementChild.textContent === "8K")
      .querySelector(".dz-choice-hint").textContent;
  assert.equal(estimate(), "Up to about 42 MB");
  input(slider, "50");
  assert.equal(current().compression, 50);
  assert.equal(estimate(), "Up to about 3.7 MB");
  assert.equal(menu.querySelector("output").textContent, "50%");
  assert.equal(dropdown.open, true);
  click(container.querySelector(".dz-settings-more"));
  assert.equal(container.querySelector("dialog input[type=range]"), null);
  assert.equal(container.querySelector('input[aria-label="AVIF quality"]'), null);
  assert.equal(container.querySelector('input[aria-label="Width"]').getAttribute("max"), "65535");
  click(container.querySelector(".dz-settings-close"));
  click(container.querySelector('button[aria-label="Size: More information"]'));
  assert.match(
    container.querySelector(".dz-settings-explanation").textContent,
    /codec and compression setting/,
  );
  act(() => root.unmount());
});

test("the same compression value survives format changes and unsupported formats disable it", () => {
  const { container, root, current } = renderSettings({
    settings: { output_format: "webp", compression: 37 },
  });
  const slider = container.querySelector('input[aria-label="Compression"]');
  assert.equal(slider.disabled, true);
  assert.equal(slider.value, "37");
  const format = (name) =>
    [...container.querySelectorAll('.dz-quick-menu[aria-label="Format"] button')].find(
      (button) => button.firstElementChild.textContent === name,
    );
  click(format("JPEG"));
  assert.equal(slider.disabled, false);
  assert.equal(slider.value, "37");
  input(slider, "72");
  assert.equal(current().compression, 72);
  click(format("AVIF"));
  assert.equal(slider.value, "72");
  assert.equal(current().compression, 72);
  click(format("WebP"));
  assert.equal(slider.disabled, true);
  assert.equal(current().compression, 72);
  act(() => root.unmount());
});

test("high compression keeps updating kilobyte budgets and localizes their units", () => {
  const { container, root } = renderSettings({
    settings: { output_format: "avif", compression: 80 },
  });
  const slider = container.querySelector('input[aria-label="Compression"]');
  const preset = [...container.querySelectorAll('.dz-quick-menu[aria-label="Size"] button')].find(
    (button) => button.firstElementChild.textContent === "Full HD",
  );
  const hint = preset.querySelector(".dz-choice-hint");
  for (const [compression, expected] of [
    [80, 53],
    [90, 37],
    [95, 30],
    [100, 28],
  ]) {
    input(slider, String(compression));
    assert.equal(hint.textContent, `Up to about ${expected} kB`);
  }
  act(() => root.unmount());

  setLocale("fr");
  const french = renderSettings({ settings: { output_format: "avif", compression: 100 } });
  try {
    assert.ok(
      [...french.container.querySelectorAll(".dz-choice-hint")].some(
        (hint) => hint.textContent === "Jusqu’à environ 28 ko",
      ),
    );
  } finally {
    act(() => french.root.unmount());
    setLocale("en");
  }
});

test("severe detail loss warning follows the format and compression without blocking input", () => {
  for (const [format, boundary] of [
    ["auto", 75],
    ["jpeg", 75],
    ["avif", 70],
    ["iiif-dir", 75],
  ]) {
    const { container, root, current } = renderSettings({
      settings: { output_format: format, compression: boundary },
    });
    const slider = container.querySelector('input[aria-label="Compression"]');
    assert.equal(container.querySelector(".dz-compression-warning"), null);
    input(slider, String(boundary + 1));
    const warning = container.querySelector(".dz-compression-warning");
    assert.match(warning.getAttribute("aria-label"), /Severe detail loss/);
    assert.match(warning.title, /unreadable/);
    assert.equal(slider.getAttribute("aria-describedby"), warning.id);
    assert.equal(current().compression, boundary + 1);
    input(slider, String(boundary));
    assert.equal(container.querySelector(".dz-compression-warning"), null);
    act(() => root.unmount());
  }
  for (const format of ["png", "tiff", "webp", "zif"]) {
    const { container, root } = renderSettings({
      settings: { output_format: format, compression: 100 },
    });
    assert.equal(container.querySelector(".dz-compression-warning"), null);
    act(() => root.unmount());
  }
});

test("desktop advanced settings open as a labelled dialog and dismiss cleanly", () => {
  const { container, root } = renderSettings();
  click(container.querySelector(".dz-settings-more"));
  const dialog = container.querySelector(".dz-settings-dialog");
  assert.ok(dialog, "advanced settings render a dialog");
  assert.ok(dialog.hasAttribute("open"), "advanced settings opens as a dialog");
  assert.ok(dialog.querySelector(".dz-settings-sheet-head"));
  assert.equal(dialog.querySelectorAll(".dz-preference-row").length, 3);
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
