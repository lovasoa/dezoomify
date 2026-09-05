// Desktop entry: render the shared UI through the desktop integration.
// Routing and component composition stay shared; this file only wires the
// desktop host.
import { createController } from "../../../packages/shared-ui/src/controller.ts";
import { renderView } from "../../../packages/shared-ui/src/view.ts";
import { createDesktopIntegration } from "./desktopIntegration.ts";

const root = typeof document !== "undefined" ? document.getElementById("root") : null;
const integration = createDesktopIntegration();
const controller = createController("sess:desktop-1");

function update() {
  if (!root) return;
  const state = controller.getState();
  const caps = integration.getCapabilities();

  renderView(
    root,
    state,
    {
      onSubmitUrl(url) {
        controller.dispatch({
          seq: 1,
          sessionId: "sess:desktop-1",
          kind: "start-discovery",
        });
        update();
      },
      onCancel() {
        controller.dispatch({
          seq: 2,
          sessionId: "sess:desktop-1",
          kind: "cancel",
        });
        update();
      },
      onReset() {
        controller.reset("sess:desktop-1");
        update();
      },
      onSave() {},
    },
    {
      capabilities: {
        nativeAvailable: caps.nativeAvailable,
        extensionAvailable: caps.extensionAvailable,
        browserCanSave: caps.browserCanSave,
        proxyAllowed: caps.proxyAllowed,
      },
    },
  );
}

if (root !== null) {
  update();
}

export { controller, integration, update };
