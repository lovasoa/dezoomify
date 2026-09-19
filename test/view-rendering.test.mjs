import test from "node:test";
import assert from "node:assert/strict";
import { act, click } from "./react-dom.mjs";
import { renderView } from "../packages/shared-ui/src/view.tsx";
import { presentFailure, presentIdle, presentSnapshot, presentStatus } from "../packages/shared-ui/src/snapshot-view.ts";
import { applyJobEvent, initialSnapshot } from "../packages/app-model/src/index.ts";

function container() {
  const el = globalThis.document.createElement("div");
  globalThis.document.body.appendChild(el);
  return el;
}

function render(el, presentation, callbacks, ctx) {
  act(() => renderView(el, presentation, callbacks, ctx));
}

function jobPresentation(events = [], transport = "direct") {
  let now = 0;
  let snap = initialSnapshot("job:t", ++now);
  for (const event of events) snap = applyJobEvent(snap, event, ++now);
  return presentSnapshot(snap, transport);
}

function failurePresentation(error, transport = "direct") {
  return presentFailure(error, transport);
}

const callbacks = {
  onSubmitUrl: () => {},
  onCancel: () => {},
  onReset: () => {},
  onSave: () => {},
};

test("presentStatus maps host steps onto render phases", () => {
  assert.equal(presentStatus("idle").phase, "idle");
  assert.equal(presentStatus("discovering").phase, "job");
  assert.equal(presentStatus("choosing-image").phase, "job");
  assert.equal(presentStatus("choosing-level").phase, "job");
  assert.equal(presentStatus("preflighting").phase, "job");
  assert.equal(presentStatus("downloading").phase, "job");
  assert.equal(presentStatus("saving").phase, "job");
  assert.equal(presentStatus("display-only").phase, "display-only");
  assert.equal(presentStatus("completed").phase, "completed");
  assert.equal(presentStatus("failed").phase, "failed");
  assert.equal(presentStatus("cancelled").phase, "cancelled");
  assert.equal(presentIdle().phase, "idle");
});

test("renderView mounts card and updates job section in place without DOM destruction", () => {
  const el = container();

  // 1. Initial idle render
  render(el, presentIdle(), callbacks);
  const card = el.querySelector(".dz-card");
  assert.ok(card, "status card mounted");
  assert.equal(card.dataset.viewPhase, "idle");
  assert.ok(card.querySelector(".dz-form"), "form mounted in idle view");

  // 2. Transition to discovering (active job phase)
  const ctx = {
    jobActivity: {
      url: "https://museum.example.org/artwork/1",
      startedAt: Date.now() - 3000,
    },
  };

  render(el, jobPresentation([{ type: "job-state", state: "Discovering" }]), callbacks, ctx);
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
  render(
    el,
    jobPresentation([
      { type: "job-state", state: "Discovering" },
      { type: "job-state", state: "AcquiringTiles" },
      { type: "progress", acquired: 15, total: 60 },
    ]),
    callbacks,
    {
      ...ctx,
      jobActivity: {
        ...ctx.jobActivity,
        completedRequests: 15,
        pendingRequests: 4,
      },
    },
  );

  // Card and job section MUST be the exact same DOM node references.
  assert.equal(el.querySelector(".dz-card"), card, "card node preserved across job updates");
  assert.equal(card.querySelector(".dz-job-section"), jobSec, "job section node preserved across job updates");

  // The step line renders the presentation headline, never host copy.
  assert.equal(stepTextEl.textContent, "Saving image tiles…");
  const countsEl = card.querySelector("#dz-job-counts");
  assert.equal(countsEl.textContent, "15 done / 60");
  const barEl = card.querySelector("#dz-job-bar");
  assert.equal(barEl.style.width, "25%");

  // Uncontrolled details open state is preserved natively.
  assert.equal(details.open, true, "open details preserved across in-place updates");

  // 4. Rapid heartbeat / progress ticks
  const tickPresentation = jobPresentation([
    { type: "job-state", state: "AcquiringTiles" },
    { type: "progress", acquired: 15, total: 60 },
  ]);
  for (let tick = 1; tick <= 10; tick++) {
    render(el, tickPresentation, callbacks, {
      ...ctx,
      jobActivity: {
        ...ctx.jobActivity,
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
    jobPresentation([{ type: "completed" }]),
    callbacks,
    { completedInfo: { width: 4000, height: 3000, mime: "image/png" } },
  );
  assert.equal(card.dataset.viewPhase, "completed");
  assert.equal(card.querySelector(".dz-job-section"), null, "job section unmounted on completion");
  assert.ok(card.querySelector(".dz-completed-section"), "completed section mounted");

  // 6. Reset back to idle
  render(el, presentIdle(), callbacks);
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
    },
  };
  render(el, jobPresentation([{ type: "job-state", state: "Discovering" }]), callbacks, ctx);
  const card = el.querySelector(".dz-card");
  const step = card.querySelector("#dz-job-step-text");
  assert.ok(step, "job status shown while stalled");
  assert.equal(step.textContent, "Waiting for artsandculture.google.com…");
  assert.doesNotMatch(step.textContent, /museum/i);
});

test("failed state updates error details in place without destroying error container", () => {
  const el = container();
  const errPresentation1 = failurePresentation({
    code: "NO_IMAGE_FOUND",
    category: "discovery",
    retryable: false,
    message: "No zoomable image could be found.",
  });
  render(el, errPresentation1, callbacks);
  const card = el.querySelector(".dz-card");
  assert.equal(card.dataset.viewPhase, "failed");
  const errSec = card.querySelector(".dz-error-section");
  assert.ok(errSec, "error section mounted");
  assert.equal(card.querySelector("#dz-error-message").textContent, "No zoomable image could be found.");

  const errPresentation2 = failurePresentation({
    code: "NO_IMAGE_FOUND",
    category: "discovery",
    retryable: false,
    message: "Network timeout contacting server.",
  });
  render(el, errPresentation2, callbacks);
  assert.equal(card.querySelector(".dz-error-section"), errSec, "error section node preserved");
  assert.equal(card.querySelector("#dz-error-message").textContent, "Network timeout contacting server.");
});

test("error layering: plain message prominent, engine diagnostics only in technical details", () => {
  const el = container();
  const engineBlock =
    " - zoomify, iiif, krpano: HTTP 429 fetching this address\n" +
    " - 2 other format(s) did not match this page address";
  const presentation = failurePresentation({
    code: "UPSTREAM_RATE_LIMITED",
    category: "transport",
    retryable: true,
    message:
      "The website hosting this image limits how many pages our server may request from it, and that limit was just reached, so the page could not be opened.",
    detail: engineBlock,
    transport: "metadata-proxy",
    phase: "discovery",
    url: "https://example.test/viewer/tour.xml?sig=abc&lang=fr",
    http: 429,
    preview: "Too many requests",
  });
  render(el, presentation, callbacks);
  const card = el.querySelector(".dz-card");
  const prominent = card.querySelector("#dz-error-message").textContent;
  assert.ok(!prominent.includes("zoomify"), "engine block must not be prominent");
  assert.ok(!prominent.includes("429"), "status must not be prominent");
  const diagnostics = card.querySelector("#dz-error-diagnostics").textContent;
  const lines = diagnostics.split("\n");
  // Four-part order: url, http, server, blank, engine block, blank, trailing.
  assert.equal(lines[0], "url: https://example.test/viewer/tour.xml?sig=abc&lang=fr");
  assert.equal(lines[1], "http: 429");
  assert.equal(lines[2], "server: Too many requests");
  assert.equal(lines[3], "");
  assert.equal(lines[4], " - zoomify, iiif, krpano: HTTP 429 fetching this address");
  assert.equal(lines[5], " - 2 other format(s) did not match this page address");
  assert.equal(lines[6], "");
  assert.equal(
    lines[7],
    "code:UPSTREAM_RATE_LIMITED category:transport retryable:true transport:metadata-proxy phase:discovery http:429",
  );
  assert.equal(lines.length, 8, "exactly one trailing line, nothing after it");
  // No headline repetition, no JSON, no label style from the old shape.
  assert.ok(!diagnostics.includes("no discovery candidate"), "no engine headline");
  assert.ok(!diagnostics.includes("Message:"), "no prominent-message repetition");
  assert.ok(!diagnostics.includes("{"), "no JSON");
  // A fresh failure without url/http/detail renders only the trailing line.
  const fresh = failurePresentation({
    code: "NO_IMAGE_FOUND",
    category: "discovery",
    retryable: false,
    message: "No zoomable image could be found.",
    transport: "direct",
    phase: "discovery",
  });
  render(el, fresh, callbacks);
  const diag2 = card.querySelector("#dz-error-diagnostics").textContent;
  assert.equal(
    diag2,
    "code:NO_IMAGE_FOUND category:discovery retryable:false transport:direct phase:discovery",
  );
  assert.ok(!diag2.includes("example.test"), "stale detail must be replaced");
});

test("failed technical details show the activity log below the error diagnostics", () => {
  const el = container();
  const presentation = failurePresentation({
    code: "job.partial-discarded",
    category: "engine",
    retryable: false,
    message: "Discarded.",
  });
  const ctx = {
    jobActivity: { log: ["[job] engine-start url=https://example.test/a.dzi", "[worker] session-created jobId=job:1"] },
  };
  render(el, presentation, callbacks, ctx);
  const card = el.querySelector(".dz-card");
  const log = card.querySelector("#dz-error-log");
  assert.ok(log, "log block mounted in failure details");
  assert.equal(
    log.textContent,
    "[job] engine-start url=https://example.test/a.dzi\n[worker] session-created jobId=job:1",
  );
  assert.ok(!card.querySelector("#dz-error-diagnostics").textContent.includes("engine-start"));

  const empty = container();
  render(empty, presentation, callbacks, {});
  assert.equal(empty.querySelector(".dz-card").querySelector("#dz-error-log"), null, "no log block without logs");
});

test("job rail keeps integrated stop and diagnostics-copy controls, and header visibility tracks phase", () => {
  const el = container();
  render(el, presentIdle(), callbacks);
  const card = el.querySelector(".dz-card");
  const header = card.querySelector(".dz-header");
  assert.ok(header, "header exists");
  assert.equal(header.style.display, "", "header visible in idle");

  render(
    el,
    jobPresentation([
      { type: "job-state", state: "AcquiringTiles" },
      { type: "progress", acquired: 10, total: 50 },
    ]),
    callbacks,
  );
  assert.equal(header.style.display, "none", "header hidden in job phase");
  const stopBtn = card.querySelector("#dz-btn-cancel");
  assert.ok(stopBtn, "stop button exists on the progress rail");
  assert.ok(stopBtn.classList.contains("dz-progress-control"), "stop button uses compact rail-control styling");
  const copyBtn = card.querySelector("#dz-btn-copy-diagnostics");
  assert.ok(copyBtn, "technical details include a diagnostics copy control");

  render(
    el,
    failurePresentation({ code: "FAILED", category: "transport", retryable: true, message: "Error" }),
    callbacks,
  );
  assert.equal(header.style.display, "none", "header hidden in failed phase");

  render(el, presentIdle(), callbacks);
  assert.equal(header.style.display, "", "header reappears in idle");
});

test("paused job activity freezes the displayed elapsed time", () => {
  const el = container();
  render(
    el,
    jobPresentation([
      { type: "job-state", state: "AcquiringTiles" },
      { type: "progress", acquired: 3, total: 10 },
      { type: "paused" },
    ]),
    { onSubmitUrl: () => {}, onCancel: () => {}, onReset: () => {} },
    {
      jobActivity: { startedAt: 1_000, pausedAt: 4_000, now: 12_000, paused: true },
    },
  );
  const card = el.querySelector(".dz-card");
  assert.match(card.querySelector("#dz-job-time").textContent, /^3 s/);
  assert.ok(card.querySelector(".dz-job-section").classList.contains("dz-job-paused"));
});

test("failed view offers retry only for retryable errors and start over only when the host can reset", () => {
  const el = container();
  const retryable = failurePresentation({
    code: "transport.network-error",
    category: "transport",
    retryable: true,
    message: "The network failed.",
  });
  let retried = 0;
  let resets = 0;
  const withBoth = { ...callbacks, onReset: () => { resets += 1; }, onRetrySameUrl: () => { retried += 1; } };
  render(el, retryable, withBoth);
  const card = el.querySelector(".dz-card");
  const retry = card.querySelector("#dz-btn-try-again");
  assert.ok(retry, "retry offered for a retryable error");
  assert.ok(card.querySelector("#dz-btn-start-over"), "start over offered when the host provides a reset");
  click(retry);
  assert.equal(retried, 1, "retry invokes onRetrySameUrl");
  assert.equal(resets, 0, "retry never falls through to reset");

  const nonRetryable = failurePresentation({
    code: "transport.network-error",
    category: "transport",
    retryable: false,
    message: "The network failed.",
  });
  render(el, nonRetryable, withBoth);
  assert.equal(card.querySelector("#dz-btn-try-again"), null, "no retry for a non-retryable error");
  assert.ok(card.querySelector("#dz-btn-start-over"), "start over stays available");

  const noReset = { onSubmitUrl: () => {}, onCancel: () => {}, onRetrySameUrl: () => { retried += 1; } };
  render(el, nonRetryable, noReset);
  assert.equal(card.querySelector("#dz-btn-try-again"), null);
  assert.equal(card.querySelector("#dz-btn-start-over"), null, "no start over when the host cannot reset");
  render(el, retryable, noReset);
  assert.equal(card.querySelector("#dz-btn-start-over"), null, "retry-only host never shows start over");
  click(card.querySelector("#dz-btn-try-again"));
  assert.equal(retried, 2, "retry stays wired without a reset callback");
});
