import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseHTML } from "linkedom";
import { createDiagnosticRecorder } from "../packages/shared-ui/src/diagnostics.ts";
import { SUPPORTED_LOCALES, setLocale, t } from "../packages/shared-ui/src/i18n.ts";
import {
  presentFailure,
  presentIdle,
  presentOutput,
  presentProgress,
  presentStatus,
} from "../packages/shared-ui/src/presentation.ts";
import { renderView } from "../packages/shared-ui/src/view.tsx";
import { localizeWebsite } from "../src/copy.ts";
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

test("website navigation, preview controls, and save guidance follow the selected language", () => {
  const { document } = parseHTML(readFileSync(new URL("../index.html", import.meta.url), "utf8"));
  const el = document.querySelector("#app");
  try {
    for (const locale of SUPPORTED_LOCALES) {
      setLocale(locale);
      localizeWebsite(document);
      assert.equal(
        document.querySelector("#dz-nav-btn-desktop").textContent,
        t("page.nav.desktop"),
      );
      assert.equal(
        document.querySelector("#preview-zoom-fit").getAttribute("aria-label"),
        t("page.preview.fitLabel"),
      );
      assert.equal(document.querySelector(".dz-brand svg").tagName.toLowerCase(), "svg");
      assert.equal(
        document.querySelector("#dz-legacy-notice-title").textContent,
        t("page.legacy.title"),
      );
      assert.equal(
        document.querySelector("#dz-legacy-notice-link").textContent,
        t("page.legacy.link"),
      );
      assert.equal(
        document.querySelector("#dz-legacy-notice-close").getAttribute("aria-label"),
        t("view.modal.closeTitle"),
      );
      render(
        el,
        presentOutput({
          format: "png",
          canvas: { width: 512, height: 256 },
          disposition: "browser-save-ready",
        }),
        callbacks,
      );
      assert.equal(el.querySelector(".dz-completed-guidance").textContent, t("view.done.guidance"));
      assert.match(el.querySelector(".dz-completed-summary").textContent, /512.*256/);
      render(el, presentOutput({ format: "png", disposition: "display-only" }), callbacks);
      assert.equal(el.querySelector(".dz-notice-message").textContent, t("view.display.guidance"));
      assert.equal(el.querySelector("#dz-btn-save"), null);
    }
  } finally {
    setLocale("en");
  }
});

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
      startedAt: 0,
      now: 3_000,
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
  assert.equal(stepTextEl.textContent, "Downloading image pieces…");
  const countsEl = card.querySelector("#dz-job-counts");
  assert.equal(countsEl.textContent, "15 of 60 image pieces");
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

  // Assembly replaces tile counts with pixel progress, including accessibility.
  for (const [current, total, counts, percent] of [
    [0, 32, "0 px of 32 px", "0%"],
    [24, 32, "24 px of 32 px", "75%"],
    [1e6, 2e6, "1 Mpx of 2 Mpx", "50%"],
    [3e6, 5e9, "3 Mpx of 5 Gpx", "0.06%"],
    [1.5e9, 5e9, "1.5 Gpx of 5 Gpx", "30%"],
  ]) {
    render(
      el,
      presentProgress({
        phase: "output",
        completed: 60,
        total: 60,
        preparation: { completed_pixels: current, total_pixels: total },
      }),
      callbacks,
      ctx,
    );
    const track = card.querySelector("#dz-job-track");
    assert.equal(countsEl.textContent, counts);
    assert.equal(barEl.style.width, percent);
    assert.equal(track.getAttribute("aria-valuenow"), String(current));
    assert.equal(track.getAttribute("aria-valuemax"), String(total));
    assert.equal(track.getAttribute("aria-valuetext"), counts);
    assert.equal(card.querySelector("#dz-btn-pause").style.display, "none");
    assert.ok(!card.querySelector("#dz-job-time").textContent.includes("~"));
  }

  // 5. Transition to completed
  render(
    el,
    presentOutput(
      {
        format: "png",

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
    { format: "png", disposition: "native-publication" },
    { phase: "acquisition", completed: 0, total: null },
  );
  render(el, done, { ...callbacks, onOpenOutput: () => old.promise }, { outputKey: "old" });
  click(el.querySelector("#dz-btn-open"));
  assert.equal(el.querySelector("#dz-btn-open").disabled, true);

  render(el, done, { ...callbacks, onOpenOutput: async () => {} }, { outputKey: "new" });
  await act(async () => old.reject({ kind: "output-not-found" }));
  assert.equal(el.querySelector("#dz-open-error"), null);
  assert.equal(el.querySelector("#dz-btn-open").disabled, false);
});

test("retry controls return retry or cancel", () => {
  const el = container();
  const answers = [];
  render(
    el,
    {
      ...presentProgress({ phase: "acquisition", completed: 3, total: 4 }),
      retryApproval: { tile: {}, attempt: 4, requires_approval: true },
    },
    { ...callbacks, onRetryChoice: (choice) => answers.push(choice) },
  );
  for (const choice of ["retry", "cancel"])
    click(el.querySelector(`[data-dz-retry-choice="${choice}"]`));
  assert.deepEqual(answers, ["retry", "cancel"]);
});

test("retry approval replaces running progress with one warning before diagnostics", () => {
  const el = container();
  const presentation = {
    ...presentProgress({ phase: "acquisition", completed: 3, total: 4 }),
    retryApproval: { tile: {}, attempt: 4, requires_approval: true },
  };
  act(() =>
    renderView(
      el,
      presentation,
      { ...callbacks, onRetryChoice() {} },
      { diagnosticReport: createDiagnosticRecorder({ id: "retry", now: () => 0 }).report() },
    ),
  );
  const notice = el.querySelector(".dz-retry-section");
  const status = notice.querySelector('[role="status"]');
  assert.equal(notice.querySelector("h2").id, notice.getAttribute("aria-labelledby"));
  assert.equal(notice.querySelectorAll("[data-dz-retry-actions]").length, 1);
  assert.equal(
    status.querySelector("button"),
    null,
    "live announcements exclude interactive actions",
  );
  assert.match(el.textContent, /Download paused/);
  assert.match(el.textContent, /3 of 4 image pieces/);
  assert.match(el.textContent, /no file has been saved/);
  assert.match(el.textContent, /Retry once more/);
  assert.equal(el.querySelector("[role=progressbar]"), null);
  assert.equal(el.querySelector(".dz-pulse"), null);
  assert.ok(
    el.innerHTML.indexOf("data-dz-retry-actions") < el.innerHTML.indexOf("dz-job-diagnostics"),
  );
});

test("slow discovery replaces the phase with one waiting status", () => {
  const el = container();
  const now = 20_000;
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

test("rate-limit failures render the localized explainer from the typed facts at display time", () => {
  const el = container();
  const proxy = failurePresentation({
    kind: "rate-limited",
    transport: "metadata-proxy",
  });
  render(el, proxy, callbacks);
  assert.equal(el.querySelector("#dz-error-message").textContent, t("view.fail.rateProxy"));
  const direct = failurePresentation({
    kind: "rate-limited",
    transport: "direct",
  });
  render(el, direct, callbacks);
  assert.equal(el.querySelector("#dz-error-message").textContent, t("view.fail.rateDirect"));
  try {
    assert.equal(setLocale("fr"), true);
    render(el, proxy, callbacks);
    assert.equal(
      el.querySelector("#dz-error-message").textContent,
      t("view.fail.rateProxy", undefined, "fr"),
    );
  } finally {
    setLocale("en");
  }
});

test("failed state updates error details in place without destroying error container", () => {
  const el = container();
  const errPresentation1 = failurePresentation({ kind: "no-image-found" });
  render(el, errPresentation1, callbacks);
  const card = el.querySelector(".dz-card");
  assert.equal(card.dataset.viewPhase, "failed");
  const errSec = card.querySelector(".dz-error-section");
  assert.ok(errSec, "error section mounted");
  assert.equal(card.querySelector("#dz-error-message").textContent, t("view.discovery.none"));

  const errPresentation2 = failurePresentation({ kind: "timeout", transport: "native" });
  render(el, errPresentation2, callbacks);
  assert.equal(card.querySelector(".dz-error-section"), errSec, "error section node preserved");
  assert.equal(
    card.querySelector("#dz-error-message").textContent,
    t("desktop.transport.stalled", { host: "the server" }),
  );
});

test("website discovery failure keeps the extension suggestion and opens its guidance modal", () => {
  setLocale("en");
  const el = container();
  render(el, failurePresentation({ kind: "no-image-found" }), callbacks, { product: "website" });
  assert.match(el.querySelector("#dz-error-message").textContent, /try the browser extension/);
  click(el.querySelector("#dz-card-extension"));
  const modal = document.querySelector(".dz-modal-backdrop");
  assert.ok(modal);
  assert.match(modal.textContent, /Chrome Web Store/);
  click(modal.querySelector(".dz-modal-close"));
});

test("access refusals explain the failed connection without recommending the extension to itself", () => {
  const el = container();
  const scenarios = [
    { product: "extension", transport: "browser-session", message: "view.fail.httpRefused" },
    { product: "website", transport: "metadata-proxy", message: "view.fail.httpRefusedProxy" },
    { product: "website", transport: "direct", message: "view.fail.httpRefused" },
    { product: "desktop", transport: "native", message: "view.fail.httpRefused" },
  ];
  try {
    for (const locale of SUPPORTED_LOCALES) {
      setLocale(locale);
      for (const { product, transport, message } of scenarios) {
        const error = {
          kind: "discovery-failed",
          cause: { kind: "http-error", status: 403, transport },
        };
        render(el, failurePresentation(error), callbacks, { product });
        assert.equal(el.querySelector("#dz-error-message").textContent, t(message, { http: 403 }));
        assert.equal(el.querySelector("#dz-card-extension") !== null, product !== "extension");
      }
    }
  } finally {
    setLocale("en");
  }
});

test("extension discovery failure offers a diagnostic issue draft and the hosted URL guide", () => {
  const el = container();
  const input = "https://museum.example/viewer?item=123";
  const error = { kind: "no-image-found", detail: "no image references were found on this page" };
  const d = createDiagnosticRecorder({
    id: "extension-failure",
    now: () => 0,
    context: { product: "extension", input },
  });
  d.record("debug", "scan-complete", { candidates: 0 });
  d.finish("failed", error);
  for (const locale of ["en", "fr", "de", "it"]) {
    setLocale(locale);
    render(el, failurePresentation(error), callbacks, {
      product: "extension",
      diagnosticReport: d.report(),
    });
    assert.equal(
      el.querySelector("#dz-error-message").textContent,
      t("view.discovery.noneExtension"),
    );
    const guidance = el.querySelector(".dz-guidance-grid");
    assert.equal(guidance.children.length, 2);
    assert.equal(el.querySelector("#dz-card-extension"), null);
    assert.equal(el.querySelector("#dz-card-desktop"), null);
    const draft = new URL(guidance.querySelector("#dz-card-report-bug").getAttribute("href"));
    assert.equal(draft.origin + draft.pathname, "https://github.com/lovasoa/dezoomify/issues/new");
    assert.match(draft.searchParams.get("body"), /scan-complete/);
    assert.ok(draft.searchParams.get("body").includes(input));
    assert.ok(draft.searchParams.get("body").includes(t("view.discovery.noneExtension")));
    assert.equal(
      guidance.querySelectorAll("a")[1].getAttribute("href"),
      "https://dezoomify.ophir.dev/help/finding-the-image-address.html",
    );
  }
  setLocale("en");
});

test("fallback saves stay successful while original discovery diagnostics remain reportable", () => {
  const el = container();
  const error = { kind: "discovery-failed", detail: "original parser evidence" };
  const output = { disposition: "browser-save-initiated" };
  const d = createDiagnosticRecorder({
    id: "fallback",
    now: () => 0,
    context: { product: "extension", input: "https://museum.example/art" },
  });
  d.record("warn", "discovery-fallback", error);
  d.finish("completed", output);
  try {
    for (const locale of SUPPORTED_LOCALES) {
      setLocale(locale);
      render(el, presentOutput(output), callbacks, {
        discoveryFallback: error,
        diagnosticReport: d.report(),
      });
      assert.equal(el.querySelector("[data-view-phase]").dataset.viewPhase, "completed");
      assert.equal(el.querySelector(".dz-error-section"), null);
      assert.ok(el.textContent.includes(t("view.done.fallback")));
      assert.equal(el.querySelector("details").hasAttribute("open"), false);
      const draft = new URL(
        el.querySelector('a[href*="github.com/lovasoa/dezoomify/issues/new"]').href,
      );
      const body = draft.searchParams.get("body");
      assert.match(body, /original parser evidence/);
      assert.match(body, /saved an image/);
      assert.doesNotMatch(body, /attempt failed/);
      assert.match(draft.searchParams.get("labels"), /image discovery/);
    }
  } finally {
    setLocale("en");
  }
});

test("error layering: plain message prominent, parser diagnostics only in technical details", () => {
  const el = container();
  const details =
    " - zoomify, iiif, krpano: HTTP 429 fetching this address\n" +
    " - 2 other format(s) did not match this page address";
  const presentation = failurePresentation({
    kind: "http-error",
    status: 429,
    request: "https://example.test/viewer/tour.xml?sig=abc&lang=fr",
    transport: "metadata-proxy",
    retry_after_ms: 7000,
    preview: "Too many requests",
    detail: details,
  });
  render(el, presentation, callbacks);
  const card = el.querySelector(".dz-card");
  const prominent = card.querySelector("#dz-error-message").textContent;
  assert.ok(!prominent.includes("zoomify"), "parser details must not be prominent");
  assert.ok(!prominent.includes("429"), "status must not be prominent");
  const diagnostics = card.querySelector("#dz-job-diagnostics").textContent;
  assert.match(diagnostics, /status=429/);
  assert.match(diagnostics, /Too many requests/);
  assert.match(diagnostics, /sig=abc&lang=fr/);
  assert.ok(diagnostics.includes(details));
  // A fresh failure without url/http/detail renders only the trailing line.
  const fresh = failurePresentation({ kind: "no-image-found" });
  render(el, fresh, callbacks);
  const diag2 = card.querySelector("#dz-job-diagnostics").textContent;
  assert.match(diag2, /kind=no-image-found/);
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

  render(el, failurePresentation({ kind: "internal" }), callbacks);
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
    kind: "network-failure",
    transport: "direct",
    retryable: true,
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

  const nonRetryable = failurePresentation({ kind: "decode-failed", retryable: false });
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

test("resolution notice has one desktop action during the job and after output actions", () => {
  const el = container();
  let stopped = 0;
  const actions = {
    onSubmitUrl: () => {},
    onCancel: () => {
      stopped += 1;
    },
    onReset: () => {},
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
    { offerDesktopApp: true },
  );
  assert.ok(el.querySelector("#dz-resolution-notice"), "shown while tiles are still in flight");
  const notice = el.querySelector("#dz-resolution-notice");
  assert.equal(notice.querySelector("h2").textContent, "Lower-resolution image");
  assert.ok(notice.querySelector('[role="status"]'));
  assert.ok(el.querySelector('[role="progressbar"]'), "size warning leaves downloading visible");
  assert.ok(notice.querySelector("#dz-btn-download-desktop"));
  const sizes = el.querySelector("#dz-resolution-message").textContent;
  assert.match(sizes, /20000×10000/, "selected resolution");
  assert.match(sizes, /40000×20000/, "maximum resolution");
  assert.equal(notice.querySelectorAll("button").length, 1);
  assert.equal(stopped, 0);

  render(
    el,
    presentOutput(
      { format: "png", disposition: "browser-save-ready" },
      {
        phase: "acquisition",
        completed: 4,
        total: 4,
        selected: { width: 20000, height: 10000 },
        maximum: { width: 40000, height: 20000 },
      },
    ),
    actions,
    { offerDesktopApp: true },
  );
  assert.ok(el.querySelector("#dz-resolution-notice"), "the offer survives completion");
  assert.equal(el.querySelector("#dz-btn-resolution-stop"), null, "stop is gone once done");
  assert.equal(el.querySelector("#dz-btn-try-maximum"), null);
  assert.ok(el.querySelector(".dz-actions-row + #dz-resolution-notice"));
});

test("desktop handoff shows and copies the discovered URL, handles failure and unavailable sources", async () => {
  const el = container();
  const result = presentOutput(
    { format: "png", disposition: "browser-save-initiated" },
    {
      phase: "output",
      completed: 4,
      total: 4,
      selected: { width: 20000, height: 10000 },
      maximum: { width: 40000, height: 20000 },
    },
  );
  const source = "https://image.test/selected/info.json?signature=exact%2Bvalue";
  let copied;
  let rejectCopy = false;
  const actions = {
    ...callbacks,
    async onCopyText(text) {
      if (rejectCopy) throw new Error("unavailable");
      copied = text;
    },
  };
  render(el, result, actions, {
    offerDesktopApp: true,
    sourceUrl: "https://museum.test/page",
    desktopSourceUrl: source,
  });
  click(el.querySelector("#dz-btn-download-desktop"));
  let dialog = document.querySelector('[role="dialog"]');
  assert.ok(
    dialog.querySelector(
      'a[href="https://github.com/lovasoa/dezoomify/releases/latest/download/dezoomify-desktop.msi"]',
    ),
  );
  assert.equal(dialog.querySelector("input").value, source);
  assert.ok(dialog.querySelector("label").textContent.includes("Paste"));
  const copy = dialog.querySelector(".dz-btn-secondary");
  await act(async () => click(copy));
  assert.equal(copied, source);
  assert.match(dialog.querySelector('[role="status"]').textContent, /Address copied/);
  rejectCopy = true;
  await act(async () => click(copy));
  assert.match(dialog.querySelector('[role="alert"]').textContent, /copy it manually/);
  assert.equal(dialog.querySelector("input").value, source);
  click(dialog.querySelector(".dz-modal-close"));
  assert.equal(document.querySelector('[role="dialog"]'), null);

  render(el, result, actions, { offerDesktopApp: true, sourceUrl: "https://museum.test/page" });
  click(el.querySelector("#dz-btn-download-desktop"));
  dialog = document.querySelector('[role="dialog"]');
  assert.equal(dialog.querySelector("input"), null, "never substitutes the scanned page URL");
  assert.match(dialog.textContent, /no image address to copy/);
  click(dialog.querySelector(".dz-modal-close"));
});

test("hosts without desktop handoff never show the resolution notice", () => {
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
