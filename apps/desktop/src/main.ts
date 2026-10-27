// Desktop entrypoint; application state and resources belong to this mount.
import { createDesktopApplication } from "./application.ts";

const root = typeof document === "undefined" ? null : document.getElementById("root");
const application = root ? createDesktopApplication(root) : null;

export function getCurrentJobId(): string | null {
  return application?.getCurrentJobId() ?? null;
}

export function update(): void {
  application?.update();
}
