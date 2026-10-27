import "../../../../test/tsx-loader.mjs";
import { act, click, makeContainer, onCleanup } from "../../../../test/react-dom.mjs";

// Enable React's controlled-input event detection before react-dom loads.
document.oninput = null;
const { createDesktopApplication } = await import("../../src/application.ts");

export const output = {
  canvas: { width: 512, height: 512 },
  format: "png",
  disposition: "native-publication",
};
export const progress = { phase: "acquisition", completed: 3, total: 4 };
export const flush = () => act(async () => {});

export function typeInto(element, value) {
  act(() => {
    Object.defineProperty(element, "value", { configurable: true, writable: true, value });
    element.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
}

/** Fresh storage, native jobs, and application state; teardown also runs on assertion failure. */
export function mountDesktop({ languages = ["en"] } = {}) {
  const invocations = [],
    historyStore = new Map(),
    root = makeContainer();
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { languages, language: languages[0], userAgent: "test" },
  });
  globalThis.localStorage = {
    getItem: (key) => historyStore.get(key) ?? null,
    setItem: (key, value) => historyStore.set(key, value),
    removeItem: (key) => historyStore.delete(key),
  };
  const native = {
    async invokeNative(request, callbacks) {
      const finished = Promise.withResolvers(),
        answers = [];
      function answer(fields) {
        const pending = Promise.withResolvers();
        answers.push({ ...fields, ...pending });
        return pending.promise;
      }
      const invocation = {
        request,
        callbacks,
        answers,
        id: `job:test-${invocations.length}`,
        finished: finished.promise,
        resolve: (output, saved_output) => finished.resolve({ output, saved_output }),
        reject: finished.reject,
        async pause() {},
        async resume() {},
        async cancel() {},
        async dispose() {
          finished.resolve({ output });
        },
        async openOutput() {},
        answer: (question, choice) => answer({ question, choice }),
        answerImage: (question, index) => answer({ question, index }),
      };
      invocations.push(invocation);
      callbacks.progress(progress);
      return invocation;
    },
  };
  let app;
  act(() => {
    app = createDesktopApplication(root, {
      invokeNative: (...args) => native.invokeNative(...args),
      inspectSavedOutput: async (saved) =>
        (await native.inspectSavedOutput?.(saved)) ?? "available",
      openHistoryOutput: async (saved) => {
        await native.openHistoryOutput?.(saved);
      },
      forgetSavedOutput: async () => {},
      openExternalLink: async () => {},
      readNativeDiagnostics: async () => {
        throw new Error("No native report");
      },
      validateSettings: async (settings) => {
        await native.validateSettings?.(settings);
      },
    });
  });
  onCleanup(() => app.dispose());

  async function start() {
    await act(async () => {
      root.querySelector("#dz-url-input").value = "https://museum.test/image";
      root
        .querySelector("form")
        .dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    });
    return invocations.at(-1);
  }
  async function reset() {
    if (!root.querySelector(".dz-error-section")) {
      await act(async () => invocations.at(-1)?.resolve(output));
    }
    click(
      root.querySelector(
        "#dz-btn-start-over, #dz-btn-another, #dz-btn-reset, .dz-error-section .dz-actions-row button:last-child",
      ),
    );
    await flush();
  }
  return { app, root, native, invocations, historyStore, start, reset };
}
