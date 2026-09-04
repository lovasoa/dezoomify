// Desktop entry: render the shared UI through the desktop integration.
// Routing and component composition stay shared; this file only wires the
// desktop host.
import { createController } from "../../../packages/shared-ui/src/controller.ts";
import { createDesktopIntegration } from "./desktopIntegration.ts";

const root = typeof document !== "undefined" ? document.getElementById("root") : null;
const integration = createDesktopIntegration();
const controller = createController("sess:desktop-1");

if (root !== null) {
  const state = controller.getState();
  root.textContent = `Dezoomify desktop (${integration.describe()}) status=${state.status}`;
}

export { controller, integration };
