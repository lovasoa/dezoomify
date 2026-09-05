// Web application entry point (browser ES module)
import { createController } from "../../../packages/shared-ui/src/controller.js";
import { renderView } from "../../../packages/shared-ui/src/view.js";

let sessionId = `sess:web-${Date.now()}`;
const controller = createController(sessionId);
let currentSeq = 0;

function nextEvent(kind, extra = {}) {
  currentSeq++;
  return { seq: currentSeq, sessionId, kind, ...extra };
}

const appContainer = typeof document !== "undefined" ? document.getElementById("app") : null;

let viewCtx = {
  capabilities: {
    extensionAvailable: false,
    nativeAvailable: false,
    browserCanSave: true,
  },
  originClean: true,
};

export function update() {
  if (!appContainer) return;
  const state = controller.getState();
  renderView(
    appContainer,
    state,
    {
      onSubmitUrl(url) {
        controller.dispatch(nextEvent("start-discovery", { transport: "direct" }));
        update();

        // Simulate discovery progression for testing/demo
        setTimeout(() => {
          controller.dispatch(nextEvent("images-found", { imageCount: 1, transport: "direct" }));
          controller.dispatch(nextEvent("image-chosen"));
          controller.dispatch(nextEvent("level-chosen"));
          controller.dispatch(nextEvent("preflight-ok", { transport: "direct" }));
          viewCtx.currentProgress = { current: 14, total: 28, message: "Downloading tiles: 14 of 28" };
          update();
        }, 500);
      },
      onCancel() {
        controller.dispatch(nextEvent("cancel"));
        update();
      },
      onReset() {
        sessionId = `sess:web-${Date.now()}`;
        controller.reset(sessionId);
        currentSeq = 0;
        viewCtx.currentProgress = undefined;
        viewCtx.completedInfo = undefined;
        update();
      },
      onSave() {
        alert("Image ready to save! In full runtime, this initiates downloading the final image file.");
      },
    },
    viewCtx,
  );
}

if (appContainer) {
  update();
}

export { controller };
