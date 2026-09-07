// Live job activity (todo 2.2 home, moved from `src/main.ts`).
//
// Drives the progressive-disclosure job view: pending-request clocks, the
// longest-wait gauge, the capped technical log, and the delta-gated 500 ms
// heartbeat whose paints are rAF-batched. The owning orchestrator supplies
// the state object shape (shared-ui ViewContext jobActivity) through the
// returned tracker's `state` reference and a repaint callback; this module
// never imports view code. Timers and the frame scheduler are injectable so
// node tests run deterministically. Keep erasable-syntax-only.
export interface ActivityLog {
  url?: string;
  startedAt?: number;
  now?: number;
  stepLabel?: string;
  detail?: string;
  pendingRequests?: number;
  completedRequests?: number;
  failedRequests?: number;
  longestPendingMs?: number;
  timeoutMs?: number;
  lastProgressAt?: number;
  log?: Array<string>;
}

export interface ActivityHooks {
  onUpdate(): void;
  requestFrame?(cb: () => void): void;
  setIntervalFn?(cb: () => void, ms: number): unknown;
  clearIntervalFn?(t: unknown): void;
  nowFn?(): number;
}

export interface JobActivity {
  readonly state: ActivityLog;
  scheduleUpdate(): void;
  reset(url: string, timeoutMs: number): void;
  touchProgress(): void;
  setStep(label: string, detail?: string): void;
  pushLog(line: string, maxLines?: number): void;
  noteRequestStart(label: string): number;
  noteRequestEnd(id: number, ok: boolean): void;
  refreshLongestPending(): void;
  reportHeartbeat(now?: number): boolean;
  startHeartbeat(): void;
  stopHeartbeat(): void;
}

/** Capped technical log (oldest dropped first), web parity. */
export const ACTIVITY_MAX_LOG_LINES = 60;

export function createJobActivity(hooks: ActivityHooks): JobActivity {
  const now = hooks.nowFn ?? Date.now;
  const frame =
    hooks.requestFrame ??
    ((cb: () => void) => {
      try {
        if (typeof requestAnimationFrame !== "function") throw new Error("no-rAF");
        requestAnimationFrame(cb);
      } catch {
        setTimeout(cb, 0);
      }
    });
  const every =
    hooks.setIntervalFn ?? ((cb: () => void, ms: number) => setInterval(cb, ms));
  const clearEvery =
    hooks.clearIntervalFn ?? ((t: unknown) => clearTimeout(t as ReturnType<typeof setInterval>));

  const state: ActivityLog = {};
  let requestSeq = 0;
  const pendingStarts = new Map<number, { startedAt: number; label: string }>();
  let completedRequests = 0;
  let failedRequests = 0;
  let heartbeatTimer: unknown = null;
  let batchedUpdateQueued = false;
  let lastHeartbeatKey = "";

  function ensure(): ActivityLog {
    if (!state.timeoutMs) state.timeoutMs = 30000;
    return state;
  }

  /**
   * Coalesce burst progress into one paint per frame: tile completions call
   * this instead of update(), so N tiles finishing in the same frame render
   * once. Falls back to a zero-delay timer where rAF is unavailable (e.g.
   * node test imports).
   */
  function scheduleBatchedUpdate(): void {
    if (batchedUpdateQueued) return;
    batchedUpdateQueued = true;
    frame(() => {
      batchedUpdateQueued = false;
      hooks.onUpdate();
    });
  }

  /** Delta key for the heartbeat: only a real change schedules a paint. */
  function heartbeatKey(at?: number): string {
    const longest = typeof state.longestPendingMs === "number" ? Math.floor(state.longestPendingMs / 250) : 0;
    return `${pendingStarts.size}:${completedRequests}:${failedRequests}:${longest}:${Math.floor((at ?? now()) / 1000)}`;
  }

  function reset(url: string, timeoutMs: number): void {
    pendingStarts.clear();
    completedRequests = 0;
    failedRequests = 0;
    const at = now();
    state.url = url;
    state.startedAt = at;
    state.now = at;
    state.stepLabel = "Finding the zoomable image…";
    state.detail = undefined;
    state.pendingRequests = 0;
    state.completedRequests = 0;
    state.failedRequests = 0;
    state.longestPendingMs = 0;
    state.timeoutMs = timeoutMs;
    state.lastProgressAt = at;
    state.log = [];
  }

  function touchProgress(): void {
    ensure().lastProgressAt = now();
  }

  function setStep(label: string, detail?: string): void {
    const a = ensure();
    a.stepLabel = label;
    if (detail !== undefined) a.detail = detail;
    touchProgress();
    hooks.onUpdate();
  }

  function pushLog(line: string, maxLines: number = ACTIVITY_MAX_LOG_LINES): void {
    const a = ensure();
    if (!a.log) a.log = [];
    const elapsed = a.startedAt ? Math.round((now() - a.startedAt) / 1000) : 0;
    a.log.push(`${elapsed}s: ${line}`);
    if (a.log.length > maxLines) a.log.splice(0, a.log.length - maxLines);
  }

  function noteRequestStart(label: string): number {
    const id = ++requestSeq;
    pendingStarts.set(id, { startedAt: now(), label });
    const a = ensure();
    a.pendingRequests = pendingStarts.size;
    refreshLongestPending();
    return id;
  }

  function noteRequestEnd(id: number, ok: boolean): void {
    pendingStarts.delete(id);
    if (ok) completedRequests += 1;
    else failedRequests += 1;
    const a = ensure();
    a.pendingRequests = pendingStarts.size;
    a.completedRequests = completedRequests;
    a.failedRequests = failedRequests;
    refreshLongestPending();
    touchProgress();
  }

  function refreshLongestPending(): void {
    const a = ensure();
    const at = now();
    a.now = at;
    let longest = 0;
    for (const { startedAt } of pendingStarts.values()) {
      longest = Math.max(longest, at - startedAt);
    }
    a.longestPendingMs = longest;
  }

  /** Advance the heartbeat once; true when the view changed and repainted. */
  function reportHeartbeat(at?: number): boolean {
    refreshLongestPending();
    const key = heartbeatKey(at);
    if (key === lastHeartbeatKey) return false;
    lastHeartbeatKey = key;
    scheduleBatchedUpdate();
    return true;
  }

  function startHeartbeat(): void {
    stopHeartbeat();
    lastHeartbeatKey = heartbeatKey();
    // 500 ms cadence refreshes the data, but the paint is delta-gated and
    // rAF-batched: idle ticks with no change render nothing.
    heartbeatTimer = every(() => {
      reportHeartbeat();
    }, 500);
    const t = heartbeatTimer as unknown as { unref?: () => void };
    if (t && typeof t.unref === "function") {
      try {
        t.unref();
      } catch {
        // browser timers lack unref
      }
    }
  }

  function stopHeartbeat(): void {
    if (heartbeatTimer) {
      try {
        clearEvery(heartbeatTimer);
      } catch {
        // Ignore timer errors.
      }
      heartbeatTimer = null;
    }
  }

  return {
    state,
    scheduleUpdate: scheduleBatchedUpdate,
    reset,
    touchProgress,
    setStep,
    pushLog,
    noteRequestStart,
    noteRequestEnd,
    refreshLongestPending,
    reportHeartbeat,
    startHeartbeat,
    stopHeartbeat,
  };
}
