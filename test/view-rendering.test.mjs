import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { act } from "./react-dom.mjs";
import { renderView, getPhaseForStatus } from "../packages/shared-ui/src/view.tsx";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function container() {
  const el = globalThis.document.createElement("div");
  globalThis.document.body.appendChild(el);
  return el;
}

function render(el, state, callbacks, ctx) {
  act(() => renderView(el, state, callbacks, ctx));
}

const callbacks = {
  onSubmitUrl: () => {},
  onCancel: () => {},
  onReset: () => {},
  onSave: () => {},
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
  const el = container();

  // 1. Initial idle render
  render(el, { status: "idle", seq: 0, sessionId: "s1", imageCount: 0, transport: null }, callbacks);
  const card = el.querySelector(".dz-card");
  assert.ok(card, "status card mounted");
  assert.equal(card.dataset.viewPhase, "idle");
  assert.ok(card.querySelector(".dz-form"), "form mounted in idle view");

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

  render(el, jobState, callbacks, ctx);
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
  const nextJobState = { ...jobState, status: "downloading", seq: 2 };
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

  render(el, nextJobState, callbacks, nextCtx);

  // Card and job section MUST be the exact same DOM node references.
  assert.equal(el.querySelector(".dz-card"), card, "card node preserved across job updates");
  assert.equal(card.querySelector(".dz-job-section"), jobSec, "job section node preserved across job updates");

  assert.equal(stepTextEl.textContent, "Downloading image tiles…");
  const countsEl = card.querySelector("#dz-job-counts");
  assert.equal(countsEl.textContent, "15 done / 60");
  const barEl = card.querySelector("#dz-job-bar");
  assert.equal(barEl.style.width, "25%");

  // Uncontrolled details open state is preserved natively.
  assert.equal(details.open, true, "open details preserved across in-place updates");

  // 4. Rapid heartbeat / progress ticks
  for (let tick = 1; tick <= 10; tick++) {
    render(el, nextJobState, callbacks, {
      ...nextCtx,
      jobActivity: {
        ...nextCtx.jobActivity,
        pendingRequests: tick % 3,
        completedRequests: 15 + tick,
      },
    });
    assert.equal(card.querySelector(".dz-job-section"), jobSec, `tick ${tick}: DOM reference must stay identical`);
    assert.equal(details.open, true, `tick ${tick}: open details must never close`);
  }

  // 5. Transition to completed
  render(
    el,
    { status: "completed", seq: 3, sessionId: "s1", imageCount: 1, transport: "direct" },
    callbacks,
    { completedInfo: { width: 4000, height: 3000, mime: "image/png" } },
  );
  assert.equal(card.dataset.viewPhase, "completed");
  assert.equal(card.querySelector(".dz-job-section"), null, "job section unmounted on completion");
  assert.ok(card.querySelector(".dz-completed-section"), "completed section mounted");

  // 6. Reset back to idle
  render(el, { status: "idle", seq: 4, sessionId: "s1", imageCount: 0, transport: null }, callbacks);
  assert.equal(card.dataset.viewPhase, "idle");
  assert.ok(card.querySelector(".dz-form"), "idle form re-mounted after reset");
});

test("slow discovery replaces the phase with one waiting status", () => {
  const el = container();
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
  render(el, { status: "discovering", seq: 1, sessionId: "s1", imageCount: 0, transport: "direct" }, callbacks, ctx);
  const card = el.querySelector(".dz-card");
  const step = card.querySelector("#dz-job-step-text");
  assert.ok(step, "job status shown while stalled");
  assert.equal(step.textContent, "Waiting for artsandculture.google.com…");
  assert.doesNotMatch(step.textContent, /museum/i);
});

test("failed state updates error details in place without destroying error container", () => {
  const el = container();
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
  render(el, errState1, callbacks);
  const card = el.querySelector(".dz-card");
  assert.equal(card.dataset.viewPhase, "failed");
  const errSec = card.querySelector(".dz-error-section");
  assert.ok(errSec, "error section mounted");
  assert.equal(card.querySelector("#dz-error-message").textContent, "No zoomable image could be found.");

  const errState2 = { ...errState1, error: { ...errState1.error, message: "Network timeout contacting server." } };
  render(el, errState2, callbacks);
  assert.equal(card.querySelector(".dz-error-section"), errSec, "error section node preserved");
  assert.equal(card.querySelector("#dz-error-message").textContent, "Network timeout contacting server.");
});

test("error layering: plain message prominent, engine diagnostics only in technical details", () => {
  const el = container();
  const aggregate =
    "no discovery candidate accepted the input\n" +
    " - custom: not a tiles.yaml file\n" +
    " - google_arts_and_culture: The website hosting this image limits how many pages our server may request from it.";
  const state = {
    status: "failed",
    seq: 1,
    sessionId: "s3",
    imageCount: 0,
    transport: "proxy",
    error: {
      code: "UPSTREAM_RATE_LIMITED",
      category: "transport",
      retryable: true,
      message:
        "The website hosting this image limits how many pages our server may request from it, and that limit was just reached, so the page could not be opened.",
      detail: aggregate,
      transport: "proxy",
      phase: "discovery",
    },
  };
  render(el, state, callbacks);
  const card = el.querySelector(".dz-card");
  const prominent = card.querySelector("#dz-error-message").textContent;
  assert.ok(!prominent.includes("discovery candidate"), "aggregate must not be prominent");
  assert.ok(!prominent.includes("custom:"), "per-format diagnostics must not be prominent");
  const diagnostics = card.querySelector("#dz-error-diagnostics").textContent;
  assert.match(diagnostics, /Code: UPSTREAM_RATE_LIMITED/);
  assert.match(diagnostics, /no discovery candidate accepted the input/);
  assert.match(diagnostics, / - custom: not a tiles\.yaml file/);
  const state2 = { ...state, seq: 2, error: { ...state.error, detail: undefined } };
  render(el, state2, callbacks);
  const diag2 = card.querySelector("#dz-error-diagnostics").textContent;
  assert.match(diag2, /Message: The website hosting this image/);
  assert.ok(!diag2.includes("no discovery candidate"), "stale detail must be replaced");
});

test("job rail keeps integrated stop and diagnostics-copy controls, and header visibility tracks phase", () => {
  const el = container();
  render(el, { status: "idle", seq: 1, sessionId: "s1", imageCount: 0 }, callbacks);
  const card = el.querySelector(".dz-card");
  const header = card.querySelector(".dz-header");
  assert.ok(header, "header exists");
  assert.equal(header.style.display, "", "header visible in idle");

  render(
    el,
    { status: "downloading", seq: 2, sessionId: "s1", imageCount: 2, transport: "direct" },
    callbacks,
    { currentProgress: { current: 10, total: 50 }, imageChoice: { width: 4000, height: 3000, tiles: 50 } },
  );
  assert.equal(header.style.display, "none", "header hidden in job phase");
  const stopBtn = card.querySelector("#dz-btn-cancel");
  assert.ok(stopBtn, "stop button exists on the progress rail");
  assert.ok(stopBtn.classList.contains("dz-progress-control"), "stop button uses compact rail-control styling");
  const copyBtn = card.querySelector("#dz-btn-copy-diagnostics");
  assert.ok(copyBtn, "technical details include a diagnostics copy control");

  render(
    el,
    { status: "failed", seq: 3, sessionId: "s1", imageCount: 0, error: { code: "FAILED", category: "transport", retryable: true, message: "Error" } },
    callbacks,
  );
  assert.equal(header.style.display, "none", "header hidden in failed phase");

  render(el, { status: "idle", seq: 4, sessionId: "s1", imageCount: 0 }, callbacks);
  assert.equal(header.style.display, "", "header reappears in idle");
});

test("paused job activity freezes the displayed elapsed time", () => {
  const el = container();
  render(
    el,
    { status: "downloading", seq: 1, sessionId: "s1", imageCount: 1, transport: "direct" },
    { onSubmitUrl: () => {}, onCancel: () => {}, onReset: () => {} },
    {
      currentProgress: { current: 3, total: 10 },
      paused: true,
      jobActivity: { startedAt: 1_000, pausedAt: 4_000, now: 12_000, paused: true },
    },
  );
  const card = el.querySelector(".dz-card");
  assert.match(card.querySelector("#dz-job-time").textContent, /^3 s/);
  assert.ok(card.querySelector(".dz-job-section").classList.contains("dz-job-paused"));
});

test("CSS structural invariants prevent button clipping, container overflow, and layout shifts", () => {
  const css = fs.readFileSync(path.join(rootDir, "packages/shared-ui/src/styles/theme.css"), "utf8");

  assert.match(css, /\.dz-btn-secondary\s*\{[^}]*min-height:\s*38px;/);
  assert.doesNotMatch(css, /\.dz-btn-secondary\s*\{[^}]*(?<![a-z-])height:\s*38px;/);
  assert.match(css, /\.dz-progress-rail\s*\{[^}]*grid-template-columns:\s*auto\s+minmax\(0,\s*1fr\);/);
  assert.match(css, /\.dz-progress-buttons\s*\{[^}]*display:\s*flex;/);
  assert.match(css, /\.dz-progress-control\s*\{[^}]*border:\s*0;/);
  assert.match(css, /\.dz-progress-control\s*\{[^}]*background:\s*transparent;/);
  assert.match(css, /\.dz-btn-link,\s*\.dz-link-button\s*\{[^}]*display:\s*inline;/);
  assert.match(css, /\.dz-btn-link,\s*\.dz-link-button\s*\{[^}]*background:\s*transparent;/);
  assert.match(css, /\.dz-btn-link,\s*\.dz-link-button\s*\{[^}]*text-decoration:\s*underline;/);
  assert.doesNotMatch(css, /\.dz-guidance-item,\s*\.dz-suggestion-card\s*\{[^}]*border-top:/);
  assert.match(css, /\.dz-progress-percent,\s*\.dz-progress-count\s*\{[^}]*flex-shrink:\s*0;/);
  assert.match(css, /\.dz-progress-percent,\s*\.dz-progress-count\s*\{[^}]*tabular-nums;/);
  assert.match(css, /\.dz-progress-status\s*\{[^}]*min-width:\s*0;/);
  assert.ok(css.includes("max-width: 560px") && css.includes("flex-direction: column"));
  assert.ok(css.includes("max-width: 380px"));
});
