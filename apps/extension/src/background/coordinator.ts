/**
 * Extension background coordinator factory.
 *
 * All mutable coordinator state (job/binding maps, wiring flags, id
 * sequences, the logger instance) lives inside `createBackgroundCoordinator`,
 * so each caller (production or test) owns an isolated instance. Nothing in
 * this module reads `globalThis` at import time; the browser API is an
 * injected dependency. Stateless helpers and limits stay at module scope.
 */

import { isPublicHttpUrl, originOfPublicUrl } from "@dezoomify/browser-runtime";
import { createLogger, LOG_MAX_CHARS } from "@dezoomify/browser-runtime/logging";
import type { RuntimeMessage } from "../protocol.ts";
import { isRuntimeMessage } from "../protocol.ts";
import { createSourceBridge, sameDocumentUrl } from "./source-bridge.ts";
import type { BrowserApi, BrowserSender, BrowserTab, Entry, LogLevel } from "./types.ts";

export type { BrowserApi, BrowserTab } from "./types.ts";

const IDLE_ICON = {
  16: "icons/icon16-grey.png",
  48: "icons/icon48-grey.png",
  128: "icons/icon128-grey.png",
};
const ACTIVE_ICON = { 16: "icons/icon16.png", 48: "icons/icon48.png", 128: "icons/icon128.png" };
export const BACKGROUND_LOG_MAX_CHARS = LOG_MAX_CHARS;

export function createBackgroundCoordinator({
  browserApi,
  testing = false,
}: {
  browserApi: BrowserApi;
  testing?: boolean;
}) {
  const backgroundLogger = createLogger("background");

  function setBackgroundLogLevel(level: string | number) {
    backgroundLogger.setLevel(level);
  }
  function setBackgroundLogSink(sink: unknown) {
    backgroundLogger.setSink(sink);
  }
  function backgroundLog(level: LogLevel, code: string, detail: unknown = "") {
    backgroundLogger.log(level, code, detail);
  }

  const jobs = new Map<string, Entry>();
  let wired = false;
  let jobSequence = 0;

  function bindingOf(entry: Entry) {
    return {
      jobId: entry.jobId,
      tabId: entry.tabId,
      frameId: entry.frameId,
      documentGeneration: entry.documentGeneration,
    };
  }
  function bindingMatches(message: RuntimeMessage, entry: Entry) {
    return (
      message.jobId === entry.jobId &&
      message.tabId === entry.tabId &&
      message.frameId === entry.frameId &&
      message.documentGeneration === entry.documentGeneration
    );
  }
  function makeJobId() {
    try {
      if (globalThis.crypto?.randomUUID) return `job:${globalThis.crypto.randomUUID()}`;
    } catch {}
    jobSequence += 1;
    return `job:${Date.now().toString(36)}-${jobSequence}`;
  }

  function setBadge(tabId: number, active: boolean, failed = false) {
    try {
      const icon = browserApi.action.setIcon({ tabId, path: active ? ACTIVE_ICON : IDLE_ICON });
      icon.catch(() => {});
      const badge = browserApi.action.setBadgeText({
        tabId,
        text: active ? (failed ? "!" : "•") : "",
      });
      badge.catch(() => {});
    } catch {}
  }

  function sendToTab(tabId: number, message: unknown) {
    try {
      return browserApi.tabs.sendMessage(tabId, message).catch(() => {});
    } catch {
      return null;
    }
  }
  function sendToJob(entry: Entry, type: string, extra: Record<string, unknown> = {}) {
    backgroundLog("debug", "job-message-sent", `type=${type} tab=${entry.jobTabId}`);
    return sendToTab(entry.jobTabId, {
      ...extra,
      ...bindingOf(entry),
      type,
    });
  }

  const { dispatchSourceFetch, invalidateSourceDocument, requestCandidateSnapshot, startAttempt } =
    createSourceBridge({
      browserApi,
      jobs,
      sendToJob,
      setBadge,
      log: backgroundLog,
    });

  function findJobSender(sender: BrowserSender, message: RuntimeMessage): Entry | null {
    const tabId = sender?.tab?.id;
    const senderFrameId = sender?.frameId;
    if (typeof tabId !== "number" || typeof senderFrameId !== "number") return null;
    if (typeof message.jobId !== "string") return null;
    const job = jobs.get(message.jobId);
    if (!job || job.jobTabId !== tabId) return null;
    // The first ready notification only proves the job tab owns the opaque id
    // placed in its extension URL. It cannot yet include a source binding.
    if (message?.type === "dz.job.ready") return senderFrameId === 0 ? job : null;
    return senderFrameId === job.frameId && bindingMatches(message, job) ? job : null;
  }

  function removeJob(entry: Entry, reason: string) {
    jobs.delete(entry.jobId);
    setBadge(entry.tabId, false);
    backgroundLog("info", "job-removed", `${entry.jobId} ${reason}`);
  }

  async function createJob(tab: BrowserTab) {
    const tabId = tab?.id;
    if (typeof tabId !== "number" || !isPublicHttpUrl(tab?.url)) {
      backgroundLog("warn", "privileged-rejected", String(tab?.url ?? ""));
      return;
    }
    backgroundLog("info", "toolbar-click", `tab=${tabId} url=${String(tab?.url ?? "")}`);
    const existing = [...jobs.values()].find(
      (entry) => entry.tabId === tabId && (entry.jobRunning || entry.sourceValid || entry.jobReady),
    );
    if (existing?.jobRunning) {
      await focusJob(existing, "running");
      return;
    }
    if (existing?.sourceValid) {
      existing.sourceValid = false;
      backgroundLog("info", "job-cancel-requested", `tab=${tabId} jobId=${existing.jobId}`);
      sendToJob(existing, "dz.job.cancel", {
        reason: "toolbar-cancel",
      });
      setBadge(tabId, false);
      return;
    }
    if (existing?.jobReady) {
      await focusJob(existing, "ready");
      return;
    }
    const jobId = makeJobId();
    let jobTab: BrowserTab;
    try {
      jobTab = await browserApi.tabs.create({
        url: browserApi.runtime.getURL(`/job.html#jobId=${encodeURIComponent(jobId)}`),
        active: true,
      });
    } catch (error) {
      backgroundLog(
        "error",
        "job-tab-create-failed",
        error instanceof Error ? error.message : error,
      );
      return;
    }
    if (typeof jobTab?.id !== "number") {
      backgroundLog("error", "job-tab-create-failed", "missing tab id");
      return;
    }
    const entry: Entry = {
      jobId,
      tabId,
      frameId: 0,
      documentGeneration: 0,
      attemptGeneration: 0,
      jobTabId: jobTab.id,
      sourceUrl: tab.url,
      sourceValid: true,
      jobReady: false,
      jobRunning: false,
      seenCandidates: new Set<string>(),
      snapshotCount: 0,
      grantedOrigins: new Set<string>(),
    };
    jobs.set(jobId, entry);
    setBadge(tabId, true);
    backgroundLog(
      "info",
      "job-created",
      `jobId=${jobId} jobTab=${jobTab.id} sourceTab=${tabId} frame=${entry.frameId} url=${tab.url}`,
    );
  }

  async function focusJob(entry: Entry, reason: "running" | "ready") {
    backgroundLog(
      "info",
      "job-focus",
      `tab=${entry.tabId} jobTab=${entry.jobTabId} reason=${reason}`,
    );
    try {
      await browserApi.tabs.update(entry.jobTabId, { active: true });
    } catch {}
  }

  async function handlePermission(entry: Entry, message: RuntimeMessage) {
    const origins = Array.isArray(message.origins)
      ? [
          ...new Set(
            message.origins
              .map(originOfPublicUrl)
              .filter((origin): origin is string => origin !== null),
          ),
        ]
      : [];
    if (!origins.length)
      return {
        type: "dz.job.permission-required",
        ...bindingOf(entry),
        granted: false,
        code: "invalid-origins",
      };
    let granted = false;
    // The job page owns `permissions.request()` because it retains the user
    // activation from its Allow button. The coordinator verifies that grant
    // before resuming a paused acquisition.
    if (testing && message.testGrant === true) granted = true;
    else
      try {
        granted = Boolean(
          await browserApi.permissions.contains({
            origins: origins.map((origin) => `${origin}/*`),
          }),
        );
      } catch {}
    if (granted) for (const origin of origins) entry.grantedOrigins.add(origin);
    backgroundLog(
      "info",
      "permission-check",
      `jobId=${entry.jobId} origins=${origins.length} granted=${granted}`,
    );
    return {
      type: "dz.job.permission-required",
      ...bindingOf(entry),
      granted,
      origins,
    };
  }

  function respond(sendResponse: ((response: unknown) => void) | undefined, response: unknown) {
    try {
      sendResponse?.(response);
    } catch {}
  }

  function handleRuntimeMessage(
    message: RuntimeMessage,
    sender: BrowserSender,
    sendResponse?: (response: unknown) => void,
  ) {
    // Headless browsers cannot click browser chrome; this test-only request
    // enters through the same toolbar path and is absent from store builds.
    if (message.type === "dezoomify-test-start-job") {
      if (!testing || typeof message.tabId !== "number" || !isPublicHttpUrl(message.url)) return;
      void createJob({ id: message.tabId, url: message.url });
      respond(sendResponse, { ok: true });
      return true;
    }
    if (!message.type.startsWith("dz.job.")) return;

    backgroundLog(
      "debug",
      "job-message-received",
      `type=${message.type} tab=${sender?.tab?.id} frame=${sender?.frameId}`,
    );
    const entry = findJobSender(sender, message);
    if (!entry) {
      backgroundLog(
        "debug",
        "job-message-rejected",
        `type=${message.type} tab=${sender?.tab?.id} frame=${sender?.frameId} reason=unknown-sender`,
      );
      return;
    }

    switch (message.type) {
      case "dz.job.ready":
        entry.jobReady = true;
        backgroundLog(
          "info",
          "binding-ready",
          `jobId=${entry.jobId} sourceValid=${entry.sourceValid} tab=${entry.tabId} frame=${entry.frameId} gen=${entry.documentGeneration}`,
        );
        respond(sendResponse, {
          ...bindingOf(entry),
          documentUrl: entry.sourceUrl,
        });
        startAttempt(entry);
        return true;
      case "dz.job.fetch":
        if (!entry.sourceValid) {
          backgroundLog(
            "debug",
            "job-message-rejected",
            `type=${message.type} reason=inactive-source`,
          );
          respond(sendResponse, { ok: false, code: "source-invalidated" });
          return true;
        }
        entry.jobRunning = true;
        void dispatchSourceFetch(entry, message).then(
          (reply) => respond(sendResponse, reply),
          () => respond(sendResponse, { ok: false, code: "source-operation-failed" }),
        );
        return true;
      case "dz.job.candidates-more":
        if (entry.sourceValid) void requestCandidateSnapshot(entry);
        break;
      case "dz.job.retry":
        if (!entry.sourceValid) {
          backgroundLog(
            "debug",
            "job-message-rejected",
            `type=${message.type} reason=inactive-source`,
          );
          break;
        }
        backgroundLog("info", "job-retry", `jobId=${entry.jobId} tab=${entry.tabId}`);
        startAttempt(entry);
        break;
      case "dz.job.cancel":
        backgroundLog("info", "job-cancelled", `jobId=${entry.jobId} tab=${entry.tabId}`);
        entry.jobRunning = false;
        entry.sourceValid = false;
        break;
      case "dz.job.closed":
        void removeJob(entry, "job-closed");
        break;
      case "dz.job.permission-required":
        void handlePermission(entry, message).then(
          (reply) => respond(sendResponse, reply),
          () =>
            respond(sendResponse, {
              type: "dz.job.permission-required",
              ...bindingOf(entry),
              granted: false,
              code: "permission-check-failed",
            }),
        );
        return true;
    }
    return;
  }

  function wire() {
    if (wired) return;
    wired = true;
    browserApi.action.onClicked.addListener((tab) => {
      void createJob(tab);
    });
    browserApi.tabs.onRemoved.addListener((tabId) => {
      for (const entry of [...jobs.values()]) {
        if (entry.tabId === tabId || entry.jobTabId === tabId)
          void removeJob(entry, entry.tabId === tabId ? "source-tab-closed" : "job-tab-closed");
      }
    });
    browserApi.tabs.onUpdated.addListener((tabId, changeInfo) => {
      if (typeof changeInfo?.url !== "string") return;
      for (const entry of jobs.values())
        if (
          entry.tabId === tabId &&
          entry.sourceValid &&
          !sameDocumentUrl(changeInfo.url, entry.sourceUrl)
        )
          invalidateSourceDocument(entry, "navigation");
    });
    browserApi.permissions.onRemoved.addListener((removed) => {
      const removedOrigins = new Set(
        (removed?.origins ?? []).map((origin) => origin.replace(/\/\*$/, "")),
      );
      for (const entry of jobs.values()) {
        const revoked = [...entry.grantedOrigins].filter((origin) => removedOrigins.has(origin));
        if (!revoked.length) continue;
        for (const origin of revoked) entry.grantedOrigins.delete(origin);
        backgroundLog(
          "info",
          "permission-revoked",
          `jobId=${entry.jobId} origins=${revoked.length}`,
        );
        sendToJob(entry, "dz.job.permission-required", {
          granted: false,
          revoked,
          code: "permission-revoked",
        });
      }
    });
    browserApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (isRuntimeMessage(message)) return handleRuntimeMessage(message, sender, sendResponse);
    });
  }

  function startBackground() {
    try {
      wire();
    } catch (error) {
      backgroundLog("error", "wire-failed", error instanceof Error ? error.message : error);
    }
  }

  return {
    BACKGROUND_LOG_MAX_CHARS,
    setBackgroundLogLevel,
    setBackgroundLogSink,
    backgroundLog,
    startBackground,
  };
}

export type BackgroundCoordinator = ReturnType<typeof createBackgroundCoordinator>;
