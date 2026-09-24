import type { LOG_LEVELS } from "@dezoomify/browser-runtime/logging";
import type { WxtBrowser } from "wxt/browser";
import type { JobBinding } from "../protocol.ts";

export type LogLevel = keyof typeof LOG_LEVELS;
export type Entry = JobBinding & {
  attemptGeneration: number;
  jobTabId: number;
  sourceUrl: string;
  sourceValid: boolean;
  jobReady: boolean;
  jobRunning: boolean;
  seenCandidates: Set<string>;
  snapshotCount: number;
  grantedOrigins: Set<string>;
};

/** Production uses WXT directly; unit tests provide only these browser APIs. */
export type BrowserApi = {
  action: Pick<WxtBrowser["action"], "setIcon" | "setBadgeText" | "onClicked">;
  tabs: Pick<WxtBrowser["tabs"], "sendMessage" | "update" | "create" | "onRemoved" | "onUpdated">;
  permissions: Pick<WxtBrowser["permissions"], "contains" | "onRemoved">;
  scripting: Pick<WxtBrowser["scripting"], "executeScript">;
  runtime: Pick<WxtBrowser["runtime"], "getURL" | "onMessage">;
};

export type BrowserTab = { id?: number; url?: string };
export type BrowserSender = { tab?: BrowserTab; frameId?: number };
