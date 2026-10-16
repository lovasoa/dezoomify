import { isValidInputUrl } from "@dezoomify/shared-ui";
import type {
  DesktopOutput,
  DiagnosticReport,
  Error as JobError,
  Progress,
  RetryChoice,
  SavedOutput,
  SavedOutputState,
  TileAcquisition,
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

/** Stamp the shell's retry verdict (`is_retryable`, the one policy in Rust)
 * onto a typed error in place as a plain `retryable` hint for the shared UI;
 * the payload itself stays untouched. A value the shell cannot classify keeps
 * no hint and so fails closed. */
async function withVerdict<T>(error: T, api: DesktopIpc): Promise<T> {
  try {
    (error as JobError & { retryable?: boolean }).retryable =
      (await api.invoke("is_retryable", { error })) === true;
  } catch {
    // No verdict: the hint stays absent and retry fails closed.
  }
  return error;
}

export interface NativeInvocation {
  id: string;
  finished: Promise<DesktopOutput>;
  cancel(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  answer(question: number, choice: RetryChoice): Promise<void>;
  openOutput(reveal: boolean): Promise<void>;
  dispose(): Promise<void>;
}

export async function invokeNative(
  request: { inputUrl: string; settings: DesktopSettings },
  callbacks: {
    progress(value: Progress): void;
    retry(question: number, value: TileAcquisition): void;
  },
  api: DesktopIpc = ipc,
): Promise<NativeInvocation> {
  if (!isValidInputUrl(request.inputUrl)) {
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
    for (const channel of ["dezoomify://registered", "dezoomify://progress", "dezoomify://retry"]) {
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
          channel === "dezoomify://retry" &&
          "question" in payload &&
          typeof payload.question === "number" &&
          "request" in payload
        ) {
          callbacks.retry(payload.question, payload.request as TileAcquisition);
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
    .then((response) => {
      assertNoTileBytes(response);
      return response as DesktopOutput;
    })
    .catch(async (error: unknown) => {
      // The shell's retry verdict is stamped here, on the async path before
      // any rendering, because the view's normalization is synchronous.
      throw await withVerdict(error, api);
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
    answer: (question, answer) => call("answer_retry", { question, answer }),
    openOutput: (reveal) => call("open_saved_output", { reveal }),
    async dispose() {
      if (retired) return;
      retired = true;
      releaseListeners();
      await api.invoke("release_job", { job: id });
    },
  };
}

export async function inspectSavedOutput(
  saved: SavedOutput,
  api: DesktopIpc = ipc,
): Promise<SavedOutputState> {
  return (await api.invoke("inspect_saved_output", { id: saved.id })) as SavedOutputState;
}

export async function openHistoryOutput(saved: SavedOutput, api: DesktopIpc = ipc): Promise<void> {
  await api.invoke("open_history_output", { id: saved.id });
}

export async function forgetSavedOutput(saved: SavedOutput, api: DesktopIpc = ipc): Promise<void> {
  await api.invoke("forget_saved_output", { id: saved.id });
}

export async function readNativeDiagnostics(
  job: string,
  api: DesktopIpc = ipc,
): Promise<DiagnosticReport> {
  const report = await api.invoke("get_job_diagnostics", { job });
  assertNoTileBytes(report);
  return report as DiagnosticReport;
}

/** Validate raw settings with the shell's `validate_settings` (the single
 * validator, `parse_settings`) before anything is persisted. Rejects with the
 * typed `invalid-settings` reason when the edit is refused. */
export async function validateSettings(
  settings: DesktopSettings,
  api: DesktopIpc = ipc,
): Promise<void> {
  await api.invoke("validate_settings", {
    settings: { ...settings, headers: [...settings.headers] },
  });
}

/** Open explicitly requested HTTPS links outside the app window. */
export async function openExternalLink(url: string): Promise<void> {
  const address = new URL(url);
  if (address.protocol !== "https:" || address.username || address.password) return;
  await openUrl(url);
}
