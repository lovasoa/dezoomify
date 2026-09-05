// Shared UI controller: explicit reducer, stale-seq guard, structured errors.

const TRANSITIONS = {
  idle: { "start-discovery": "discovering" },
  discovering: {
    "images-found": "choosing-image",
    fail: "failed",
    cancel: "cancelled",
  },
  "choosing-image": {
    "image-chosen": "choosing-level",
    fail: "failed",
    cancel: "cancelled",
  },
  "choosing-level": {
    "level-chosen": "preflighting",
    fail: "failed",
    cancel: "cancelled",
  },
  preflighting: {
    "preflight-ok": "downloading",
    "preflight-display-only": "display-only",
    fail: "failed",
    cancel: "cancelled",
  },
  downloading: {
    progress: "downloading",
    "save-start": "saving",
    "preflight-display-only": "display-only",
    fail: "failed",
    cancel: "cancelled",
  },
  "display-only": { cancel: "cancelled", fail: "failed", reset: "idle" },
  saving: { "save-done": "completed", fail: "failed", cancel: "cancelled" },
  completed: { reset: "idle" },
  cancelled: { reset: "idle" },
  failed: { reset: "idle", "start-discovery": "discovering" },
};

export function createController(sessionId) {
  let state = {
    status: "idle",
    seq: 0,
    sessionId,
    imageCount: 0,
    transport: null,
  };

  function dispatch(ev) {
    if (ev.sessionId !== state.sessionId) return false;
    if (ev.seq <= state.seq) return false;
    const next = TRANSITIONS[state.status]?.[ev.kind];
    if (next === undefined) return false;
    state = {
      ...state,
      status: next,
      seq: ev.seq,
      imageCount: ev.imageCount ?? state.imageCount,
      transport: ev.transport ?? state.transport,
      error: ev.kind === "fail" ? ev.error : undefined,
    };
    return true;
  }

  function reset(newSessionId) {
    state = {
      status: "idle",
      seq: 0,
      sessionId: newSessionId ?? state.sessionId,
      imageCount: 0,
      transport: null,
    };
  }

  function getState() {
    return { ...state };
  }

  return { getState, dispatch, reset };
}

export function renderAppChoice(cap = {}) {
  const lines = [];
  lines.push("Best next step:");
  if (cap.nativeAvailable) {
    lines.push(
      "For very large pictures, use the desktop app on your computer. It can handle bigger files.",
    );
  } else if (cap.extensionAvailable) {
    lines.push(
      "You can also try the browser add-on. It can open pictures that need you to be signed in.",
    );
  } else if (cap.browserCanSave === false) {
    lines.push(
      "This preview can only be viewed here. To keep a copy, try the desktop app on your computer.",
    );
  } else {
    lines.push("You can continue in this browser. No extra steps are needed.");
  }
  lines.push("What each choice can do:");
  lines.push("- This browser works for most public pictures you can already see.");
  if (cap.extensionAvailable) {
    lines.push("- The browser add-on helps when a picture needs you to be signed in.");
  } else {
    lines.push("- The browser add-on is not connected right now.");
  }
  if (cap.nativeAvailable) {
    lines.push("- The desktop app is ready and handles the largest pictures.");
  } else {
    lines.push("- The desktop app is not connected right now.");
  }
  return lines.join("\n");
}
