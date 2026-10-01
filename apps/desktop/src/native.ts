import type {
  DiagnosticReport,
  MissingTiles,
  Output,
  Progress,
  RecoveryChoice,
} from "@dezoomify/wasm-bindings";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { assertNoTileBytes } from "./events.ts";
import type { DesktopSettings } from "./settings.ts";

export interface DesktopIpc {
  invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
  listen(channel: string, handler: (event: { payload: unknown }) => void): Promise<unknown>;
}

const ipc: DesktopIpc = { invoke, listen };
let nextInvocation = 0;

export interface NativeInvocation {
  id: string;
  finished: Promise<Output>;
  cancel(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  answer(question: number, choice: RecoveryChoice): Promise<void>;
  openOutput(reveal: boolean): Promise<void>;
  dispose(): Promise<void>;
}

export async function invokeNative(
  request: { inputUrl: string; settings: DesktopSettings },
  callbacks: {
    progress(value: Progress): void;
    partial(question: number, value: MissingTiles): void;
  },
  api: DesktopIpc = ipc,
): Promise<NativeInvocation> {
  const input = new URL(request.inputUrl);
  if (
    !["http:", "https:"].includes(input.protocol) ||
    input.username ||
    input.password ||
    request.inputUrl.length > 2048
  ) {
    throw { kind: "invalid-input", detail: "the image address is not usable" };
  }
  const id = `job:desktop-${Date.now()}-${++nextInvocation}`;
  let retired = false;
  let acknowledgeRegistration: (() => void) | undefined;
  const registration = new Promise<void>((resolve) => {
    acknowledgeRegistration = resolve;
  });
  const unlisten: Array<() => void> = [];
  const releaseListeners = () => {
    for (const stop of unlisten.splice(0)) stop();
  };
  try {
    for (const channel of [
      "dezoomify://registered",
      "dezoomify://progress",
      "dezoomify://partial",
    ]) {
      const stop = await api.listen(channel, ({ payload }) => {
        if (
          retired ||
          !payload ||
          typeof payload !== "object" ||
          !("job" in payload) ||
          payload.job !== id
        )
          return;
        assertNoTileBytes(payload);
        if (channel === "dezoomify://registered") acknowledgeRegistration?.();
        if (channel === "dezoomify://progress" && "progress" in payload)
          callbacks.progress(payload.progress as Progress);
        if (
          channel === "dezoomify://partial" &&
          "question" in payload &&
          typeof payload.question === "number" &&
          "missing" in payload
        ) {
          callbacks.partial(payload.question, payload.missing as MissingTiles);
        }
      });
      if (typeof stop === "function") unlisten.push(stop as () => void);
    }
  } catch (error) {
    releaseListeners();
    throw error;
  }
  const call = async (command: string, args?: Record<string, unknown>): Promise<void> => {
    if (retired) throw { kind: "stale" };
    await api.invoke(command, { job: id, ...args });
  };
  // Settings cross IPC raw as typed; Rust's `parse_settings` is the single
  // validator and its typed rejection reason is authoritative.
  const finished = api
    .invoke("dezoomify", {
      job: id,
      inputUrl: request.inputUrl,
      settings: { ...request.settings, headers: [...request.settings.headers] },
    })
    .then((output) => {
      assertNoTileBytes(output);
      return output as Output;
    })
    .finally(releaseListeners);
  // Controls may reach Rust on a different task from the dezoomify command.
  // Its acknowledgement (or final response) proves the job table is ready.
  await Promise.race([registration, finished]);
  return {
    id,
    finished,
    cancel: () => call("cancel_job"),
    pause: () => call("pause_job"),
    resume: () => call("resume_job"),
    answer: (question, answer) => call("answer_partial", { question, answer }),
    openOutput: (reveal) => call("open_saved_output", { reveal }),
    async dispose() {
      if (retired) return;
      retired = true;
      releaseListeners();
      await api.invoke("release_job", { job: id });
    },
  };
}

export async function readNativeDiagnostics(
  job: string,
  api: DesktopIpc = ipc,
): Promise<DiagnosticReport> {
  const report = await api.invoke("get_job_diagnostics", { job });
  assertNoTileBytes(report);
  return report as DiagnosticReport;
}

export async function listenDeepLinks(
  callback: (payload: Record<string, unknown>) => void,
): Promise<void> {
  await ipc.listen("dezoomify://deep-link-pending", ({ payload }) => {
    if (payload && typeof payload === "object") callback(payload as Record<string, unknown>);
  });
}

/** Open explicitly requested HTTPS links outside the app window. */
export async function openExternalLink(url: string): Promise<void> {
  const address = new URL(url);
  if (address.protocol !== "https:" || address.username || address.password) return;
  await openUrl(url);
}
