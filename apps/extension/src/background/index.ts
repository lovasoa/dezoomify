/**
 * Extension background production wiring.
 *
 * All coordinator state lives in `coordinator.ts` behind
 * `createBackgroundCoordinator`, so tests instantiate isolated coordinators
 * instead of re-importing this module. This file only binds the singleton to
 * the real browser globals for the service worker / classic script.
 */

import { createBackgroundCoordinator } from "./coordinator.ts";
import type { BrowserApi } from "./coordinator.ts";

export { BACKGROUND_LOG_MAX_CHARS } from "./coordinator.ts";

const globals = globalThis as typeof globalThis & { browser?: BrowserApi; chrome?: BrowserApi };

const coordinator = createBackgroundCoordinator({ browserApi: globals.browser ?? globals.chrome });

export const setBackgroundLogLevel = coordinator.setBackgroundLogLevel;
export const setBackgroundLogSink = coordinator.setBackgroundLogSink;
export const backgroundLog = coordinator.backgroundLog;
export const startBackground = coordinator.startBackground;
