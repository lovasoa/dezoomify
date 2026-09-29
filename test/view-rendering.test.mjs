import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { createDiagnosticRecorder } from "../packages/shared-ui/src/diagnostics.ts";
import { PartialDecisionActions } from "../packages/shared-ui/src/partial-decision.tsx";
import {
  presentFailure,
  presentIdle,
  presentOutput,
  presentProgress,
  presentStatus,
} from "../packages/shared-ui/src/presentation.ts";
import { renderView } from "../packages/shared-ui/src/view.tsx";
import { act, click } from "./react-dom.mjs";

function container() {
  const el = globalThis.document.createElement("div");
  globalThis.document.body.appendChild(el);
  return el;
}

function render(el, presentation, callbacks, ctx) {
  const d = createDiagnosticRecorder({ id: "view", now: () => 0 });
  if (presentation.error) d.finish("failed", presentation.error);
  act(() =>
    renderView(
      el,
      presentation,
      { onCopyDiagnostics() {}, ...callbacks },
      { diagnosticReport: d.report(), ...ctx },
    ),
  );
}

function failurePresentation(error) {
  return presentFailure(error);
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

  render(el, presentProgress({ phase: "discovery", completed: 0, total: null }), callbacks, ctx);
  assert.equal(card.dataset.viewPhase, "job");
  const jobSec = card.querySelector(".dz-job-section");
  assert.ok(jobSec, "job section mounted");
  const stepTextEl = card.querySelector("#dz-job-step-text");
  assert.ok(stepTextEl);
  assert.equal(stepTextEl.textContent, "Finding the zoomable image…");

  // User opens technical details
  const details = card.querySelector(".dz-details");
  assert.ok(details);
  details.open = true;

  // 3. Heartbeat update / progress ticks during job
  render(el, presentProgress({ phase: "acquisition", completed: 15, total: 60 }), callbacks, {
    ...ctx,
    jobActivity: {
      ...ctx.jobActivity,
      completedRequests: 15,
      pendingRequests: 4,
    },
  });

  // Card and job section MUST be the exact same DOM node references.
  assert.equal(el.querySelector(".dz-card"), card, "card node preserved across job updates");
  assert.equal(
    card.querySelector(".dz-job-section"),
    jobSec,
    "job section node preserved across job updates",
  );

  // The step line renders the presentation headline, never host copy.
  assert.equal(stepTextEl.textContent, "Saving image tiles…");
  const countsEl = card.querySelector("#dz-job-counts");
  assert.equal(countsEl.textContent, "15 done / 60");
  const barEl = card.querySelector("#dz-job-bar");
  assert.equal(barEl.style.width, "25%");

  // Uncontrolled details open state is preserved natively.
  assert.equal(details.open, true, "open details preserved across in-place updates");

  // 4. Rapid heartbeat / progress ticks
  const tickPresentation = presentProgress({ phase: "acquisition", completed: 15, total: 60 });
  for (let tick = 1; tick <= 10; tick++) {
    render(el, tickPresentation, callbacks, {
      ...ctx,
      jobActivity: {
        ...ctx.jobActivity,
        pendingRequests: tick % 3,
        completedRequests: 15 + tick,
      },
    });
    assert.equal(
      card.querySelector(".dz-job-section"),
      jobSec,
      `tick ${tick}: DOM reference must stay identical`,
    );
    assert.equal(details.open, true, `tick ${tick}: open details must never close`);
  }

  // 5. Transition to completed
  render(
    el,
    presentOutput(
      {
        format: "png",
        complete: true,
        missing: [],
        disposition: "browser-save-ready",
        canvas: { width: 4000, height: 3000 },
      },
      { phase: "acquisition", completed: 0, total: null },
    ),
    callbacks,
  );
  assert.equal(card.dataset.viewPhase, "completed");
  assert.equal(card.querySelector(".dz-job-section"), null, "job section unmounted on completion");
  assert.ok(card.querySelector(".dz-completed-section"), "completed section mounted");

  // 6. Reset back to idle
  render(el, presentIdle(), callbacks);
  assert.equal(card.dataset.viewPhase, "idle");
  assert.ok(card.querySelector(".dz-form"), "idle form re-mounted after reset");
});

test("output actions belong to their completed result", async () => {
  const el = container();
  const old = Promise.withResolvers();
  const done = presentOutput(
    { format: "png", complete: true, missing: [], disposition: "native-publication" },
    { phase: "acquisition", completed: 0, total: null },
  );
  render(el, done, { ...callbacks, onOpenOutput: () => old.promise }, { outputKey: "old" });
  click(el.querySelector("#dz-btn-open"));
  assert.equal(el.querySelector("#dz-btn-open").disabled, true);

  render(el, done, { ...callbacks, onOpenOutput: async () => {} }, { outputKey: "new" });
  await act(async () => old.reject({ code: "output.not-found" }));
  assert.equal(el.querySelector("#dz-open-error"), null);
  assert.equal(el.querySelector("#dz-btn-open").disabled, false);
});

test("partial controls return the selected choice", () => {
  const el = container();
  const answers = [];
  act(() =>
    renderView(el, presentIdle(), callbacks, undefined, {
      after: createElement(PartialDecisionActions, {
        decision: {
          missing: [{ tile: 1, failures: [{ retryable: true, code: "TRANSPORT_TIMEOUT" }] }],
        },
        onAnswer: (command) => answers.push(command),
      }),
    }),
  );
  for (const choice of ["keep", "discard", "retry"])
    click(el.querySelector(`[data-dz-partial-choice="${choice}"]`));
  assert.deepEqual(answers, ["keep", "discard", "retry"]);
});

test("partial refusal is a static decision with useful actions before diagnostics", () => {
  const el = container();
  const decision = {
    missing: [
      { tile: 1, failures: [{ code: "TRANSPORT_HTTP_ERROR", retryable: false, http: 403 }] },
    ],
  };
  const presentation = {
    ...presentProgress({ phase: "acquisition", completed: 3, total: 4 }),
    decision,
  };
  act(() =>
    renderView(
      el,
      presentation,
      callbacks,
      { diagnosticReport: createDiagnosticRecorder({ id: "partial", now: () => 0 }).report() },
      {
        after: createElement(PartialDecisionActions, { decision, onAnswer() {} }),
      },
    ),
  );
  assert.match(el.textContent, /The image is incomplete/);
  assert.match(el.textContent, /3 of 4 tiles/);
  assert.match(el.textContent, /website refused/);
  assert.match(el.textContent, /Save incomplete image/);
  assert.equal(el.querySelector("[role=progressbar]"), null);
  assert.equal(el.querySelector(".dz-pulse"), null);
  assert.equal(el.querySelector("[data-dz-partial-choice=retry]"), null);
  assert.ok(
    el.innerHTML.indexOf("data-dz-partial-decision") < el.innerHTML.indexOf("dz-job-diagnostics"),
  );
});

test("zero-tile refusal has no partial controls and opens the source", () => {
  const el = container();
  let opened = false;
  render(
    el,
    presentFailure({
      code: "job.no-usable-tiles",
      phase: "acquisition",
      transport: "browser-session",
      message: "None retrieved",
      http: 403,
      retryable: false,
    }),
    {
      ...callbacks,
      onOpenSource() {
        opened = true;
      },
    },
  );
  assert.match(el.textContent, /website refused access/);
  assert.match(el.textContent, /No file was saved/);
  assert.equal(el.querySelector("[role=progressbar]"), null);
  assert.equal(el.querySelector("[data-dz-partial-decision]"), null);
  click(
    [...el.querySelectorAll("button")].find((button) => button.textContent === "Open source page"),
  );
  assert.equal(opened, true);
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
  render(el, presentProgress({ phase: "discovery", completed: 0, total: null }), callbacks, ctx);
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
    phase: "discovery",
    retryable: false,
    message: "No zoomable image could be found.",
  });
  render(el, errPresentation1, callbacks);
  const card = el.querySelector(".dz-card");
  assert.equal(card.dataset.viewPhase, "failed");
  const errSec = card.querySelector(".dz-error-section");
  assert.ok(errSec, "error section mounted");
  assert.equal(
    card.querySelector("#dz-error-message").textContent,
    "No zoomable image could be found.",
  );

  const errPresentation2 = failurePresentation({
    code: "NO_IMAGE_FOUND",
    phase: "discovery",
    retryable: false,
    message: "Network timeout contacting server.",
  });
  render(el, errPresentation2, callbacks);
  assert.equal(card.querySelector(".dz-error-section"), errSec, "error section node preserved");
  assert.equal(
    card.querySelector("#dz-error-message").textContent,
    "Network timeout contacting server.",
  );
});

test("error layering: plain message prominent, parser diagnostics only in technical details", () => {
  const el = container();
  const details =
    " - zoomify, iiif, krpano: HTTP 429 fetching this address\n" +
    " - 2 other format(s) did not match this page address";
  const presentation = failurePresentation({
    code: "UPSTREAM_RATE_LIMITED",
    retryable: true,
    message:
      "The website hosting this image limits how many pages our server may request from it, and that limit was just reached, so the page could not be opened.",
    detail: details,
    transport: "metadata-proxy",
    phase: "discovery",
    request: "https://example.test/viewer/tour.xml?sig=abc&lang=fr",
    http: 429,
    preview: "Too many requests",
  });
  render(el, presentation, callbacks);
  const card = el.querySelector(".dz-card");
  const prominent = card.querySelector("#dz-error-message").textContent;
  assert.ok(!prominent.includes("zoomify"), "parser details must not be prominent");
  assert.ok(!prominent.includes("429"), "status must not be prominent");
  const diagnostics = card.querySelector("#dz-job-diagnostics").textContent;
  assert.match(diagnostics, /http=429/);
  assert.match(diagnostics, /Too many requests/);
  assert.match(diagnostics, /sig=abc&lang=fr/);
  assert.ok(diagnostics.includes(details));
  // A fresh failure without url/http/detail renders only the trailing line.
  const fresh = failurePresentation({
    code: "NO_IMAGE_FOUND",
    retryable: false,
    message: "No zoomable image could be found.",
    transport: "direct-browser",
    phase: "discovery",
  });
  render(el, fresh, callbacks);
  const diag2 = card.querySelector("#dz-job-diagnostics").textContent;
  assert.match(diag2, /code=NO_IMAGE_FOUND/);
  assert.ok(!diag2.includes("example.test"), "stale detail must be replaced");
});

test("only extension technical details show the conditional sign-in note", () => {
  const el = container();
  for (const product of ["extension", "website", "desktop"]) {
    const d = createDiagnosticRecorder({ id: product, now: () => 0, context: { product } });
    render(el, presentStatus("discovering"), callbacks, { diagnosticReport: d.report() });
    assert.equal(
      el.querySelector(".dz-details").textContent.includes("If this site requires you to sign in"),
      product === "extension",
    );
  }
});

test("job rail keeps integrated stop and diagnostics-copy controls, and header visibility tracks phase", () => {
  const el = container();
  render(el, presentIdle(), callbacks);
  const card = el.querySelector(".dz-card");
  const header = card.querySelector(".dz-header");
  assert.ok(header, "header exists");
  assert.equal(header.style.display, "", "header visible in idle");

  render(el, presentProgress({ phase: "acquisition", completed: 10, total: 50 }), callbacks);
  assert.equal(header.style.display, "none", "header hidden in job phase");
  const stopBtn = card.querySelector("#dz-btn-cancel");
  assert.ok(stopBtn, "stop button exists on the progress rail");
  assert.ok(
    stopBtn.classList.contains("dz-progress-control"),
    "stop button uses compact rail-control styling",
  );
  const copyBtn = card.querySelector("#dz-btn-copy-diagnostics");
  assert.ok(copyBtn, "technical details include a diagnostics copy control");

  render(
    el,
    failurePresentation({
      code: "FAILED",
      phase: "acquisition",
      retryable: true,
      message: "Error",
    }),
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
    presentProgress({ phase: "acquisition", completed: 3, total: 10 }, { paused: true }),
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
    code: "TRANSPORT_NETWORK_ERROR",
    phase: "acquisition",
    retryable: true,
    message: "The network failed.",
  });
  let retried = 0;
  let resets = 0;
  const withBoth = {
    ...callbacks,
    onReset: () => {
      resets += 1;
    },
    onRetrySameUrl: () => {
      retried += 1;
    },
  };
  render(el, retryable, withBoth);
  const card = el.querySelector(".dz-card");
  const retry = card.querySelector("#dz-btn-try-again");
  assert.ok(retry, "retry offered for a retryable error");
  assert.ok(
    card.querySelector("#dz-btn-start-over"),
    "start over offered when the host provides a reset",
  );
  click(retry);
  assert.equal(retried, 1, "retry invokes onRetrySameUrl");
  assert.equal(resets, 0, "retry never falls through to reset");

  const nonRetryable = failurePresentation({
    code: "TRANSPORT_NETWORK_ERROR",
    phase: "acquisition",
    retryable: false,
    message: "The network failed.",
  });
  render(el, nonRetryable, withBoth);
  assert.equal(card.querySelector("#dz-btn-try-again"), null, "no retry for a non-retryable error");
  assert.ok(card.querySelector("#dz-btn-start-over"), "start over stays available");

  const noReset = {
    onSubmitUrl: () => {},
    onCancel: () => {},
    onRetrySameUrl: () => {
      retried += 1;
    },
  };
  render(el, nonRetryable, noReset);
  assert.equal(card.querySelector("#dz-btn-try-again"), null);
  assert.equal(
    card.querySelector("#dz-btn-start-over"),
    null,
    "no start over when the host cannot reset",
  );
  render(el, retryable, noReset);
  assert.equal(
    card.querySelector("#dz-btn-start-over"),
    null,
    "retry-only host never shows start over",
  );
  click(card.querySelector("#dz-btn-try-again"));
  assert.equal(retried, 2, "retry stays wired without a reset callback");
});

test("resolution notice offers maximum retry and stop while fetching, keeps the choice when done", () => {
  const el = container();
  let stopped = 0;
  let tried = 0;
  const actions = {
    onSubmitUrl: () => {},
    onCancel: () => {
      stopped += 1;
    },
    onReset: () => {},
    onTryMaximum: () => {
      tried += 1;
    },
  };
  render(
    el,
    presentProgress({
      phase: "acquisition",
      completed: 1,
      total: 4,
      selected: { width: 20000, height: 10000 },
      maximum: { width: 40000, height: 20000 },
    }),
    actions,
  );
  assert.ok(el.querySelector("#dz-resolution-notice"), "shown while tiles are still in flight");
  const sizes = el.querySelector("#dz-resolution-sizes").textContent;
  assert.match(sizes, /20000×10000/, "selected resolution");
  assert.match(sizes, /40000×20000/, "maximum resolution");
  assert.match(el.querySelector("#dz-resolution-message").textContent, /maximal resolution/i);
  click(el.querySelector("#dz-btn-try-maximum"));
  assert.equal(tried, 1, "Try maximum restarts at the maximum known resolution");
  assert.ok(el.querySelector("#dz-btn-resolution-stop"));
  click(el.querySelector("#dz-btn-resolution-stop"));
  assert.equal(stopped, 1, "Stop ends the smaller download");

  render(
    el,
    presentOutput(
      { format: "png", complete: true, missing: [], disposition: "browser-save-ready" },
      {
        phase: "acquisition",
        completed: 4,
        total: 4,
        selected: { width: 20000, height: 10000 },
        maximum: { width: 40000, height: 20000 },
      },
    ),
    actions,
  );
  assert.ok(el.querySelector("#dz-resolution-notice"), "the offer survives completion");
  assert.equal(el.querySelector("#dz-btn-resolution-stop"), null, "stop is gone once done");
  assert.ok(el.querySelector("#dz-btn-try-maximum"));
});

test("hosts without a maximum retry never show the resolution notice", () => {
  const el = container();
  render(
    el,
    presentProgress({
      phase: "acquisition",
      completed: 1,
      total: 4,
      selected: { width: 20000, height: 10000 },
      maximum: { width: 40000, height: 20000 },
    }),
    callbacks,
  );
  assert.equal(el.querySelector("#dz-resolution-notice"), null);
});
