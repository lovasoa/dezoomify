import {
  AccessRequestView,
  createHistory,
  type DiagnosticRecorder,
  type HistoryEntry,
  type HistoryStore,
  isValidInputUrl,
  type Presentation,
  presentFailure,
  presentIdle,
  presentOutput,
  presentProgress,
  presentStatus,
  RetryApproval,
  RetryDecisionActions,
  renderView,
  type ViewContext,
} from "@dezoomify/shared-ui";
import type {
  ErrorTransport,
  Error as JobError,
  JobInput,
  Output,
  Progress,
  RetryChoice,
  TileAcquisition,
} from "@dezoomify/wasm-bindings";
import { createElement } from "react";
import { isJobError, unknownDetail } from "../../shared-ui/src/failure.ts";
import type { BrowserSaveDisposition } from "./assembly.ts";
import { createBrowserAssembly } from "./browser-assembly.ts";
import { BrowserHost, type BrowserHostDependencies } from "./browser-host.ts";
import {
  copyDiagnosticText,
  createAttemptDiagnostics,
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
  history?: { store: HistoryStore; key: string };
  resetToIdle?: boolean;
  onStart?(url: string): void;
  onReset?(): void;
  onStatus?(presentation: Presentation, url: string): void;
  onComplete?(output: Output): void;
  openSource?(): void;
}

/** Website and extension share the entire invocation, interaction, and presentation flow. */
export function createBrowserApplication(options: BrowserApplicationOptions) {
  const history = createHistory(options.history?.store, options.history?.key ?? "", Date.now);
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
        | { request: TileAcquisition; answer(choice: RetryChoice): void }
        | undefined,
      permission: undefined as PermissionWait | undefined,
      done: false,
      historyEntry: null as HistoryEntry | null,
      view: {
        sourceUrl: url,
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
      view.decision = a.decision.request;
      view.headlineKey = "view.retry.title";
    }
    return view;
  }

  function retire(): Promise<void> {
    const a = current;
    if (!a) return retiring;
    if (!a.done && !a.output && !a.failure) history.update(a.historyEntry, { status: "cancelled" });
    current = undefined;
    a.controller.abort();
    a.activity.stopHeartbeat();
    retiring = Promise.all([retiring, a.host?.settle()]).then(() => {});
    a.capabilities?.dispose?.();
    a.diagnostics.finish("retired");
    return retiring;
  }

  function cancel(): void {
    if (options.resetToIdle) {
      retire();
      idle = presentIdle();
      initialUrl = undefined;
      options.onReset?.();
    } else if (current) {
      history.update(current.historyEntry, { status: "cancelled" });
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
    a.historyEntry = options.history ? history.start(url) : null;
    options.onStart?.(url);
    a.activity.startHeartbeat();
    update();
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
            update();
          }
        },
      });
      const approval = new RetryApproval((request) => {
        a.host?.waitForRetry(request !== undefined);
        a.decision = request
          ? {
              request,
              answer(choice) {
                if (current !== a || a.controller.signal.aborted) return;
                a.diagnostics.record("info", "retry-answer", { choice });
                if (choice === "retry") approval.retry();
                else cancel();
              },
            }
          : undefined;
        update();
      });
      a.controller.signal.addEventListener("abort", () => approval.cancel(), { once: true });
      a.host = new BrowserHost({
        signal: a.controller.signal,
        diagnostics: a.diagnostics,
        assembly,
        decoder,
        fetchResource: capabilities.fetchResource,
        loadDisplayImage: capabilities.loadDisplayImage,
        onProgress: (progress) => {
          if (current === a && !a.controller.signal.aborted) {
            a.progress = progress;
            history.progress(a.historyEntry, progress);
            a.activity.touchProgress();
            a.activity.scheduleUpdate();
          }
        },
        transport: () => capabilities.transport(),
        approveRetry: (request) => approval.acquire(request),
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
          interactive_retries: true,
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
      a.diagnostics.finish("completed", a.output);
      history.complete(a.historyEntry, a.output);
      options.onComplete?.(a.output);
    } catch (error) {
      if (current !== a) return;
      const outcome = a.controller.signal.aborted ? "cancelled" : "failed";
      history.update(a.historyEntry, { status: outcome });
      if (outcome === "failed") {
        a.failure = await withVerdict(
          isJobError(error) ? error : { kind: "internal", detail: unknownDetail(error) },
        );
      }
      a.diagnostics.finish(outcome, error);
    } finally {
      a.activity.stopHeartbeat();
      if (!a.output) a.controller.abort();
      await a.host?.settle();
      if (current === a) {
        a.done = true;
        update();
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
    void run(url);
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
        history.clear();
        update();
      },
      onRemoveHistory: (entry: HistoryEntry) => {
        history.remove(entry);
        update();
      },
    };
    renderView(
      options.root,
      shown,
      callbacks,
      {
        ...(a ? { ...a.view, diagnosticReport: report } : { initialUrl }),
        history: history.entries(),
        historyNow: Date.now(),
      },
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
              after: createElement(RetryDecisionActions, {
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
