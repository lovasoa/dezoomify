import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  renderView,
  openModal,
  openConfirmModal,
  openImagePicker,
  openLevelPicker,
} from "../packages/shared-ui/src/view.ts";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Minimal mock DOM (vanilla node:test, no framework): elements carry tag,
// children, attributes, text, style, dataset, and classList plus the small
// query surface the shared view uses (".class", "#id", "tag").
function createMockElement(tagName) {
  const attrs = new Map();
  const children = [];
  const classes = new Set();
  const dataset = {};
  const style = {};

  const el = {
    tagName: tagName.toUpperCase(),
    ownerDocument: globalThis.document,
    style,
    dataset,
    open: false,
    _value: "",
    get value() {
      return el._value;
    },
    set value(v) {
      el._value = String(v);
    },
    parentNode: null,
    children,
    get firstElementChild() {
      return children[0] ?? null;
    },
    get classList() {
      return {
        add(...cls) {
          cls.forEach((c) => classes.add(c));
        },
        remove(...cls) {
          cls.forEach((c) => classes.delete(c));
        },
        contains(c) {
          return classes.has(c);
        },
      };
    },
    get className() {
      return Array.from(classes).join(" ");
    },
    set className(val) {
      classes.clear();
      String(val || "")
        .split(/\s+/)
        .filter(Boolean)
        .forEach((c) => classes.add(c));
    },
    _id: "",
    get id() {
      return el._id;
    },
    set id(val) {
      el._id = String(val || "");
    },
    _textContent: "",
    get textContent() {
      // Direct text plus descendant text (e.g. a button holding an icon
      // plus its label): either source alone can carry the accessible name.
      const kids = children.map((c) => c.textContent).join("");
      return `${el._textContent}${el._textContent && kids ? " " : ""}${kids}`;
    },
    set textContent(val) {
      children.length = 0;
      el._textContent = String(val ?? "");
    },
    _innerHTML: "",
    get innerHTML() {
      return el._innerHTML;
    },
    set innerHTML(html) {
      el._innerHTML = String(html ?? "");
      children.length = 0;
      el._textContent = "";
      parseSimpleHtml(el, el._innerHTML);
    },
    getAttribute(name) {
      return attrs.get(String(name).toLowerCase()) ?? null;
    },
    setAttribute(name, value) {
      attrs.set(String(name).toLowerCase(), String(value));
      if (String(name).toLowerCase() === "id") el.id = String(value);
      if (String(name).toLowerCase() === "class") el.className = String(value);
    },
    hasAttribute(name) {
      return attrs.has(String(name).toLowerCase());
    },
    removeAttribute(name) {
      attrs.delete(String(name).toLowerCase());
    },
    appendChild(child) {
      if (child.parentNode) child.parentNode.removeChild(child);
      child.parentNode = el;
      children.push(child);
      return child;
    },
    append(...nodes) {
      for (const n of nodes) el.appendChild(n);
      return undefined;
    },
    prepend(child) {
      if (child.parentNode) child.parentNode.removeChild(child);
      child.parentNode = el;
      children.unshift(child);
      return child;
    },
    removeChild(child) {
      const idx = children.indexOf(child);
      if (idx !== -1) {
        children.splice(idx, 1);
        child.parentNode = null;
      }
      return child;
    },
    replaceChildren(...nodes) {
      for (const c of [...children]) el.removeChild(c);
      for (const n of nodes) el.appendChild(n);
      return undefined;
    },
    remove() {
      if (el.parentNode) el.parentNode.removeChild(el);
    },
    focus() {
      el._focused = true;
      if (el.ownerDocument) el.ownerDocument.activeElement = el;
    },
    addEventListener() {},
    removeEventListener() {},
    contains(node) {
      if (node === el) return true;
      return children.some((c) => c === node || (c.contains && c.contains(node)));
    },
    querySelector(selector) {
      return el.querySelectorAll(selector)[0] ?? null;
    },
    querySelectorAll(selector) {
      const matches = [];
      const isClass = selector.startsWith(".");
      const isId = selector.startsWith("#");
      const target = selector.slice(1);
      function search(node) {
        for (const c of node.children) {
          if (isClass && c.classList.contains(target)) matches.push(c);
          else if (isId && c.id === target) matches.push(c);
          else if (!isClass && !isId && c.tagName === selector.toUpperCase()) matches.push(c);
          search(c);
        }
      }
      search(el);
      return matches;
    },
  };
  return el;
}

function parseSimpleHtml(parent, html) {
  const tokenRegex = /<(\/?[a-zA-Z0-9-]+)([^>]*)>|([^<]+)/g;
  let match;
  const stack = [parent];
  const voidTags = new Set([
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link",
    "meta", "param", "source", "track", "wbr", "line", "polyline",
    "circle", "rect", "path",
  ]);
  while ((match = tokenRegex.exec(html)) !== null) {
    const [, rawTag, rawAttrs, text] = match;
    const current = stack[stack.length - 1];
    if (text) {
      const clean = text.trim();
      if (clean) current._textContent = (current._textContent ? current._textContent + " " : "") + clean;
      continue;
    }
    if (rawTag.startsWith("/")) {
      // Explicit closers for void elements (e.g. SVG </path>) never pushed.
      const name = rawTag.slice(1).toLowerCase();
      if (!voidTags.has(name) && stack.length > 1) stack.pop();
    } else {
      const child = createMockElement(rawTag);
      const attrRegex = /([a-zA-Z-:]+)(?:=["']([^"']*)["'])?/g;
      let attr;
      while ((attr = attrRegex.exec(rawAttrs)) !== null) {
        const [, name, value] = attr;
        child.setAttribute(name, value ?? "");
      }
      const styleMatch = rawAttrs.match(/\bstyle=["']([^"']+)["']/i);
      if (styleMatch) {
        styleMatch[1].split(";").forEach((pair) => {
          const [k, v] = pair.split(":").map((s) => s?.trim());
          if (k && v) child.style[k] = v;
        });
      }
      current.appendChild(child);
      const selfClosing = rawAttrs.trimEnd().endsWith("/") || voidTags.has(rawTag.toLowerCase());
      if (!selfClosing) stack.push(child);
    }
  }
}

const bodyEl = createMockElement("body");
globalThis.document = {
  createElement(tag) {
    return createMockElement(tag);
  },
  querySelector() {
    return null;
  },
  body: bodyEl,
  activeElement: null,
  addEventListener() {},
  removeEventListener() {},
};

function makeContainer() {
  const container = createMockElement("div");
  container.ownerDocument = globalThis.document;
  return container;
}

const callbacks = {
  onSubmitUrl: () => {},
  onCancel: () => {},
  onReset: () => {},
  onSave: () => {},
  onCopyShareLink: () => {},
};

/** Every button must expose a non-empty accessible name (text or aria-label). */
function assertButtonsNamed(root, where) {
  const buttons = root.querySelectorAll("button");
  assert.ok(buttons.length > 0, `${where}: expected buttons to audit`);
  for (const b of buttons) {
    const name = (b.textContent || "").trim() || (b.getAttribute("aria-label") || "").trim();
    assert.ok(name.length > 0, `${where}: button without accessible name`);
  }
}

test("axe gate: idle form controls are labelled and the submit action is named", () => {
  const container = makeContainer();
  renderView(container, { status: "idle", seq: 0, sessionId: "s1", imageCount: 0, transport: null }, callbacks);
  const card = container.querySelector(".dz-card");
  const input = card.querySelector("#dz-url-input");
  assert.ok(input, "url input mounted");
  assert.ok((input.getAttribute("aria-label") || "").length > 0, "url input has an accessible name");
  assert.ok((input.getAttribute("placeholder") || "").length > 0, "url input keeps a visible hint");
  const clear = card.querySelector("#dz-btn-clear");
  assert.ok(clear, "clear control mounted");
  assert.ok((clear.getAttribute("aria-label") || "").length > 0, "clear control is labelled");
  assertButtonsNamed(card, "idle");
});

test("axe gate: live job region announces progress with a labelled progressbar", () => {
  const container = makeContainer();
  renderView(
    container,
    { status: "downloading", seq: 1, sessionId: "s1", imageCount: 0, transport: "direct" },
    callbacks,
    {
      currentProgress: { current: 3, total: 12 },
      jobActivity: { url: "https://museum.example.org/x", startedAt: Date.now() - 3000, now: Date.now() },
    },
  );
  const card = container.querySelector(".dz-card");
  const sec = card.querySelector(".dz-job-section");
  assert.equal(sec.getAttribute("role"), "status");
  assert.equal(sec.getAttribute("aria-live"), "polite");
  const track = card.querySelector("#dz-job-track");
  assert.equal(track.getAttribute("role"), "progressbar");
  assert.equal(track.getAttribute("aria-valuemin"), "0");
  assert.equal(track.getAttribute("aria-valuemax"), "100");
  const now = Number(track.getAttribute("aria-valuenow"));
  assert.ok(Number.isFinite(now) && now >= 0 && now <= 100, "aria-valuenow stays within bounds");
  assert.ok((track.getAttribute("aria-label") || "").length > 0, "progressbar has an accessible name");
  assertButtonsNamed(card, "job");
});

test("axe gate: failed view layers guidance with named recovery actions", () => {
  const container = makeContainer();
  renderView(
    container,
    {
      status: "failed",
      seq: 1,
      sessionId: "s1",
      imageCount: 0,
      transport: "direct",
      error: { code: "X", category: "c", retryable: true, message: "No zoomable image could be found." },
    },
    callbacks,
  );
  const card = container.querySelector(".dz-card");
  assert.ok((card.querySelector("#dz-error-message").textContent || "").length > 0, "error message slot is populated");
  assertButtonsNamed(card, "failed");
  const report = card.querySelector(".dz-diagnostics-report");
  assert.ok(report, "bug-report path stays reachable from the failed view");
});

test("axe gate: completed and display-only views keep every action named", () => {
  const done = makeContainer();
  renderView(
    done,
    { status: "completed", seq: 1, sessionId: "s1", imageCount: 1, transport: "direct" },
    callbacks,
    { completedInfo: { width: 100, height: 80, mime: "image/png" }, originClean: true },
  );
  assertButtonsNamed(done.querySelector(".dz-card"), "completed");

  const preview = makeContainer();
  renderView(
    preview,
    { status: "display-only", seq: 1, sessionId: "s1", imageCount: 1, transport: "display" },
    callbacks,
    { originClean: false, desktopHandoffUrl: "dezoomify://open?v=2&src=https%3A%2F%2Fx" },
  );
  assertButtonsNamed(preview.querySelector(".dz-card"), "display-only");
});

test("axe gate: modal dialogs are labelled, modal, and dismissible by name", () => {
  openModal(globalThis.document, "Title", "Subtitle", "<p>Body</p>");
  const backdrop = bodyEl.querySelector(".dz-modal-backdrop");
  assert.ok(backdrop, "modal backdrop mounted");
  assert.equal(backdrop.getAttribute("role"), "dialog");
  assert.equal(backdrop.getAttribute("aria-modal"), "true");
  const labelledBy = backdrop.getAttribute("aria-labelledby");
  assert.ok(labelledBy, "dialog names its label");
  assert.ok(backdrop.querySelector(`#${labelledBy}`), "dialog label target exists");
  assertButtonsNamed(backdrop, "modal");
  backdrop.remove();

  assert.equal(
    openImagePicker(globalThis.document, {
      options: [
        { index: 0, title: "A", width: 10, height: 10, tiles: 1 },
        { index: 1, title: "B", width: 20, height: 20, tiles: 4 },
      ],
      onPick: () => {},
    }),
    true,
  );
  const picker = bodyEl.querySelector(".dz-modal-backdrop");
  assert.ok(picker, "image picker mounted");
  assert.equal(picker.getAttribute("role"), "dialog");
  assert.equal(picker.getAttribute("aria-modal"), "true");
  const group = picker.querySelector(".dz-choice-group");
  assert.equal(group.getAttribute("role"), "radiogroup");
  assert.ok((group.getAttribute("aria-label") || "").length > 0, "radio group is labelled");
  assertButtonsNamed(picker, "image picker");
  picker.remove();

  assert.equal(
    openLevelPicker(globalThis.document, {
      options: [
        { index: 0, width: 10, height: 10, tiles: 1, fits: true },
        { index: 1, width: 20, height: 20, tiles: 4, fits: false },
      ],
      onPick: () => {},
    }),
    true,
  );
  const levels = bodyEl.querySelector(".dz-modal-backdrop");
  assert.ok(levels, "level picker mounted");
  assert.equal(levels.getAttribute("role"), "dialog");
  assertButtonsNamed(levels, "level picker");
  levels.remove();
});

test("axe gate: extension modal carries document language, viewport, and the shared mount", () => {
  const html = fs.readFileSync(path.join(rootDir, "apps/extension/src/modal/modal.html"), "utf8");
  assert.match(html, /<html[^>]*lang="en"/, "modal declares its language");
  assert.match(html, /name="viewport"[^>]*width=device-width/, "modal keeps the mobile viewport");
  assert.match(html, /<title>[^<]+<\/title>/, "modal keeps a document title");
  assert.match(html, /id="dz-modal-app"/, "modal keeps the shared-UI mount");
  assert.match(html, /<link rel="stylesheet" href="\.\.\/vendor\/theme\.css" \/>/, "modal links the vendored canonical theme");
  assert.doesNotMatch(html, /tabindex="[1-9]/, "no positive tabindex steals Tab order");
});

test("axe gate: progressbar semantics come from the vendored shared-ui template", () => {
  // The job card is mounted at runtime by the vendored renderView (same
  // template as the website); the static shell only hosts the mount.
  const vendorView = fs.readFileSync(path.join(rootDir, "packages/shared-ui/src/view.ts"), "utf8");
  assert.match(vendorView, /role="progressbar"/, "job template keeps the progressbar role");
  assert.match(vendorView, /aria-valuemin="0"[^>]*aria-valuemax="100"|aria-valuemax="100"[^>]*aria-valuemin="0"/, "job template keeps progressbar bounds");
  assert.match(vendorView, /aria-label/, "job template names the progressbar");
});

test("axe gate: visible focus and reduced-motion guards stay in the theme", () => {
  const css = fs.readFileSync(path.join(rootDir, "packages/shared-ui/src/styles/theme.css"), "utf8");
  for (const selector of [".dz-btn-tactile:focus-visible", ".dz-btn-secondary:focus-visible", ".dz-summary:focus-visible"]) {
    assert.ok(css.includes(selector), `theme keeps a visible focus ring for ${selector}`);
  }
  assert.match(css, /prefers-reduced-motion/, "theme honors reduced motion");
  // The extension modal links the vendored canonical theme (byte-identical
  // per the extension shared-ui parity suite), so the guard applies there.
  const modal = fs.readFileSync(path.join(rootDir, "apps/extension/src/modal/modal.html"), "utf8");
  assert.match(modal, /vendor\/theme\.css/, "extension modal inherits the reduced-motion guard from the theme");
});

test("axe gate: confirm dialog names its actions and focuses decline first", async () => {
  // Handoff consent geometry (extension): explicit confirm/decline, initial
  // focus on decline so an accidental Enter fails safe, site-influenced
  // lines as text (never markup).
  const pending = openConfirmModal(globalThis.document, {
    title: "Send to desktop app?",
    subtitle: "Host: dev.ophir.dezoomify.native_host",
    bodyLines: ["Origins: https://museum.example/", "Cookies: <img src=x>", "Job: job:1", "Nothing is sent until you confirm."],
    confirmLabel: "Send to desktop app",
    declineLabel: "Stay in extension",
  });
  assert.ok(pending instanceof Promise, "consent resolves asynchronously on explicit choice");
  const backdrop = bodyEl.querySelector(".dz-modal-backdrop");
  assert.ok(backdrop, "dialog mounted");
  assert.equal(backdrop.getAttribute("role"), "dialog");
  assert.equal(backdrop.getAttribute("aria-modal"), "true");
  assert.equal(backdrop.getAttribute("aria-labelledby"), "dz-modal-title");
  assertButtonsNamed(backdrop, "confirm dialog");
  const text = backdrop.textContent;
  assert.match(text, /Send to desktop app\?/);
  assert.match(text, /Stay in extension/);
  // Angle brackets stay literal text: origins and cookie names never parse.
  assert.ok(text.includes("Cookies: <img src=x>"), "site-influenced lines stay literal text");
  assert.equal(globalThis.document.activeElement?.textContent, "Stay in extension", "initial focus fails safe on decline");
  backdrop.remove();
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

test("axe gate: text and link contrast meets AA in both color schemes", () => {
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
