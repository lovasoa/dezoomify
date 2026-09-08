// Hermetic production-frontend integration test. Linkedom supplies only the
// browser DOM boundary: main.ts mounts itself and this test uses rendered DOM
// events plus the same Tauri callback bridge as the real window.
import test from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";

function eventually(predicate, message) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const poll = () => {
      try {
        if (predicate()) return resolve();
        if (++attempts >= 100) return reject(new Error(message));
        setTimeout(poll, 10);
      } catch (error) { reject(error); }
    };
    poll();
  });
}

function click(window, element, message) {
  assert.ok(element, message);
  element.dispatchEvent(new window.Event("click", { bubbles: true, cancelable: true }));
}

function buttonWithText(document, text) {
  return [...document.querySelectorAll("button")].find((button) => button.textContent?.includes(text));
}

await test("desktop production entry mounts and drives rendered controls", async () => {
  const { window, document } = parseHTML(`<!doctype html><html><body>
    <div id="root" class="dz-main"></div><footer class="dz-site-footer"></footer>
  </body></html>`);
  const savedGlobals = new Map();
  for (const name of [
    "window", "document", "HTMLElement", "HTMLButtonElement", "HTMLInputElement",
    "HTMLAnchorElement", "Node", "Event", "MouseEvent", "KeyboardEvent",
  ]) {
    savedGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true,
      value: name === "window" ? window : name === "document" ? document : window[name] });
  }

  const calls = [];
  const callbacks = new Map();
  const listeners = new Map();
  let callbackId = 0;
  const internals = {
    transformCallback(callback) { const id = ++callbackId; callbacks.set(id, callback); return id; },
    unregisterCallback(id) { callbacks.delete(id); },
    invoke: async (command, args) => {
      calls.push({ command, args });
      if (command === "plugin:event|listen") { listeners.set(args.event, args.handler); return listeners.size; }
      if (command === "query_capabilities") return {
        protocol_min: "1.0", protocol_max: "1.0",
        commands: ["start_job", "cancel_job", "answer_choice", "request_destination",
          "open_saved_output", "query_capabilities"],
      };
      if (command === "start_job") return { job: "job:frontend", seq: 1 };
      if (command === "request_destination") return { outcome: "granted", destination_id: "dst:test" };
      if (command === "cancel_job") return { job: args.job, seq: 9 };
      if (command === "answer_choice") return { job: args.job, seq: 8 };
      throw new Error(`unexpected command: ${command}`);
    },
  };
  window.__TAURI_INTERNALS__ = internals;
  globalThis.__TAURI_INTERNALS__ = internals;
  const emit = (channel, payload) => {
    const id = listeners.get(channel);
    assert.ok(id, `production entry subscribed to ${channel}`);
    const callback = callbacks.get(id);
    assert.ok(callback, `Tauri callback exists for ${channel}`);
    callback({ payload });
  };

  try {
    const app = await import(`../src/main.ts?mounted-e2e=${Date.now()}`);
    await eventually(() => listeners.has("dezoomify://job-state"), "event subscriptions were not registered");

    const input = document.querySelector("#dz-url-input");
    assert.ok(input, "idle view renders the URL input");
    input.value = "https://fixtures.test/image.dzi";
    input.closest("form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    await eventually(() => app.getCurrentJobId() === "job:frontend", "rendered submit did not start a job");
    assert.equal(calls.find((call) => call.command === "start_job").args.inputUrl,
      "https://fixtures.test/image.dzi");
    assert.equal(document.querySelector(".dz-card")?.dataset.viewPhase, "job");

    emit("dezoomify://job-state", { job: "job:frontend", seq: 2,
      kind: "recovery-requested", reason: "destination", recovery: "rec:1", attempt: "att:1" });
    click(window, buttonWithText(document, "Choose output"),
      "destination recovery renders its action");
    await eventually(() => calls.some((call) => call.command === "request_destination"),
      "rendered recovery action did not request a destination");
    await eventually(() => app.controller.getState().status === "saving",
      "destination grant was not applied");

    click(window, document.querySelector("#dz-btn-cancel"), "job view renders Cancel");
    await eventually(() => calls.some((call) => call.command === "cancel_job"),
      "rendered Cancel did not invoke cancel_job");
    await eventually(() => app.controller.getState().status === "cancelled",
      "cancel acknowledgement was not applied");
    assert.equal(document.querySelector(".dz-card")?.dataset.viewPhase, "cancelled");

    click(window, document.querySelector("#dz-btn-reset"), "cancelled view renders reset");
    assert.equal(document.querySelector(".dz-card")?.dataset.viewPhase, "idle");
    const startsBeforeHandoff = calls.filter((call) => call.command === "start_job").length;
    emit("dezoomify://deep-link-pending", {
      source_url: "https://fixtures.test/handoff.dzi", version: 1, hint: null,
    });
    assert.ok(document.querySelector(".dz-modal-backdrop"), "pending handoff renders confirmation");
    assert.equal(calls.filter((call) => call.command === "start_job").length, startsBeforeHandoff,
      "pending handoff performs no start effect");
    click(window, buttonWithText(document, "Open image"), "handoff dialog renders confirmation");
    await eventually(() => calls.filter((call) => call.command === "start_job").length === startsBeforeHandoff + 1,
      "confirmed rendered handoff did not start a job");
  } finally {
    delete globalThis.__TAURI_INTERNALS__;
    for (const [name, descriptor] of savedGlobals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
});
