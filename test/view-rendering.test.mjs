import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderView, getPhaseForStatus } from "../packages/shared-ui/src/view.ts";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function createMockElement(tagName) {
  const attrs = new Map();
  const listeners = new Map();
  const children = [];
  const classes = new Set();
  const dataset = {};
  const style = {};

  const el = {
    tagName: tagName.toUpperCase(),
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
      if (children.length === 0) return el._textContent;
      return children.map((c) => c.textContent).join("");
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
    setAttribute(name, value) {
      attrs.set(name.toLowerCase(), String(value));
      if (name.toLowerCase() === "id") el.id = String(value);
      if (name.toLowerCase() === "class") el.className = String(value);
    },
    getAttribute(name) {
      return attrs.get(name.toLowerCase()) ?? null;
    },
    hasAttribute(name) {
      return attrs.has(name.toLowerCase());
    },
    removeAttribute(name) {
      attrs.delete(name.toLowerCase());
    },
    appendChild(child) {
      if (child.parentNode) child.parentNode.removeChild(child);
      child.parentNode = el;
      children.push(child);
      return child;
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
    remove() {
      if (el.parentNode) {
        el.parentNode.removeChild(el);
      }
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    querySelector(selector) {
      const all = el.querySelectorAll(selector);
      return all[0] ?? null;
    },
    querySelectorAll(selector) {
      const matches = [];
      const isClass = selector.startsWith(".");
      const isId = selector.startsWith("#");
      const target = selector.slice(1);

      function search(node) {
        for (const c of node.children) {
          if (isClass && c.classList.contains(target)) {
            matches.push(c);
          } else if (isId && c.id === target) {
            matches.push(c);
          } else if (!isClass && !isId && c.tagName === selector.toUpperCase()) {
            matches.push(c);
          }
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
  // Stack-based tag parser handling nesting
  const tokenRegex = /<(\/?[a-zA-Z0-9-]+)([^>]*)>|([^<]+)/g;
  let match;
  const stack = [parent];
  const voidTags = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr", "line", "polyline", "circle", "rect", "path"]);

  while ((match = tokenRegex.exec(html)) !== null) {
    const [full, rawTag, rawAttrs, text] = match;
    const current = stack[stack.length - 1];

    if (text) {
      const clean = text.trim();
      if (clean) {
        current._textContent = (current._textContent ? current._textContent + " " : "") + clean;
      }
      continue;
    }

    if (rawTag.startsWith("/")) {
      // Closing tag
      if (stack.length > 1) {
        stack.pop();
      }
    } else {
      // Opening tag
      const tagName = rawTag;
      const child = createMockElement(tagName);

      const idMatch = rawAttrs.match(/\bid=["']([^"']+)["']/i);
      if (idMatch) child.id = idMatch[1];
      const classMatch = rawAttrs.match(/\bclass=["']([^"']+)["']/i);
      if (classMatch) child.className = classMatch[1];
      const styleMatch = rawAttrs.match(/\bstyle=["']([^"']+)["']/i);
      if (styleMatch) {
        styleMatch[1].split(";").forEach((pair) => {
          const [k, v] = pair.split(":").map((s) => s?.trim());
          if (k && v) child.style[k] = v;
        });
      }

      current.appendChild(child);

      const isSelfClosing = rawAttrs.endsWith("/") || voidTags.has(tagName.toLowerCase());
      if (!isSelfClosing) {
        stack.push(child);
      }
    }
  }
}

globalThis.document = {
  createElement(tag) {
    return createMockElement(tag);
  },
};

test("getPhaseForStatus maps active job statuses to 'job'", () => {
  assert.equal(getPhaseForStatus("idle"), "idle");
  assert.equal(getPhaseForStatus("discovering"), "job");
  assert.equal(getPhaseForStatus("choosing-image"), "job");
  assert.equal(getPhaseForStatus("choosing-level"), "job");
  assert.equal(getPhaseForStatus("preflighting"), "job");
  assert.equal(getPhaseForStatus("downloading"), "job");
  assert.equal(getPhaseForStatus("saving"), "job");
  assert.equal(getPhaseForStatus("display-only"), "display-only");
  assert.equal(getPhaseForStatus("completed"), "completed");
  assert.equal(getPhaseForStatus("failed"), "failed");
  assert.equal(getPhaseForStatus("cancelled"), "cancelled");
});

test("renderView mounts card and updates job section in place without DOM destruction", () => {
  const container = createMockElement("div");
  const callbacks = {
    onSubmitUrl: () => {},
    onCancel: () => {},
    onReset: () => {},
    onSave: () => {},
  };

  // 1. Initial idle render
  renderView(container, { status: "idle", seq: 0, sessionId: "s1", imageCount: 0, transport: null }, callbacks);
  const card = container.querySelector(".dz-card");
  assert.ok(card, "status card mounted");
  assert.equal(card.dataset.viewPhase, "idle");
  const form = card.querySelector(".dz-form");
  assert.ok(form, "form mounted in idle view");

  // 2. Transition to discovering (active job phase)
  const jobState = {
    status: "discovering",
    seq: 1,
    sessionId: "s1",
    imageCount: 0,
    transport: "direct",
  };
  const ctx = {
    jobActivity: {
      url: "https://museum.example.org/artwork/1",
      startedAt: Date.now() - 3000,
      stepLabel: "Finding the zoomable image…",
      detail: "Contacting museum.example.org…",
    },
  };

  renderView(container, jobState, callbacks, ctx);
  assert.equal(card.dataset.viewPhase, "job");
  const jobSec = card.querySelector(".dz-job-section");
  assert.ok(jobSec, "job section mounted");
  const stepTextEl = card.querySelector("#dz-job-step-text");
  assert.ok(stepTextEl);
  assert.equal(stepTextEl.textContent, "Finding the zoomable image…");

  // User opens technical details
  const details = card.querySelector("#dz-job-details");
  assert.ok(details);
  details.open = true;

  // 3. Heartbeat update / progress ticks during job
  const nextJobState = {
    ...jobState,
    status: "downloading",
    seq: 2,
  };
  const nextCtx = {
    ...ctx,
    currentProgress: { current: 15, total: 60, message: "Downloading image tiles…" },
    jobActivity: {
      ...ctx.jobActivity,
      stepLabel: "Downloading image tiles…",
      completedRequests: 15,
      pendingRequests: 4,
    },
  };

  renderView(container, nextJobState, callbacks, nextCtx);

  // Critical architectural invariants:
  // - Card and job section MUST be the exact same DOM node references (NO recreation)
  assert.equal(container.querySelector(".dz-card"), card, "card node preserved across job updates");
  assert.equal(card.querySelector(".dz-job-section"), jobSec, "job section node preserved across job updates");

  // - Targeted element text and attributes updated in place
  assert.equal(stepTextEl.textContent, "Downloading image tiles…");
  const percentEl = card.querySelector("#dz-job-percent");
  assert.equal(percentEl.textContent, "25%");
  const barEl = card.querySelector("#dz-job-bar");
  assert.equal(barEl.style.width, "25%");

  // - Details open state preserved natively
  assert.equal(details.open, true, "open details preserved across in-place updates");

  // 4. Simulate 10 rapid heartbeat / progress ticks (every 500ms timer simulation)
  for (let tick = 1; tick <= 10; tick++) {
    renderView(
      container,
      nextJobState,
      callbacks,
      {
        ...nextCtx,
        jobActivity: {
          ...nextCtx.jobActivity,
          pendingRequests: tick % 3,
          completedRequests: 15 + tick,
        },
      },
    );
    assert.equal(card.querySelector(".dz-job-section"), jobSec, `tick ${tick}: DOM reference must stay identical`);
    assert.equal(details.open, true, `tick ${tick}: open details must never close`);
  }

  // 5. Transition to completed
  renderView(
    container,
    { status: "completed", seq: 3, sessionId: "s1", imageCount: 1, transport: "direct" },
    callbacks,
    { completedInfo: { width: 4000, height: 3000, mime: "image/png" } },
  );
  assert.equal(card.dataset.viewPhase, "completed");
  assert.equal(card.querySelector(".dz-job-section"), null, "job section unmounted on completion");
  assert.ok(card.querySelector(".dz-completed-section"), "completed section mounted");

  // 6. Reset back to idle
  renderView(container, { status: "idle", seq: 4, sessionId: "s1", imageCount: 0, transport: null }, callbacks);
  assert.equal(card.dataset.viewPhase, "idle");
  assert.ok(card.querySelector(".dz-form"), "idle form re-mounted after reset");
});

test("stalled reassurance names the website being waited on, never a generic server", () => {
  const container = createMockElement("div");
  const callbacks = {
    onSubmitUrl: () => {},
    onCancel: () => {},
    onReset: () => {},
    onSave: () => {},
  };

  const now = Date.now();
  const ctx = {
    jobActivity: {
      url: "https://artsandculture.google.com/project/1",
      startedAt: now - 20000,
      now,
      lastProgressAt: now - 11000,
      stepLabel: "Finding the zoomable image…",
    },
  };

  renderView(
    container,
    { status: "discovering", seq: 1, sessionId: "s1", imageCount: 0, transport: "direct" },
    callbacks,
    ctx,
  );
  const card = container.querySelector(".dz-card");
  const reassure = card.querySelector("#dz-job-reassure");
  assert.ok(reassure, "reassurance shown while stalled");
  assert.notEqual(reassure.style.display, "none");
  assert.equal(
    reassure.textContent,
    "Still working, artsandculture.google.com is slow to answer. You can wait, or cancel and try again later.",
  );
  assert.doesNotMatch(reassure.textContent, /museum/i);
});

test("failed state updates error details in place without destroying error container", () => {
  const container = createMockElement("div");
  const callbacks = {
    onSubmitUrl: () => {},
    onCancel: () => {},
    onReset: () => {},
    onSave: () => {},
  };

  const errState1 = {
    status: "failed",
    seq: 1,
    sessionId: "s2",
    imageCount: 0,
    transport: "direct",
    error: {
      code: "NO_IMAGE_FOUND",
      category: "discovery",
      retryable: false,
      message: "No zoomable image could be found.",
    },
  };

  renderView(container, errState1, callbacks);
  const card = container.querySelector(".dz-card");
  assert.equal(card.dataset.viewPhase, "failed");
  const errSec = card.querySelector(".dz-error-section");
  assert.ok(errSec, "error section mounted");
  assert.equal(card.querySelector("#dz-error-message").textContent, "No zoomable image could be found.");

  // Subsequent update with refined error message in same failed phase
  const errState2 = {
    ...errState1,
    error: {
      ...errState1.error,
      message: "Network timeout contacting server.",
    },
  };

  renderView(container, errState2, callbacks);
  assert.equal(card.querySelector(".dz-error-section"), errSec, "error section node preserved");
  assert.equal(card.querySelector("#dz-error-message").textContent, "Network timeout contacting server.");
});

test("CSS structural invariants prevent button clipping, container overflow, and layout shifts", () => {
  const css = fs.readFileSync(path.join(rootDir, "packages/shared-ui/src/styles/theme.css"), "utf8");

  // Secondary buttons must not have rigid height: 38px (must use min-height to avoid text bleed)
  assert.match(css, /\.dz-btn-secondary\s*\{[^}]*min-height:\s*38px;/);
  assert.doesNotMatch(css, /\.dz-btn-secondary\s*\{[^}]*(?<![a-z-])height:\s*38px;/);

  // Progress controls and job actions must wrap and avoid squeezing elements into overlapping
  assert.match(css, /\.dz-progress-controls\s*\{[^}]*flex-wrap:\s*wrap;/);
  assert.match(css, /\.dz-job-actions\s*\{[^}]*flex-wrap:\s*wrap;/);

  // Transport badge must be bounded and not stretch parent container
  assert.match(css, /\.dz-transport-badge\s*\{[^}]*max-width:\s*100%;/);

  // Progress percentage must never shrink or cause layout jitter
  assert.match(css, /\.dz-progress-percent\s*\{[^}]*flex-shrink:\s*0;/);
  assert.match(css, /\.dz-progress-percent\s*\{[^}]*tabular-nums;/);

  // Status step text must have min-width: 0 to truncate cleanly instead of overflowing
  assert.match(css, /\.dz-progress-status\s*\{[^}]*min-width:\s*0;/);

  // Mobile layout adaptations for portrait phones
  assert.ok(css.includes("max-width: 560px") && css.includes("flex-direction: column"));
  assert.ok(css.includes("max-width: 380px"));
});
