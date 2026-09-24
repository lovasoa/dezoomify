import { isPublicHttpUrl } from "@dezoomify/browser-runtime";
import type { WxtBrowser } from "wxt/browser";

type BrowserApi = {
  action: Pick<WxtBrowser["action"], "onClicked">;
  tabs: Pick<WxtBrowser["tabs"], "create" | "get" | "onRemoved" | "update">;
  runtime: Pick<WxtBrowser["runtime"], "getURL" | "onMessage" | "sendMessage">;
};

type BrowserTab = { id?: number; url?: string };

/** The background only opens and focuses the job page for a toolbar click. */
export function createBackgroundLauncher({
  browserApi,
  testing = false,
}: {
  browserApi: BrowserApi;
  testing?: boolean;
}) {
  const jobTabs = new Map<number, number>();
  const openings = new Map<number, Promise<number | null>>();

  async function focusJob(sourceTabId: number, jobTabId: number) {
    try {
      await browserApi.tabs.update(jobTabId, { active: true });
      await browserApi.runtime
        .sendMessage({ type: "dz.toolbar-click", sourceTabId })
        .catch(() => {});
      return true;
    } catch {
      jobTabs.delete(sourceTabId);
      return false;
    }
  }

  async function openJob(tab: BrowserTab): Promise<number | null> {
    const sourceTabId = tab.id;
    if (
      typeof sourceTabId !== "number" ||
      !Number.isSafeInteger(sourceTabId) ||
      sourceTabId < 0 ||
      !isPublicHttpUrl(tab.url)
    )
      return null;
    const current = jobTabs.get(sourceTabId);
    if (current !== undefined && (await focusJob(sourceTabId, current))) return current;

    const opening = openings.get(sourceTabId);
    if (opening) {
      const jobTabId = await opening;
      if (jobTabId !== null) await focusJob(sourceTabId, jobTabId);
      return jobTabId;
    }

    const create = browserApi.tabs
      .create({
        url: `${browserApi.runtime.getURL("/job.html")}#sourceTabId=${sourceTabId}`,
        active: true,
      })
      .then((jobTab) => {
        const jobTabId = jobTab.id;
        if (typeof jobTabId !== "number" || !Number.isSafeInteger(jobTabId) || jobTabId < 0)
          return null;
        jobTabs.set(sourceTabId, jobTabId);
        return jobTabId;
      })
      .catch(() => null);
    openings.set(sourceTabId, create);
    const jobTabId = await create;
    if (openings.get(sourceTabId) === create) openings.delete(sourceTabId);
    return jobTabId;
  }

  function startBackground() {
    browserApi.action.onClicked.addListener((tab) => {
      void openJob(tab);
    });
    browserApi.tabs.onRemoved.addListener((tabId) => {
      jobTabs.delete(tabId);
      for (const [sourceTabId, jobTabId] of jobTabs)
        if (jobTabId === tabId) jobTabs.delete(sourceTabId);
    });
    browserApi.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!testing || typeof message !== "object" || message === null || !("type" in message))
        return;
      if (message.type === "dezoomify-test-start-job") {
        void (async () => {
          if (
            typeof message.tabId !== "number" ||
            !Number.isSafeInteger(message.tabId) ||
            typeof message.url !== "string" ||
            !isPublicHttpUrl(message.url)
          )
            return { ok: false };
          const tab = await browserApi.tabs.get(message.tabId).catch(() => null);
          if (!tab || tab.url !== message.url) return { ok: false };
          return { ok: (await openJob(tab)) !== null };
        })().then(sendResponse, () => sendResponse({ ok: false }));
        return true;
      }
      if (message.type === "dezoomify-test-wake-background") {
        sendResponse({ ok: true });
        return true;
      }
    });
  }

  return { startBackground };
}
