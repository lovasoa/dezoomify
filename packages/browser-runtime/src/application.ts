import {
  AccessRequestView,
  clearHistory,
  createSequentialQueue,
  type DiagnosticRecorder,
  enqueueSequential,
  finishActiveQueueEntry,
  type HistoryEntry,
  type HistoryStore,
  isValidInputUrl,
  loadHistory,
  PartialDecisionActions,
  type Presentation,
  presentFailure,
  presentIdle,
  presentOutput,
  presentProgress,
  presentStatus,
  pushHistory,
  type QueueEntry,
  renderView,
  saveHistory,
  toHistoryEntry,
  type ViewContext,
} from "@dezoomify/shared-ui";
import type {
  ErrorTransport,
  Error as JobError,
  JobInput,
  MissingTiles,
  Options,
  Output,
  Progress,
  RecoveryChoice,
} from "@dezoomify/wasm-bindings";
import { createElement } from "react";
import { isJobError } from "../../shared-ui/src/failure.ts";
import type { BrowserSaveDisposition } from "./assembly.ts";
import { createBrowserAssembly } from "./browser-assembly.ts";
import { BrowserHost, type BrowserHostDependencies } from "./browser-host.ts";
import {
  copyDiagnosticText,
  createAttemptDiagnostics,
  retainDiagnostics,
  saveDiagnosticReport,
} from "./diagnostics.ts";
import { createJobActivity } from "./job-activity.ts";
import {
  BROWSER_MAX_PLAN_TILES,
  browserLimitsFor,
  type ClientHints,
  MAXIMUM_SELECTION_LIMITS,
  selectionLimitsFor,
} from "./limits.ts";
import type { PermissionWait } from "./permissions.ts";
import { desktopHandoffLink } from "./plan-gates.ts";
import { createTileDecoder } from "./tile-decode.ts";
import { BROWSER_MAX_CONCURRENCY } from "./tile-policy.ts";

type WasmModule = Pick<
  typeof import("@dezoomify/wasm-bindings"),
  "dezoomify" | "applyProcessing" | "isRetryable"
>;
export interface BrowserApplicationContext {
  signal: AbortSignal;
  diagnostics: DiagnosticRecorder;
  activity: ReturnType<typeof createJobActivity>;
  view: ViewContext;
  update(): void;
  permission(pending: PermissionWait[]): void;
}
export interface BrowserCapabilities
  extends Pick<BrowserHostDependencies, "fetchResource" | "loadDisplayImage"> {
  inputs(url: string): Promise<JobInput[]>;
  canvas(): HTMLCanvasElement;
  showCanvas?(canvas: HTMLCanvasElement): void;
  save(
    blob: Blob,
    width: number,
    height: number,
    signal: AbortSignal,
    title?: string,
  ): Promise<BrowserSaveDisposition> | BrowserSaveDisposition;
  transport(): ErrorTransport | null;
  saveOutput?(): void;
  openOutput?(): Promise<void>;
  revealOutput?(): Promise<void>;
  dispose?(): void;
}
export interface BrowserApplicationOptions {
  root: HTMLElement;
  product: "website" | "extension";
  version?: string;
  wasm(): Promise<WasmModule>;
  capabilities(context: BrowserApplicationContext): BrowserCapabilities;
  partial: Options["partial"];
  history?: { store: HistoryStore; key: string };
  resetToIdle?: boolean;
  onStart?(url: string): void;
  onReset?(): void;
  onStatus?(presentation: Presentation, url: string): void;
  onComplete?(output: Output): void;
  openSource?(): void;
}

/** Website and extension share the entire invocation, interaction, queue, and presentation flow. */
export function createBrowserApplication(options: BrowserApplicationOptions) {
  let history: HistoryEntry[] = options.history
    ? loadHistory(options.history.store, options.history.key)
    : [];
  let queue = createSequentialQueue<QueueEntry & { url: string }>("browser:");
  let current: ReturnType<typeof invocation> | undefined;
  let idle: Presentation = presentIdle();
  let initialUrl: string | undefined;
  let retiring = Promise.resolve();

  function invocation(url: string) {
    const controller = new AbortController();
    const diagnostics = createAttemptDiagnostics(options.product, options.version);
    const activity = createJobActivity({
      onUpdate: () => {
        if (current === attempt) update();
      },
      nowFn: Date.now,
    });
    const attempt = {
      url,
      controller,
      diagnostics,
      activity,
      host: undefined as BrowserHost | undefined,
      capabilities: undefined as BrowserCapabilities | undefined,
      progress: undefined as Progress | undefined,
      output: undefined as Output | undefined,
      failure: undefined as JobError | undefined,
      decision: undefined as
        | { missing: MissingTiles; answer(choice: RecoveryChoice): void }
        | undefined,
      permission: undefined as PermissionWait | undefined,
      done: false,
      view: {
        sourceUrl: url,
        history: [...history],
        jobActivity: activity.state,
      } as ViewContext,
    };
    activity.reset(url, 30000);
    diagnostics.context({ input: url });
    return attempt;
  }

  function presentation(): Presentation {
    const a = current;
    if (!a) return idle;
    if (a.failure) return presentFailure(a.failure);
    if (a.output) return presentOutput(a.output, a.progress);
    if (a.controller.signal.aborted) return presentStatus("cancelled");
    const view = a.progress
      ? presentProgress(a.progress, {
          paused: a.host?.paused,
        })
      : presentStatus("discovering");
    if (a.decision) {
      view.decision = a.decision.missing;
      view.headlineKey = "view.partial.title";
    }
    return view;
  }

  function retire(): Promise<void> {
    const a = current;
    if (!a) return retiring;
    current = undefined;
    a.controller.abort();
    a.activity.stopHeartbeat();
    retiring = Promise.all([retiring, a.host?.settle()]).then(() => {});
    a.capabilities?.dispose?.();
    a.diagnostics.finish("retired");
    retainDiagnostics(a.diagnostics);
    return retiring;
  }

  function cancel(): void {
    queue = createSequentialQueue("browser:");
    if (options.resetToIdle) {
      retire();
      idle = presentIdle();
      initialUrl = undefined;
      options.onReset?.();
    } else if (current) {
      current.controller.abort();
      current.permission = undefined;
      current.decision = undefined;
      current.activity.stopHeartbeat();
      current.diagnostics.finish("cancelled");
    }
    update();
  }

  async function run(url: string, maximum = false): Promise<void> {
    const retired = retire();
    const a = invocation(url);
    current = a;
    options.onStart?.(url);
    a.activity.startHeartbeat();
    update();
    let outcome: "done" | "failed" | "cancelled" = "done";
    try {
      await retired;
      a.controller.signal.throwIfAborted();
      const capabilities = options.capabilities({
        signal: a.controller.signal,
        diagnostics: a.diagnostics,
        activity: a.activity,
        view: a.view,
        update: () => {
          if (current === a) update();
        },
        permission: (pending) => {
          if (current === a && !a.controller.signal.aborted) {
            a.permission = pending[0];
            update();
          }
        },
      });
      a.capabilities = capabilities;
      const [wasm, inputs] = await Promise.all([options.wasm(), capabilities.inputs(url)]);
      a.controller.signal.throwIfAborted();
      url = a.view.sourceUrl || inputs[0]?.url || url;
      a.url = url;
      const decoder = createTileDecoder(undefined, a.diagnostics);
      const assembly = createBrowserAssembly({
        diagnostics: a.diagnostics,
        signal: a.controller.signal,
        decoder,
        sourceUrl: url,
        processTile: (recipe, bytes) =>
          wasm.applyProcessing(recipe, new Uint8Array(bytes)).slice().buffer,
        canvas: capabilities.canvas,
        showCanvas: capabilities.showCanvas,
        limits: browserLimitsFor(navigator as unknown as ClientHints),
        save: (blob, width, height, signal) =>
          capabilities.save(blob, width, height, signal, a.progress?.title ?? undefined),
        onDisplayOnly: () => {
          if (current === a) {
            a.view.desktopHandoffUrl = desktopHandoffLink(url);
            update();
          }
        },
      });
      a.host = new BrowserHost({
        signal: a.controller.signal,
        diagnostics: a.diagnostics,
        assembly,
        decoder,
        fetchResource: capabilities.fetchResource,
        loadDisplayImage: capabilities.loadDisplayImage,
        onProgress: (progress) => {
          if (current === a) {
            a.progress = progress;
            a.activity.touchProgress();
            a.activity.scheduleUpdate();
          }
        },
        transport: () => capabilities.transport(),
        choosePartial: async (missing, signal) => {
          signal.throwIfAborted();
          const hinted = await withVerdictMissing(missing);
          signal.throwIfAborted();
          return new Promise((resolve, reject) => {
            const abort = () => reject(signal.reason);
            signal.addEventListener("abort", abort, { once: true });
            a.decision = {
              missing: hinted,
              answer(choice) {
                if (current !== a || signal.aborted) return;
                signal.removeEventListener("abort", abort);
                a.decision = undefined;
                a.diagnostics.record("info", "partial-answer", { choice });
                resolve(choice);
                update();
              },
            };
            update();
          });
        },
      });
      const limits = maximum
        ? MAXIMUM_SELECTION_LIMITS
        : selectionLimitsFor(navigator as unknown as ClientHints);
      const output = await wasm.dezoomify(
        inputs,
        {
          format: undefined,
          selection: {
            kind: "fitting",
            max_width: limits.maxWidth,
            max_height: limits.maxHeight,
            max_area: limits.maxArea,
          },
          partial: options.partial,
          output: "png",
          max_concurrent: BROWSER_MAX_CONCURRENCY,
          max_tiles: BROWSER_MAX_PLAN_TILES,
          max_retries: 3,
          max_bytes: 64 * 1024 * 1024,
          max_deferred_follows: 8,
          retry_base_delay_ms: 1000,
        },
        a.host,
      );
      a.controller.signal.throwIfAborted();
      if (current !== a) return;
      a.output = output;
      a.diagnostics.finish(
        a.output.missing.length === 0 ? "completed" : "partial-completed",
        a.output,
      );
      const entry = toHistoryEntry(url, {
        width: a.output.canvas?.width ?? 0,
        height: a.output.canvas?.height ?? 0,
        format: a.output.disposition === "display-only" ? "display" : "png",
        at: a.activity.state.now,
      });
      if (entry && options.history) {
        history = pushHistory(history, entry);
        saveHistory(options.history.store, options.history.key, history);
        a.view.history = [...history];
      }
      options.onComplete?.(a.output);
    } catch (error) {
      if (current !== a) return;
      outcome = a.controller.signal.aborted ? "cancelled" : "failed";
      if (outcome === "failed") {
        a.failure = await withVerdict(
          isJobError(error) ? error : { kind: "internal", detail: String(error).slice(0, 2048) },
        );
        a.view.desktopHandoffUrl = desktopHandoffLink(url);
      }
      a.diagnostics.finish(outcome, error);
    } finally {
      a.activity.stopHeartbeat();
      if (!a.output) a.controller.abort();
      await a.host?.settle();
      if (current === a) {
        a.done = true;
        update();
        const next = finishActiveQueueEntry(queue, outcome);
        queue = next.queue;
        if (next.next) void run(next.next.url);
      }
    }
  }

  /** Stamp the boundary's retry verdict (`isRetryable`, the one policy in
   * Rust) onto an error as a plain `retryable` hint for the shared UI. An
   * error that cannot reach the boundary keeps no hint and so fails closed. */
  async function withVerdict(error: JobError): Promise<JobError> {
    try {
      (error as { retryable?: boolean }).retryable = (await options.wasm()).isRetryable(error);
    } catch {
      // No verdict: the hint stays absent and retry fails closed.
    }
    return error;
  }

  /** `withVerdict` across every retained failure of a partial decision. */
  async function withVerdictMissing(missing: MissingTiles): Promise<MissingTiles> {
    await Promise.all(
      missing.missing.flatMap((tile) => tile.failures.map((failure) => withVerdict(failure))),
    );
    return missing;
  }

  function submit(url: string): void {
    url = url.trim();
    if (!isValidInputUrl(url)) {
      initialUrl = url;
      const error: JobError = { kind: "invalid-url" };
      idle = presentFailure(error);
      if (!current || current.done) {
        retire();
        const a = invocation(url);
        a.done = true;
        a.failure = error;
        a.view.initialUrl = url;
        a.diagnostics.finish("validation-failed", error);
        current = a;
      }
      update();
      return;
    }
    const queued = enqueueSequential(queue, (id, status) => ({ id, status, url }));
    queue = queued.queue;
    if (queued.entry.status === "active") void run(url);
    else update();
  }

  function update(): void {
    const a = current,
      shown = presentation();
    a?.diagnostics.context({
      presented_phase: shown.phase,
      presented_error: shown.error?.kind ?? "",
    });
    const report = a?.diagnostics.report();
    if (a)
      a.view.currentProgress =
        shown.phase === "job"
          ? {
              active: Math.min(
                a.activity.state.pendingRequests ?? report?.counters.requests_pending ?? 0,
                Math.max(0, (a.progress?.total ?? 0) - (a.progress?.completed ?? 0)),
              ),
            }
          : undefined;
    const callbacks = {
      onSubmitUrl: submit,
      onCancel: cancel,
      ...(options.resetToIdle ? { onReset: cancel } : {}),
      onRetrySameUrl: () => {
        if (a && current === a) void run(a.url);
      },
      onTryMaximum: () => {
        if (a && current === a) void run(a.url, true);
      },
      onPause: () => {
        if (a && current === a) {
          a.host?.pause();
          a.activity.pause();
          update();
        }
      },
      onResume: () => {
        if (a && current === a) {
          a.host?.resume();
          a.activity.resume();
          update();
        }
      },
      onSave: a?.capabilities?.saveOutput,
      onOpenOutput: a?.output && a.capabilities?.openOutput ? a.capabilities.openOutput : undefined,
      onRevealOutput:
        a?.output && a.capabilities?.revealOutput ? a.capabilities.revealOutput : undefined,
      onOpenSource: options.openSource,
      onCopyDiagnostics: copyDiagnosticText,
      onSaveDiagnostics: saveDiagnosticReport,
      onOpenExternalLink: (url: string) => {
        location.href = url;
      },
      onClearHistory: () => {
        history = [];
        if (options.history) clearHistory(options.history.store, options.history.key);
        if (a) a.view.history = [];
        update();
      },
    };
    renderView(
      options.root,
      shown,
      callbacks,
      a ? { ...a.view, diagnosticReport: report } : { history, initialUrl },
      {
        ...(a?.permission
          ? {
              replace: createElement(AccessRequestView, {
                origin: a.permission.origin,
                requesting: a.permission.requesting,
                onRequest: a.permission.request,
              }),
            }
          : {}),
        ...(a?.decision && !a.permission
          ? {
              after: createElement(PartialDecisionActions, {
                decision: a.decision.missing,
                onAnswer: a.decision.answer,
              }),
            }
          : {}),
      },
    );
    options.onStatus?.(shown, a?.url ?? "");
  }
  update();
  return {
    submit,
    run,
    cancel,
    update,
    presentation,
    dispose: retire,
    active: () => current !== undefined && !current.done && !current.controller.signal.aborted,
    currentUrl: () => current?.url,
  };
}
